/**
 * tRPC router: search
 *
 * Responsibility:
 * - Provide DB-only search for images using the frozen tokenization rules.
 *
 * Architecture:
 * - This is application/domain behavior, so it must live behind tRPC.
 * - The request path must remain DB-only: no model calls, no external APIs, no network.
 */

import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { imageTags, images, tags } from "~/server/db/schema";
import { tokenizeQuery } from "~/lib/text/normalize";
import { resolveImageUrlForBrowser } from "~/server/storage/resolve-image-url";

export const searchRouter = createTRPCRouter({
  /**
   * search.searchImages
   *
   * Input:
   * - { q: string }
   *
   * Behavior (frozen semantics):
   * - tokenize query using the pure tokenizer (distinct tokens)
   * - eligible if image has >= 1 distinct query token as a tag
   * - rank by:
   *   1) match_count DESC
   *   2) created_at DESC
   *   3) id DESC (deterministic tie-breaker)
   *
   * Output (minimal grid fields):
   * - id, storageKey, createdAt, matchCount
   */
  searchImages: publicProcedure
    .input(
      z.object({
        q: z.string(),

        // The page size. Cap it to prevent accidental “return 10k rows” requests. Nnormal API sanity guard.
        limit: z.number().int().min(1).max(100).optional().default(48),

        // Cursor must be JSON-serializable. Dates in nested objects can break RSC streaming.
        // So use createdAtMs (number) instead of createdAt: Date.
        cursor: z
          .object({
            matchCount: z.number().int().min(1),
            createdAtMs: z.number().int().nonnegative(),
            id: z.number().int().positive(),
          })
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Step 1: tokenize query using the frozen rules.
      const tokens = tokenizeQuery(input.q);

      // If the query has no usable tokens after normalization, the correct result is “no matches”.
      if (tokens.length === 0) {
        return { items: [], nextCursor: null, totalCount: 0 };
      }

      /**
       * Step 2: map tokens -> tag IDs.
       *
       * Performance note:
       * - `tags.name` has a unique index, so this lookup is fast.
       */
      const matchingTagRows = await ctx.db
        .select({ id: tags.id })
        .from(tags)
        .where(inArray(tags.name, tokens));

      const tagIds = matchingTagRows.map((r) => r.id);

      // If none of the tokens exist in the tags table, nothing can match.
      if (tagIds.length === 0) {
        return { items: [], nextCursor: null, totalCount: 0 };
      }

      // Step 3: build the DB-only search query.
      const matchCountExpr = sql<number>`count(distinct ${imageTags.tagId})`;

      /**
       * Pagination:
       * Fetch "limit + 1" rows to tell if there is another page.
       * - If > limit rows, return the first `limit` and emit nextCursor.
       * - If <= limit rows, nextCursor is null.
       */
      const limitPlusOne = input.limit + 1;

      const cursorHaving = input.cursor
        ? sql`(
          (${matchCountExpr}, ${images.createdAt}, ${images.id}) < (${input.cursor.matchCount}, to_timestamp(${input.cursor.createdAtMs} / 1000.0), ${input.cursor.id})
        )`
        : undefined;

      // A subquery that returns ONE ROW PER eligible image_id.
      // Only select the image id (no heavy columns) to keep it cheap.
      const eligibleImagesSubquery = ctx.db
        .select({
          // Only select the id: a cheap set of eligible images.
          id: images.id,
        })
        .from(images)
        .innerJoin(
          imageTags,
          // Join images -> image_tags via image_id.
          eq(imageTags.imageId, images.id),
        )
        .where(
          and(eq(images.status, "indexed"), inArray(imageTags.tagId, tagIds)),
        )
        .groupBy(
          // Group by image id to get one row per image.
          images.id,
        )
        .having(sql`${matchCountExpr} >= 1`)
        .as("eligible_images");

      const totalCountRow = await ctx.db
        .select({
          // Count how many eligible image IDs exist.
          n: sql<number>`count(*)`.as("n"),
        })
        .from(eligibleImagesSubquery);

      /**
       * COUNT(*) may come back as a string at runtime depending on the driver.
       * Coerce to number so the UI and cursor encoding are stable and predictable.
       */
      const totalCount = Number(totalCountRow[0]?.n ?? 0);

      const results = await ctx.db
        .select({
          // Minimal fields for the search grid UI.
          id: images.id,
          storageKey: images.storageKey,
          createdAt: images.createdAt,
          // The computed rank signal (match_count).
          matchCount: matchCountExpr.as("match_count"),
        })
        .from(images)
        .innerJoin(
          imageTags,
          // Join images -> image_tags via image_id.
          eq(imageTags.imageId, images.id),
        )
        .where(
          and(
            // Only searchable images should appear.
            eq(images.status, "indexed"),

            // Only count tag matches that are in the query tokens.
            inArray(imageTags.tagId, tagIds),
          ),
        )
        .groupBy(
          // Group by image identity to can aggregate match_count per image.
          images.id,
          images.storageKey,
          images.createdAt,
        )
        .having(
          // Eligible if it has at least one distinct query token as a tag.
          cursorHaving
            ? sql`${matchCountExpr} >= 1 AND ${cursorHaving}`
            : sql`${matchCountExpr} >= 1`,
        )
        .orderBy(
          // Primary rank: match_count DESC.
          desc(matchCountExpr),

          // Tie-breaker #1: newest images first.
          desc(images.createdAt),

          // Tie-breaker #2: stable deterministic ordering even if timestamps collide.
          desc(images.id),
        )
        .limit(limitPlusOne);

      /**
       * Ppagination:
       * Split results into:
       * - page items (first `input.limit`)
       * - overflow (if present) to determine nextCursor
       */
      const pageRows = results.slice(0, input.limit);
      const hasMore = results.length > input.limit;

      // Attach `renderUrl` for each result row.
      const items = await Promise.all(
        pageRows.map(async (r) => {
          /**
           * matchCount (COUNT DISTINCT) can arrive as a string at runtime.
           * Normalize it here so:
           * - rendering is correct
           * - cursor encoding uses numbers (not "1")
           * - downstream code doesn't have to guess
           */
          const matchCount = Number(r.matchCount);
          try {
            return {
              ...r,
              matchCount, // overwrite with normalized number

              // Derived field used by the UI for thumbnails.
              renderUrl: await resolveImageUrlForBrowser(r.storageKey),
            };
          } catch {
            // Fail-soft: do not break search if URL resolution fails.
            // The UI will fail to load the image, but the page still renders.
            return {
              ...r,
              matchCount, // overwrite with normalized number
              renderUrl: r.storageKey, // Best-effort fallback.
            };
          }
        }),
      );

      /**
       * Pagination:
       * The next cursor is the last item of the current page,
       * because that defines the boundary for “rows after this” on the next call.
       */
      const last = items[items.length - 1];

      /**
       * RSC serialization:
       * nextCursor contains only JSON primitives.
       */
      const nextCursor =
        hasMore && last
          ? {
              // Ensure number, not string.
              matchCount: Number(last.matchCount),
              createdAtMs: last.createdAt.getTime(),
              id: last.id,
            }
          : null;

      return { items, nextCursor, totalCount };
    }),
});
