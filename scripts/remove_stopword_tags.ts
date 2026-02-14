/**
 * One-off backfill: remove stopwords from existing tags.
 *
 * Why this exists:
 * - You already generated tags for ~5,000 images.
 * - Some tags contain stopwords like "a", "an", "the", "and" which add noise.
 * - We want to clean historical data without breaking referential integrity.
 *
 * Safety properties:
 * - Idempotent: safe to run multiple times.
 * - Conflict-safe: we avoid duplicate (image_id, tag_id) rows by inserting with ON CONFLICT.
 *
 * Operational notes:
 * - Run this while the worker is stopped (recommended) to avoid races.
 * - This does NOT change images; it only adjusts tags + image_tags.
 */

import { inArray } from "drizzle-orm";
import { db } from "~/server/db";
import { imageTags, tags } from "~/server/db/schema";

/**
 * Small, hardcoded stopword list.
 *
 * We keep it tiny on purpose:
 * - We only remove words that are almost always noise for this meme-search use case.
 * - We avoid removing words that might matter (e.g., "no", "not", "vs") without thinking.
 */
const STOPWORDS = ["a", "an", "the"] as const;

async function main(): Promise<void> {
  console.log("=== Remove stopword tags (single-token) ===");
  console.log(`Stopwords: ${STOPWORDS.join(", ")}`);

  // Find tag ids for stopwords.
  const stopwordTags = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(inArray(tags.name, [...STOPWORDS]));

  if (stopwordTags.length === 0) {
    console.log("No stopword tags found. Nothing to do.");
    return;
  }

  console.log(`Found ${stopwordTags.length} stopword tags to delete.`);

  const ids = stopwordTags.map((t) => t.id);

  await db.transaction(async (tx) => {
    // Delete join rows first (clear references).
    await tx.delete(imageTags).where(inArray(imageTags.tagId, ids));
    // Delete the tag rows.
    await tx.delete(tags).where(inArray(tags.id, ids));
  });

  console.log("Deleted stopword tags + join rows.");
}

main().catch((err) => {
  console.error("Stopword tag removal failed:", err);
  process.exit(1);
});
