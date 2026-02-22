/**
 * Backfill script: enforce hyphen-split tag invariant for EXISTING rows.
 *
 * What it does:
 * - Finds all image_tags whose tag name contains a hyphen.
 * - For each (image_id, "film-noir"), ensures the SAME image also has:
 *   - "film"
 *   - "noir"
 * - Leaves the original hyphenated tag untouched.
 */

import { sql } from "drizzle-orm";
import { db } from "~/server/db";
import { imageTags, tags } from "~/server/db/schema";
import { expandHyphenatedToken } from "~/lib/text/normalize";

async function main(): Promise<void> {
  console.log("=== PepeFinder hyphen-split backfill starting ===");

  // Pull (image_id, tag_id, tag_name, confidence).
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

  // Cache tagName -> tagId to not re-query tags for every row.
  const tagIdCache = new Map<string, number>();

  let addedJoins = 0;
  let processed = 0;

  for (const r of rows) {
    processed++;

    // Progress logging.
    if (processed % 250 === 0) {
      console.log(
        `progress: processed=${processed}/${rows.length} addedJoins=${addedJoins}`,
      );
    }

    const expanded = expandHyphenatedToken(r.tag_name);

    // No extra parts => nothing to do.
    if (expanded.length <= 1) continue;

    // Skip expanded[0] because that is the original hyphenated token.
    const parts = expanded.slice(1);

    await db.transaction(async (tx) => {
      for (const part of parts) {
        // 1) Resolve tagId for `part` with cache.
        let partTagId = tagIdCache.get(part);

        if (!partTagId) {
          // Upsert the tag row.
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

        // 2) Insert join row.
        const insertedJoin = await tx
          .insert(imageTags)
          .values({
            imageId: r.image_id,
            tagId: partTagId,
            confidence: r.confidence,
          })
          .onConflictDoNothing()
          .returning({ imageId: imageTags.imageId });

        // Count based on join insert result.
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
