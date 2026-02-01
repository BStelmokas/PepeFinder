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
      // Returning [] is cheap and avoids sending a weird “match everything” query to the DB.
      if (tokens.length === 0) return [];

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
      if (tagIds.length === 0) return [];

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
            // This makes “pending/failed uploads” invisible in search while still browseable by ID.
            eq(images.status, "indexed"),

            // Only count tag matches that are in our query tokens.
            inArray(imageTags.tagId, tagIds),
          ),
        )
        .groupBy(
          // Group by image identity so we can aggregate match_count per image.
          images.id,
        )
        .having(
          // “Eligible if it has at least one distinct query token as a tag”.
          // With our WHERE filter, COUNT >= 1 is the eligibility rule.
          sql`${matchCountExpr} >= 1`,
        )
        .orderBy(
          // Primary rank: match_count DESC.
          desc(matchCountExpr),

          // Tie-breaker #1: newest images first.
          desc(images.createdAt),

          // Tie-breaker #2: stable deterministic ordering even if timestamps collide.
          desc(images.id),
        )
        .limit(
          // MVP safeguard: avoid returning unbounded rows by default.
          // You can evolve this into cursor pagination later.
          200,
        );

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
      const resultsWithRenderUrl = await Promise.all(
        results.map(async (r) => {
          try {
            return {
              ...r,

              // Derived field used by the UI for thumbnails.
              // This uses the centralized resolver so we do not duplicate storage policy.
              renderUrl: await resolveImageUrlForBrowser(r.storageKey),
            };
          } catch (err) {
            // Fail-soft: do not break search if URL resolution fails.
            // The UI will likely fail to load the image, but the page still renders.
            return {
              ...r,
              renderUrl: r.storageKey, // Best-effort fallback.
            };
          }
        }),
      );

      // Return the enhanced results.
      return resultsWithRenderUrl;
    }),
});
