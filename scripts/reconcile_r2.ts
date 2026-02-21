/**
 * One-off repair script: reconcile DB "images" rows against Cloudflare R2.
 *
 * Problem:
 * - I deleted objects directly in R2.
 * - DB rows still exist and point to missing objects.
 *
 * Solution:
 * - For each DB image row, derive the underlying R2 object key (if possible),
 *   then HEAD it in R2:
 *   - if missing -> delete DB row (cascades image_tags + tag_jobs)
 *   - if present -> keep
 *
 * Safety properties:
 * - Default mode is DRY RUN (no deletes).
 * - Use "--apply" to actually delete.
 * - We skip rows that we cannot confidently map to an R2 key (e.g. local seed images).
 */

import { db } from "~/server/db";
import { images } from "~/server/db/schema";
import { headObjectExists } from "~/server/storage/s3";
import { sql, type SQL } from "drizzle-orm";

/**
 * Derive R2 object key from images.storageKey.
 *
 * storageKey can be:
 * 1) raw object key: "images/reddit-scrape/<sha>.jpg"
 * 2) public URL:    `${S3_PUBLIC_BASE_URL}/${objectKey}`
 * 3) local seed path or other non-R2 value (e.g. "/seed/foo.png") -> we must NOT delete these
 *
 * We only return a key if we are confident it's an R2 object key.
 */
function deriveObjectKeyFromStorageKey(storageKey: string): string | null {
  // CHANGE: if a URL sneaks in, treat as unmappable (safe default).
  if (storageKey.startsWith("http://") || storageKey.startsWith("https://")) {
    return null;
  }

  // Local/absolute paths are not R2 keys.
  if (storageKey.startsWith("/")) {
    return null;
  }

  // Conservative “looks like an object key” heuristic:
  // - contains a slash (we store under prefixes like "images/...").
  // - no whitespace
  // - not starting with "." (avoid relative filesystem-y values)
  if (
    !storageKey.includes("/") ||
    /\s/.test(storageKey) ||
    storageKey.startsWith(".")
  ) {
    return null;
  }

  // Optional extra strictness (recommended):
  // Only reconcile keys under the prefixes we actually use.
  // This prevents deleting anything that isn't in our managed namespaces.
  if (
    !storageKey.startsWith("images/reddit-scrape/") &&
    !storageKey.startsWith("images/pinterest-scrape/")
  ) {
    return null;
  }

  // Only operate on static images.
  if (
    !storageKey.endsWith(".jpg") &&
    !storageKey.endsWith(".png") &&
    !storageKey.endsWith(".webp")
  ) {
    return null;
  }
  return storageKey;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply"); // default: dry-run
  const batchArg = process.argv.find((a) => a.startsWith("--batch="));
  const batchSize = batchArg ? Number(batchArg.split("=")[1]) : 250;

  if (!Number.isFinite(batchSize) || batchSize <= 0 || batchSize > 2000) {
    throw new Error(`Invalid batch size: ${batchArg}`);
  }

  console.log("=== PepeFinder R2 reconcile ===");
  console.log(
    `mode=${apply ? "APPLY (delete DB rows)" : "DRY RUN (no actual deletes)"}`,
  );
  console.log(`batchSize=${batchSize}`);
  console.log(
    "Reconciling only these prefixes: images/pinterest-scrape/, images/reddit-scrape/",
  );

  let scanned = 0;
  let missing = 0;
  let deleted = 0;
  let skippedUnmappable = 0;
  let kept = 0;

  // Cursor-based pagination is stable and avoids OFFSET performance issues.

  let lastCreatedAt: Date | null = null;
  let lastId: number | null = null;

  while (true) {
    // Build a cursor condition in a type-safe way.
    let cursorCondition: SQL | undefined = undefined;

    if (lastCreatedAt !== null && lastId !== null) {
      // IMPORTANT: bind as string, not Date.
      // The postgres driver setup is failing when binding Date objects.
      const cursorCreatedAtIso: string = lastCreatedAt.toISOString();
      const cursorTs = sql.raw(`'${cursorCreatedAtIso}'::timestamptz`);

      cursorCondition = sql`
      (
        ${images.createdAt} > ${cursorTs}
        OR (
          ${images.createdAt} = ${cursorTs}
          AND ${images.id} > ${lastId}
        )
      )
      `;
    }

    const rows = await db
      .select({
        id: images.id,
        storageKey: images.storageKey,
        createdAt: images.createdAt,
      })
      .from(images)
      .where(cursorCondition ?? sql`TRUE`)
      .orderBy(images.createdAt, images.id)
      .limit(batchSize);

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned++;

      // Protects if Drizzle ever returns a string for createdAt.
      const rowCreatedAt =
        row.createdAt instanceof Date
          ? row.createdAt
          : new Date(row.createdAt as unknown as string);

      lastCreatedAt = rowCreatedAt;
      lastId = row.id;

      const key = deriveObjectKeyFromStorageKey(row.storageKey);

      // If we can't confidently map to an R2 key, skip (safe default).
      if (!key) {
        skippedUnmappable++;
        continue;
      }

      const exists = await headObjectExists({ key, requestTimeoutMs: 30_000 });

      if (!exists) {
        missing++;

        if (apply) {
          // Deleting the image row cascades:
          // - image_tags join rows
          // - tag_jobs row
          await db.delete(images).where(sql`${images.id} = ${row.id}`);
          deleted++;
        }
      } else {
        kept++;
      }

      if (scanned % 250 === 0) {
        console.log(
          `Progress: scanned=${scanned} kept=${kept} missing=${missing} deleted=${deleted} skipped=${skippedUnmappable}`,
        );
      }
    }
  }

  console.log("=== Done ===");
  console.log(`scanned=${scanned}`);
  console.log(`kept=${kept}`);
  console.log(`missing_objects=${missing}`);
  console.log(`deleted_rows=${deleted}`);
  console.log(`skipped_unmappable=${skippedUnmappable}`);

  if (!apply) {
    console.log(
      `DRY RUN complete. Re-run with "--apply" to delete ${missing} rows where R2 objects are missing.`,
    );
  }
}

main().catch((err) => {
  console.error("reconcile_r2 failed:", err);
  process.exit(1);
});
