/**
 * Backfill script: enforce hyphen-split tag invariant for EXISTING rows.
 *
 * What it does:
 * - Finds all image_tags whose tag name contains a hyphen.
 * - For each (image_id, "film-noir"), ensures the SAME image also has:
 *   - "film"
 *   - "noir"
 * - Leaves the original hyphenated tag untouched.
 *
 * Why it exists:
 * - You already tagged a large corpus.
 * - We want "film noir" searches to match "film-noir" images deterministically.
 *
 * Safety:
 * - Idempotent: safe to re-run.
 * - Adds only missing join rows; does not delete/rename anything.
 *
 * Ops recommendation:
 * - Stop the worker while running to avoid concurrent writes (optional but cleaner).
 */

import { sql } from "drizzle-orm";
import { db } from "~/server/db";
import { imageTags, tags } from "~/server/db/schema";
import { expandHyphenatedToken } from "~/lib/text/normalize";

async function main(): Promise<void> {
  console.log("=== PepeFinder hyphen-split backfill starting ===");

  /**
   * We pull (image_id, tag_id, tag_name, confidence).
   * We only care about rows whose tag name contains a hyphen.
   */
  /**
   * ✅ PROPOSED CHANGE: de-duplicate work up front.
   *
   * Why:
   * - Without DISTINCT/GROUP BY, you may process the same (image_id, tag_name)
   *   multiple times depending on prior runs / joins.
   * - GROUP BY also gives us a stable confidence to copy (max is fine).
   */
  const rows = await db.execute<{
    image_id: number;
    tag_name: string;
    confidence: number;
  }>(sql`
      SELECT it.image_id, t.name as tag_name, MAX(it.confidence)::float as confidence
      FROM image_tags it
      JOIN tags t ON t.id = it.tag_id
      WHERE t.name LIKE '%-%'
      GROUP BY it.image_id, t.name
    `);

  console.log(`Found ${rows.length} hyphenated (image, tag) pairs.`);

  /**
   * ✅ PROPOSED CHANGE: cache tagName -> tagId so we don't re-query tags for every row.
   *
   * This turns thousands of "SELECT tags.id WHERE name=..." into at most one per new tag name.
   */
  const tagIdCache = new Map<string, number>();

  let addedJoins = 0;
  let processed = 0;

  for (const r of rows) {
    processed++;

    // Progress logging so it never "looks stuck".
    if (processed % 250 === 0) {
      console.log(
        `progress: processed=${processed}/${rows.length} addedJoins=${addedJoins}`,
      );
    }

    // expandHyphenatedToken returns [original, ...parts]
    const expanded = expandHyphenatedToken(r.tag_name);

    // If for some reason there are no extra parts, nothing to do.
    if (expanded.length <= 1) continue;

    // We skip expanded[0] because that is the original hyphenated token.
    const parts = expanded.slice(1);

    await db.transaction(async (tx) => {
      for (const part of parts) {
        // 1) Resolve tagId for `part` with cache.
        let partTagId = tagIdCache.get(part);

        if (!partTagId) {
          // Upsert the tag row (idempotent).
          const insertedTag = await tx
            .insert(tags)
            .values({ name: part })
            .onConflictDoNothing()
            .returning({ id: tags.id });

          if (insertedTag.length > 0) {
            partTagId = insertedTag[0]!.id;
          } else {
            const existing = await tx
              .select({ id: tags.id })
              .from(tags)
              .where(sql`${tags.name} = ${part}`)
              .limit(1);

            if (!existing[0]) {
              throw new Error(`Tag conflict but cannot fetch id for: ${part}`);
            }

            partTagId = existing[0].id;
          }

          tagIdCache.set(part, partTagId);
        }

        /**
         * Insert the join row for this image.
         *
         * Confidence policy:
         * - Copy the same confidence as the hyphenated source tag.
         * - Confidence is display-only; ranking ignores it.
         */
        // 2) Insert join row; count only if we truly inserted.
        const insertedJoin = await tx
          .insert(imageTags)
          .values({
            imageId: r.image_id,
            tagId: partTagId,
            confidence: r.confidence,
          })
          .onConflictDoNothing()
          .returning({ imageId: imageTags.imageId });

        // PROPOSED CHANGE: count based on join insert result (correct).
        if (insertedJoin.length > 0) {
          addedJoins++;
        }
      }
    });
  }

  console.log("=== PepeFinder hyphen-split backfill complete ===");
  console.log({ processed, addedJoins });
}

main().catch((err) => {
  console.error("Hyphen backfill failed:", err);
  process.exit(1);
});
