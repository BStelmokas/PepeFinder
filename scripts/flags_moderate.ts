/**
 * flags_moderate.ts
 *
 * Operator-only moderation script:
 * - Unlist or delete images that exceed a specified flag_count threshold.
 *
 * Why a script (not a product feature):
 * - Moderation is an operational workflow.
 * - Keeping it in scripts/ preserves MVP simplicity and avoids adding UI/admin routes.
 *
 * Safety invariants:
 * - The flag threshold MUST be >= 1 to prevent "oops, delete everything".
 * - Default mode is "unlist" (safer).
 * - Supports --dry-run to preview exactly what would happen.
 *
 * What “unlist” means in PepeFinder:
 * - We set images.status = "failed"
 * - Your search path only shows status="indexed"
 * - So the image disappears from search results, but remains reachable by /image/[id]
 *
 * What “delete” means:
 * - Delete DB rows for images + cascading joins/jobs.
 * - Best-effort delete of the underlying object from S3/R2 *only if*
 *   storageKey is an object key (not an http URL).
 *
 * Usage:
 *   pnpm flags:moderate -- --mode=unlist --min=5 --dry-run
 *   pnpm flags:moderate -- --mode=unlist --min=5
 *   pnpm flags:moderate -- --mode=delete --min=10 --dry-run
 *   pnpm flags:moderate -- --mode=delete --min=10
 */

import { db } from "~/server/db"; // Single DB instance (per your rules).
import { images } from "~/server/db/schema"; // Images table.
import { and, eq, gte, sql } from "drizzle-orm"; // Typed query builders.
import { deleteObject } from "~/server/storage/s3"; // Best-effort object deletion (server-only).

type Mode = "unlist" | "delete";

function parseArgs(argv: string[]) {
  /**
   * Minimal argv parsing with no deps (per your constraints).
   *
   * Supported flags:
   * - --mode=unlist|delete
   * - --min=<number>
   * - --dry-run
   */
  const out: { mode: Mode; min: number; dryRun: boolean } = {
    mode: "unlist",
    min: 1,
    dryRun: false,
  };

  for (const arg of argv) {
    // FIX: ignore the conventional flag terminator if it appears in argv.
    // This is what caused your "Unknown argument: --" crash.
    if (arg === "--") {
      continue;
    }

    if (arg.startsWith("--mode=")) {
      const v = arg.slice("--mode=".length);
      if (v !== "unlist" && v !== "delete") {
        throw new Error(`Invalid --mode=${v}. Must be "unlist" or "delete".`);
      }
      out.mode = v;
    } else if (arg.startsWith("--min=")) {
      const v = Number(arg.slice("--min=".length));
      if (!Number.isInteger(v)) {
        throw new Error(`Invalid --min value. Must be an integer.`);
      }
      out.min = v;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg.trim().length > 0) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  // Safety invariant from you: threshold must be >= 1.
  if (out.min < 1) {
    throw new Error(`--min must be >= 1 (safety guard). Received: ${out.min}`);
  }

  return out;
}

/**
 * Determine whether storageKey looks like an S3 object key we can delete.
 *
 * We treat:
 * - "images/foo.jpg" as deletable
 * and treat:
 * - "https://..." as NOT deletable via S3 deleteObject (because it's not a key)
 */
function isObjectKey(storageKey: string): boolean {
  return (
    !storageKey.startsWith("http://") && !storageKey.startsWith("https://")
  );
}

async function main(): Promise<void> {
  const { mode, min, dryRun } = parseArgs(process.argv.slice(2));

  console.log("=== PepeFinder flag moderation ===");
  console.log(`mode=${mode}`);
  console.log(`min_flag_count=${min}`);
  console.log(`dry_run=${dryRun}`);

  /**
   * Step 1: fetch candidate images.
   *
   * We include storageKey because delete mode may attempt object deletion.
   * We include status so you can see whether we’re changing anything.
   */
  const candidates = await db
    .select({
      id: images.id,
      flagCount: images.flagCount,
      status: images.status,
      storageKey: images.storageKey,
      caption: images.caption,
    })
    .from(images)
    .where(gte(images.flagCount, min))
    .orderBy(sql`${images.flagCount} DESC`, sql`${images.id} DESC`);

  console.log(`candidates=${candidates.length}`);

  if (candidates.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  /**
   * Step 2: print a preview table (operator-friendly).
   * (We keep it small to avoid spamming terminal.)
   */
  for (const c of candidates.slice(0, 25)) {
    const name = c.caption?.trim() ? c.caption.trim() : `#${c.id}`;
    console.log(
      `- id=${c.id} flags=${c.flagCount} status=${c.status} name="${name}" key="${c.storageKey}"`,
    );
  }
  if (candidates.length > 25) {
    console.log(`...and ${candidates.length - 25} more`);
  }

  if (dryRun) {
    console.log("Dry run: no changes applied.");
    return;
  }

  if (mode === "unlist") {
    /**
     * Unlist = status -> "failed"
     *
     * Why "failed"?
     * - Your search router hides status != "indexed"
     * - Your image detail page still shows it by ID
     * - This uses your existing lifecycle enum without adding a new one ("removed")
     *
     * NOTE:
     * - We only update images that are currently indexed,
     *   so we don't rewrite rows unnecessarily.
     */
    const ids = candidates.map((c) => c.id);

    const updated = await db
      .update(images)
      .set({
        status: "failed",
        updatedAt: new Date(),
      })
      .where(and(inArrayIds(ids), eq(images.status, "indexed")))
      .returning({ id: images.id });

    console.log(`unlisted=${updated.length}`);
    return;
  }

  if (mode === "delete") {
    /**
     * Delete mode:
     * - Best-effort delete objects (only if storageKey is a key)
     * - Delete DB row (cascade deletes joins/jobs)
     *
     * IMPORTANT:
     * - DB is the authoritative index for search.
     * - If object deletion fails, we still remove DB row to prevent it from appearing.
     */
    let deletedObjects = 0;
    let deletedRows = 0;
    let objectDeleteFailures = 0;

    for (const c of candidates) {
      if (isObjectKey(c.storageKey)) {
        try {
          await deleteObject({ key: c.storageKey });
          deletedObjects++;
        } catch (err) {
          objectDeleteFailures++;
          // Fail-soft: we still proceed to delete DB row.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `warn: failed to delete object key="${c.storageKey}" id=${c.id}: ${msg}`,
          );
        }
      }
      // Delete DB row (cascades to image_tags + tag_jobs due to FK onDelete=cascade).
      const del = await db
        .delete(images)
        .where(eq(images.id, c.id))
        .returning({ id: images.id });

      if (del.length > 0) deletedRows++;
    }

    console.log(`deleted_rows=${deletedRows}`);
    console.log(`deleted_objects=${deletedObjects}`);
    console.log(`object_delete_failures=${objectDeleteFailures}`);
    return;
  }

  // Exhaustiveness guard.
  const _never: never = mode;
  throw new Error(`Unknown mode: ${_never}`);
}

/**
 * Helper: build a safe "id IN (...)" clause without pulling in extra deps.
 *
 * Drizzle has inArray, but we want to keep this fully typed for ids.
 * We'll implement a small helper using sql fragments to avoid giant query builders.
 */
function inArrayIds(ids: number[]) {
  if (ids.length === 0) {
    // This should never happen in our usage, but keep it safe.
    return sql`FALSE`;
  }

  // Use parameterization for safety.
  // Drizzle will parameterize each value.
  return sql`${images.id} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

main().catch((err) => {
  console.error("flags_moderate failed:", err);
  process.exit(1);
});
