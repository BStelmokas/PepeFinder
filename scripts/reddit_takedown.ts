/**
 * MVP2 — Reddit takedown helper (manual).
 *
 * Goal:
 * - Remove an ingested image by reddit post_id (sourceRef).
 * - Optionally delete the S3 object.
 * - Delete the images row (cascades to image_tags + tag_jobs via FK onDelete: cascade).
 *
 * Why this matters:
 * - Takedown readiness is a core compliance/ethics feature.
 * - You want a deterministic way to remove content by its source ID.
 */

import { env } from "~/env";
import { db } from "~/server/db";
import { images } from "~/server/db/schema";
import { deleteObject } from "~/server/storage/s3";
import { sql } from "drizzle-orm";

/**
 * Attempt to derive an S3 object key from storageKey.
 *
 * storageKey might be:
 * - full public URL (S3_PUBLIC_BASE_URL + key)
 * - raw object key (e.g., "images/reddit/<sha>.jpg")
 *
 * If we cannot derive, we skip object deletion (still delete DB row).
 */
function deriveObjectKey(storageKey: string): string | null {
  // If it’s an object key (no scheme, no leading slash), we assume it is already the key.
  if (
    !storageKey.startsWith("http://") &&
    !storageKey.startsWith("https://") &&
    !storageKey.startsWith("/")
  ) {
    return storageKey;
  }

  // If it’s a public URL and we know the base, strip it.
  if (storageKey.startsWith("http://") || storageKey.startsWith("https://")) {
    if (!env.S3_PUBLIC_BASE_URL) return null;

    const base = env.S3_PUBLIC_BASE_URL.replace(/\/$/, "");
    if (!storageKey.startsWith(base + "/")) return null;

    return storageKey.slice(base.length + 1);
  }

  // "/seed/foo.png" etc: not S3
  return null;
}

async function main(): Promise<void> {
  const postId = process.argv[2];

  if (!postId) {
    console.error("Usage: pnpm reddit:takedown <reddit_post_id>");
    process.exit(1);
  }

  console.log(`=== PepeFinder takedown: reddit post_id=${postId} ===`);

  const rows = await db
    .select({
      id: images.id,
      storageKey: images.storageKey,
      sha256: images.sha256,
      sourceUrl: images.sourceUrl,
    })
    .from(images)
    .where(sql`${images.source} = 'reddit' AND ${images.sourceRef} = ${postId}`)
    .limit(1);

  const img = rows[0];
  if (!img) {
    console.log("No image found for that post_id. Nothing to do.");
    return;
  }

  console.log(
    `Found image_id=${img.id} sha256=${img.sha256} url=${img.sourceUrl ?? "?"}`,
  );

  // Best-effort S3 delete.
  const key = deriveObjectKey(img.storageKey);
  if (key) {
    console.log(`Deleting S3 object key=${key} (best-effort)…`);
    try {
      await deleteObject({ key });
      console.log("S3 object deleted.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`S3 delete failed (continuing DB delete): ${msg}`);
    }
  } else {
    console.log("Could not derive S3 key from storageKey; skipping S3 delete.");
  }

  // Delete DB row (cascades to image_tags and tag_jobs).
  await db.delete(images).where(sql`${images.id} = ${img.id}`);
  console.log("DB row deleted (cascade cleanup done).");
}

main().catch((err) => {
  console.error("Takedown script failed:", err);
  process.exit(1);
});
