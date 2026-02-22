/**
 * One-off repair script: reconcile DB "images" rows against Cloudflare R2.
 *
 * Problem:
 * - Objects were deleted directly in R2.
 * - DB rows still exist and point to missing objects.
 */

import { db } from "~/server/db";
import { images } from "~/server/db/schema";
import { headObjectStatus } from "~/server/storage/s3";
import { sql, type SQL } from "drizzle-orm";

// Derive R2 object key from images.storageKey.
function deriveObjectKeyFromStorageKey(storageKey: string): string | null {
  // If a URL sneaks in, treat as unmappable.
  if (storageKey.startsWith("http://") || storageKey.startsWith("https://")) {
    return null;
  }

  // Local/absolute paths are not R2 keys.
  if (storageKey.startsWith("/")) {
    return null;
  }

  // Conservative “does not look like an object key” check.
  if (
    !storageKey.includes("/") ||
    /\s/.test(storageKey) ||
    storageKey.startsWith(".")
  ) {
    return null;
  }

  // Only reconcile keys under the prefixes where the deletion happened.
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

  // Count uncertain checks (network/DNS/429/5xx/timeouts).
  // These must never cause deletion; they just mean "rerun later to converge"
  let unknown = 0;

  // Store a small sample of skipped rows for inspection.
  const skippedSamples: Array<{ id: number; storageKey: string }> = [];

  // Track which key is currently HEAD-checking.
  // Helps diagnose true stalls vs slow throughput.
  let currentKey: string | null = null;

  // Heartbeat log to distinguish "running slowly" vs "dead".
  const heartbeat: NodeJS.Timeout = setInterval(() => {
    console.log(
      `[HEARTBEAT] scanned=${scanned} kept=${kept} missing=${missing} deleted=${deleted} unknown=${unknown} skipped=${skippedUnmappable} currentKey=${currentKey ?? "-"}`,
    );
  }, 15_000);

  // Cursor-based pagination is stable and avoids offset performance issues.
  let lastCreatedAt: Date | null = null;
  let lastId: number | null = null;

  // DB-side prefix filter (reduces total scanning work).
  const prefixFilterSql = sql`
    (${images.storageKey} LIKE 'images/reddit-scrape/%'
      OR ${images.storageKey} LIKE 'images/pinterest-scrape/%')
  `;

  try {
    while (true) {
      // Build a cursor condition.
      let cursorCondition: SQL | undefined = undefined;

      if (lastCreatedAt !== null && lastId !== null) {
        // Important: bind as string, not Date.
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
        // Only scan rows with the prefixes we reconcile.
        .where(sql`${prefixFilterSql} AND (${cursorCondition ?? sql`TRUE`})`)
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

        // If can't confidently map to an R2 key, skip.
        if (!key) {
          skippedUnmappable++;

          // Capture up to 20 examples for debugging.
          if (skippedSamples.length < 20) {
            skippedSamples.push({
              id: row.id,
              storageKey: row.storageKey,
            });
          }

          continue;
        }

        /**
         * Low-call visibility.
         */

        const startedAtMs = Date.now();

        // Mark which key we are about to check.
        currentKey = key;

        // Tri-state result prevents accidental deletes on transient failures.
        const status = await headObjectStatus({
          key,
          requestTimeoutMs: 30_000,
        });

        // Clear currentKey after HEAD finishes.
        currentKey = null;

        const durationMs = Date.now() - startedAtMs;

        // Log unusually slow checks.
        if (durationMs > 5_000) {
          console.warn(
            `[SLOW HEAD] ms=${durationMs} id=${row.id} key=${key} status=${status}`,
          );
        }

        if (status === "missing") {
          missing++;

          if (apply) {
            // Deleting the image row cascades:
            // - image_tags join rows
            // - tag_jobs row
            await db.delete(images).where(sql`${images.id} = ${row.id}`);
            deleted++;
          }
        } else if (status === "exists") {
          kept++;
        } else {
          // Do not delete status === "unknown".
          unknown++;
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
    console.log(`unknown_checks=${unknown}`);
    console.log(`skipped_unmappable=${skippedUnmappable}`);
    if (skippedSamples.length > 0) {
      console.log("skipped_samples (first 20) =", skippedSamples);
    }

    if (!apply) {
      console.log(
        `DRY RUN complete. Re-run with "--apply" to delete ${missing} rows where R2 objects are missing.`,
      );
      console.log(
        `Note: ${unknown} checks were "unknown" due to network/timeout/429/5xx. Rerun later to converge.`,
      );
    }
  } finally {
    // Clear heartbeat so Node can exit cleanly.
    clearInterval(heartbeat);
  }
}

main().catch((err) => {
  console.error("reconcile_r2 failed:", err);
  process.exit(1);
});
