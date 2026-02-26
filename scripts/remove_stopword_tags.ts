/**
 * One-off backfill: remove stopwords from existing tags.
 */

import { inArray } from "drizzle-orm";
import { db } from "~/server/db";
import { imageTags, tags } from "~/server/db/schema";

// Hardcoded stopword list.
const STOPWORDS = ["s", "re"] as const;

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
