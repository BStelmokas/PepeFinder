/**
 * tRPC router: image
 *
 * Responsibility:
 * - Fetch a single image by ID (for the /image/[id] page).
 * - Fetch that image’s tags ordered by confidence desc (UI detail view).
 *
 * Why it’s a separate router:
 * - Keeps the API surface modular and discoverable.
 * - Avoids a “god router” where unrelated procedures pile up.
 */

import { z } from "zod"; // Runtime validation for inputs at the boundary.
import { desc, eq } from "drizzle-orm"; // Typed SQL operators.
import { TRPCError } from "@trpc/server"; // Canonical error type for tRPC (maps cleanly to HTTP in Next).
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc"; // T3 router/procedure primitives.
import { imageTags, images, tags } from "~/server/db/schema"; // Table definitions (source of truth).
import { createPresignedGetUrl, publicUrlForKey } from "~/server/storage/s3";

export const imageRouter = createTRPCRouter({
  /**
   * image.getById
   *
   * Input:
   * - { id: number }
   *
   * Output:
   * - image: { id, storageKey, sha256, status, createdAt, updatedAt, source?, sourceRef? }
   * - tags: Array<{ id, name, confidence, createdAt }>
   *
   * Ordering:
   * - tags ordered by confidence DESC (then name as a stable tie-breaker)
   *
   * Note:
   * - Even if an image is "pending" or "failed", it should be viewable by ID.
   * - Search results will only include "indexed", but detail pages can show status.
   */
  getById: publicProcedure
    .input(
      z.object({
        // IDs are numeric in our schema (serial int).
        id: z.number().int().positive(),
      }),
    )
    .query(async ({ ctx, input }) => {
      /**
       * Step 1: fetch the image row.
       *
       * We do this first so we can:
       * - return NOT_FOUND cleanly if the image doesn’t exist
       * - avoid doing the tag join work unnecessarily
       */
      const imageRow = await ctx.db
        .select({
          id: images.id,
          storageKey: images.storageKey,
          sha256: images.sha256,
          status: images.status,
          createdAt: images.createdAt,
          updatedAt: images.updatedAt,
          source: images.source,
          sourceRef: images.sourceRef,
        })
        .from(images)
        .where(eq(images.id, input.id))
        .limit(1);

      const image = imageRow[0];

      if (!image) {
        // tRPC error that will map to a 404-like response for callers.
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Image not found",
        });
      }

      /**
       * renderUrl logic (minimal, practical):
       * - If storageKey looks like a URL/path (starts with "http" or "/"), render directly.
       * - If storageKey looks like an S3 object key (e.g. "images/<sha>.png"), then:
       *   - use public base url if available
       *   - else generate a short-lived signed GET URL
       *
       * This keeps MVP1 usable even if your bucket is private.
       */
      let renderUrl: string;

      if (
        image.storageKey.startsWith("http") ||
        image.storageKey.startsWith("/")
      ) {
        renderUrl = image.storageKey;
      } else {
        // storageKey is treated as an object key.
        const pub = publicUrlForKey(image.storageKey);

        renderUrl =
          pub ??
          (await createPresignedGetUrl({
            key: image.storageKey,
            expiresInSeconds: 60 * 10, // 10 min is plenty for viewing an image page.
          }));
      }

      /**
       * Step 2: fetch tags for this image ordered by confidence DESC.
       *
       * Why this query shape?
       * - image_tags is the join table; tags provides the human-readable name.
       * - We keep joins minimal (image_tags -> tags).
       * - We rely on our index (image_id, confidence DESC) for performance.
       */
      const tagRows = await ctx.db
        .select({
          id: tags.id,
          name: tags.name,
          confidence: imageTags.confidence,
          createdAt: imageTags.createdAt,
        })
        .from(imageTags)
        .innerJoin(tags, eq(imageTags.tagId, tags.id))
        .where(eq(imageTags.imageId, input.id))
        .orderBy(
          // Highest-confidence tags first (best UX for “generated tags + confidence”).
          desc(imageTags.confidence),

          // Stable ordering when confidence ties (prevents UI jitter across runs).
          tags.name,
        );

      return {
        image: {
          ...image,
          renderUrl, // always renderable in <img src>
        },
        tags: tagRows,
      };
    }),
});
