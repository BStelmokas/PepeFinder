/**
 * tRPC router: search
 *
 * Responsibility:
 * - Provide DB-only search for images using the *frozen* tokenization rules.
 *
 * Architectural notes (why this lives here):
 * - This is application/domain behavior, so it MUST live behind tRPC (your authoritative app API).
 * - Route Handlers are infra-only, so we do not put search logic in `/app/api/**`.
 * - The request path must remain DB-only: no model calls, no external APIs, no network.
 */

import { z } from "zod"; // Zod is our input contract system at the API boundary (tRPC).
import { and, desc, eq, inArray, sql } from "drizzle-orm"; // Drizzle query builders for safe, typed SQL.
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc"; // T3’s canonical tRPC router/procedure helpers.
import { imageTags, images, tags } from "~/server/db/schema"; // Typed table definitions from our schema (source of truth).
import { tokenizeQuery } from "~/lib/text/normalize"; // Frozen tokenization logic (pure module, reused everywhere).
import { resolveImageUrlForBrowser } from "~/server/storage/resolve-image-url";

export const searchRouter = createTRPCRouter({
  /**
   * search.searchImages
   *
   * Input:
   * - { q: string }
   *
   * Behavior (frozen semantics):
   * - tokenize query using our pure tokenizer (distinct tokens)
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
        // Keep the input shape tiny and explicit.
        // We validate at the boundary so the rest of the system can trust types.
        q: z.string(),

        // STEP 14 CHANGE (pagination):
        // The page size. We cap it to prevent accidental “return 10k rows” requests.
        // This is NOT a "budget protection"; it’s a normal API sanity guard.
        limit: z.number().int().min(1).max(100).optional().default(50),

        /**
         * STEP 14 BUGFIX (RSC serialization):
         * Cursor must be JSON-serializable. Dates in nested objects can break RSC streaming.
         * So we use createdAtMs (number) instead of createdAt: Date.
         */
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
      /**
       * Step 1: tokenize query using the frozen rules.
       *
       * Why do this in the procedure (instead of DB)?
       * - Tokenization rules are part of product semantics and must be identical across:
       *   - UI usage
       *   - server usage
       *   - seed scripts
       *   - worker tagging
       * - We already encoded that as a pure module (Step 3), so we reuse it.
       */
      const tokens = tokenizeQuery(input.q);

      // If the query has no usable tokens after normalization, the correct result is “no matches”.
      if (tokens.length === 0) {
        return { items: [], nextCursor: null, totalCount: 0 };
      }

      /**
       * Step 2: map tokens -> tag IDs.
       *
       * We do this in a separate query for two reasons:
       * 1) It keeps the main search join smaller (we join on integer IDs, not text names).
       * 2) If no tags exist for these tokens, we can short-circuit.
       *
       * Performance note:
       * - `tags.name` has a unique index, so this lookup is fast.
       */
      const matchingTagRows = await ctx.db
        .select({ id: tags.id })
        .from(tags)
        .where(inArray(tags.name, tokens));

      const tagIds = matchingTagRows.map((r) => r.id);

      // If none of the tokens exist in our tags table, nothing can match.
      if (tagIds.length === 0) {
        return { items: [], nextCursor: null, totalCount: 0 };
      }

      /**
       * Step 3: build the DB-only search query.
       *
       * The core idea:
       * - Filter join rows to only those whose tag_id is one of our query tag IDs.
       * - Group by image_id.
       * - match_count = COUNT(DISTINCT tag_id) per image.
       * - Sort by match_count DESC, created_at DESC, id DESC.
       *
       * Why COUNT(DISTINCT)?
       * - Your spec says match_count is “number of distinct query tokens present”.
       * - If an image somehow had duplicate join rows (it shouldn’t, because composite PK),
       *   DISTINCT still protects the ranking semantics.
       */
      const matchCountExpr = sql<number>`count(distinct ${imageTags.tagId})`;

      /**
       * STEP 14 CHANGE (pagination):
       * We fetch "limit + 1" rows so we can tell whether there is another page.
       * - If we got > limit rows, we return the first `limit` and emit nextCursor.
       * - If we got <= limit rows, nextCursor is null.
       */
      const limitPlusOne = input.limit + 1;

      /**
       * STEP 14 FIX (pagination):
       * Use a single tuple comparison that exactly matches ORDER BY.
       *
       * Why this is more reliable than a hand-written OR-chain:
       * - It mirrors the ordering tuple precisely: (matchCount, createdAt, id)
       * - It is much harder to get subtly wrong
       * - It avoids equality/precedence mistakes in nested OR logic
       *
       * For ORDER BY (matchCount DESC, createdAt DESC, id DESC),
       * "next page" means "strictly smaller ordering tuple":
       *   (matchCount, createdAt, id) < (cursor.matchCount, cursor.createdAt, cursor.id)
       *
       * IMPORTANT:
       * - This MUST be used in HAVING because matchCountExpr is an aggregate.
       */
      /**
       * STEP 14 CRITICAL BUGFIX:
       * DO NOT pass a JS Date into SQL parameters.
       *
       * We convert the cursor ms -> Postgres timestamp in SQL:
       *   to_timestamp(ms / 1000.0)
       *
       * This keeps the cursor boundary:
       *   (matchCount, createdAt, id) < (cursorMatchCount, cursorCreatedAt, cursorId)
       * for the DESC order keys.
       */
      const cursorHaving = input.cursor
        ? sql`(
          (${matchCountExpr}, ${images.createdAt}, ${images.id}) < (${input.cursor.matchCount}, to_timestamp(${input.cursor.createdAtMs} / 1000.0), ${input.cursor.id})
        )`
        : undefined;

      /**
       * STEP 14 CHANGE (total count):
       * Compute the total number of *eligible images* for this query.
       *
       * Why do it this way:
       * - Avoids `sql.array(...)` (not available in your Drizzle build).
       * - Uses the same query builder primitives you already use (inArray, groupBy, having).
       * - Stays perfectly consistent with eligibility semantics.
       */

      // A subquery that returns ONE ROW PER eligible image_id.
      // We only select the image id (no heavy columns) to keep it cheap.
      const eligibleImagesSubquery = ctx.db
        .select({
          // Only select the id: we want a cheap "set of eligible images".
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
          // Group by image id so we get one row per image.
          images.id,
        )
        .having(
          // Same eligibility rule: has at least one distinct matching token.
          sql`${matchCountExpr} >= 1`,
        )
        .as("eligible_images");

      const totalCountRow = await ctx.db
        .select({
          // Count how many eligible image IDs exist.
          n: sql<number>`count(*)`.as("n"),
        })
        .from(eligibleImagesSubquery);

      /**
       * STEP 14 BUGFIX:
       * COUNT(*) may come back as a string at runtime depending on the driver.
       * We coerce to number so the UI and cursor encoding are stable and predictable.
       */
      const totalCount = Number(totalCountRow[0]?.n ?? 0);

      const results = await ctx.db
        .select({
          // Minimal fields for the search grid UI.
          id: images.id,
          storageKey: images.storageKey,
          createdAt: images.createdAt,

          // STEP 12/Option A CHANGE:
          // Include caption so the search UI can render a “meme name” per result.
          //
          // Why it must be selected here:
          // - tRPC output types are inferred from what the procedure returns.
          // - If we don't select caption, TS correctly says `r.caption` doesn't exist.
          caption: images.caption,

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
            // This makes “pending/failed uploads” invisible in search while still browseable by ID.
            eq(images.status, "indexed"),

            // Only count tag matches that are in our query tokens.
            inArray(imageTags.tagId, tagIds),
          ),
        )
        .groupBy(
          // Group by image identity so we can aggregate match_count per image.
          // STEP 12/Option A CHANGE:
          // Because we selected `images.caption`, Postgres requires it to be in GROUP BY too
          // (since it is not an aggregate like COUNT()).
          images.id,
          images.caption,
          images.storageKey,
          images.createdAt,
        )
        .having(
          // “Eligible if it has at least one distinct query token as a tag”.
          // With our WHERE filter, COUNT >= 1 is the eligibility rule.
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
       * STEP 14 CHANGE (pagination):
       * Split results into:
       * - page items (first `input.limit`)
       * - overflow (if present) to determine nextCursor
       */
      const pageRows = results.slice(0, input.limit);
      const hasMore = results.length > input.limit;

      /**
       * We now attach `renderUrl` for each result row.
       *
       * Why:
       * - storageKey can be an S3 object key like "images/<sha>.jpg"
       * - browsers require a URL for <img src="...">
       *
       * Why this is safe:
       * - We keep storageKey unchanged (backwards compatibility)
       * - We add renderUrl as extra optional data
       * - We catch resolver errors per row and fall back to storageKey
       *   so search doesn’t fail if one row is weird.
       */
      const items = await Promise.all(
        pageRows.map(async (r) => {
          /**
           * STEP 14 BUGFIX:
           * matchCount (COUNT DISTINCT) can arrive as a string at runtime.
           * We normalize it here so:
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
              // This uses the centralized resolver so we do not duplicate storage policy.
              renderUrl: await resolveImageUrlForBrowser(r.storageKey),
            };
          } catch {
            // Fail-soft: do not break search if URL resolution fails.
            // The UI will likely fail to load the image, but the page still renders.
            return {
              ...r,
              matchCount, // overwrite with normalized number
              renderUrl: r.storageKey, // Best-effort fallback.
            };
          }
        }),
      );

      /**
       * STEP 14 CHANGE (pagination):
       * The next cursor is the last item of the current page,
       * because that defines the boundary for “rows after this” on the next call.
       */
      const last = items[items.length - 1];

      /**
       * STEP 14 BUGFIX (RSC serialization):
       * nextCursor contains only JSON primitives.
       */
      const nextCursor =
        hasMore && last
          ? {
              // STEP 14 BUGFIX: ensure number, not string.
              matchCount: Number(last.matchCount),
              createdAtMs: last.createdAt.getTime(),
              id: last.id,
            }
          : null;

      return { items, nextCursor, totalCount };
    }),
});
