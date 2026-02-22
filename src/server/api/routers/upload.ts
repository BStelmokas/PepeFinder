/**
 * tRPC router: upload (MVP1)
 *
 * Responsibility:
 * - Create an upload plan that is cost-safe and DB-first:
 *   1) Validate metadata (size/type).
 *   2) Accept a SHA-256 fingerprint (computed client-side).
 *   3) If already exists -> return existing image (no duplicate work).
 *   4) If new -> create presigned PUT URL, insert image row as pending.
 *
 * Why does client compute SHA-256 (two-step flow)?
 * - tRPC is JSON-based; uploading multi-MB binary through it is awkward and expensive.
 * - Vercel serverless has body size/time constraints.
 * - Browser can compute SHA-256 with Web Crypto efficiently.
 * - This keeps the server as an orchestrator, not a byte-pipe.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";

// tRPC router: upload.
import { images, tagJobs } from "~/server/db/schema";
import { createPresignedPutUrl, publicUrlForKey } from "~/server/storage/s3";

// Allowlist of MIME types for MVP1.
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

// Small size cap.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MiB

// Derive a file extension from a MIME type.
function extensionFromMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      // This should be unreachable because MIME types are validated before calling.
      return "bin";
  }
}

export const uploadRouter = createTRPCRouter({
  /**
   * upload.createUploadPlan
   *
   * Input:
   * - fileName: string (for UI only; not trusted for security)
   * - contentType: string (must be in allowlist)
   * - size: number (must be <= cap)
   * - sha256: string (64 hex chars) computed from file bytes client-side
   *
   * Output:
   * - If already exists:
   *   { alreadyExists: true, imageId, uploadUrl: null, objectKey: null, publicUrl: null }
   * - If new:
   *   { alreadyExists: false, imageId, uploadUrl, objectKey, publicUrl? }
   */
  createUploadPlan: publicProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(255),
        contentType: z.string().min(1),
        size: z.number().int().positive(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/i, "sha256 must be a 64-char hex string"),
      }),
    )
    .mutation(async ({ input }) => {
      // 1) Validate content type against allowlist.
      if (!ALLOWED_IMAGE_MIME_TYPES.has(input.contentType)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unsupported contentType. Allowed: ${Array.from(ALLOWED_IMAGE_MIME_TYPES).join(", ")}`,
        });
      }

      // 2) Enforce size cap.
      if (input.size > MAX_UPLOAD_BYTES) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `File too large. Max ${MAX_UPLOAD_BYTES} bytes.`,
        });
      }

      // Normalize sha to lowercase hex for storage consistency.
      const sha256 = input.sha256.toLowerCase();

      // 3) Dedupe: if image already exists by sha256, reuse it.
      const existing = await db
        .select({
          id: images.id,
          storageKey: images.storageKey,
          status: images.status,
        })
        .from(images)
        .where(eq(images.sha256, sha256))
        .limit(1);

      if (existing.length > 0) {
        return {
          alreadyExists: true as const,
          imageId: existing[0]!.id,
          uploadUrl: null as string | null,
          objectKey: null as string | null,
          publicUrl: null as string | null,
          status: existing[0]!.status,
        };
      }

      // 4) New image: create deterministic object key and insert DB row as pending.
      const ext = extensionFromMime(input.contentType);

      /**
       * Deterministic object key:
       * - Content-addressed storage: sha256 identifies the bytes.
       * - Avoids duplicates naturally.
       * - Makes future debugging trivial ("what is this object?").
       */
      const objectKey = `images/${sha256}.${ext}`;

      // storageKey stored in DB.
      const publicUrl = publicUrlForKey(objectKey);
      const storageKey = publicUrl ?? objectKey;

      // Insert image row as pending.
      const inserted = await db
        .insert(images)
        .values({
          storageKey,
          sha256,
          status: "pending",
          source: "upload",
          sourceRef: input.fileName,
        })
        .onConflictDoNothing()
        .returning({ id: images.id });

      let imageId: number;

      if (inserted.length > 0) {
        imageId = inserted[0]!.id;
      } else {
        // Defensive fallback if a race occurs (two clients upload same file at once).
        const raced = await db
          .select({ id: images.id })
          .from(images)
          .where(eq(images.sha256, sha256))
          .limit(1);

        if (raced.length === 0) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create image record.",
          });
        }

        imageId = raced[0]!.id;

        return {
          alreadyExists: true as const,
          imageId,
          uploadUrl: null as string | null,
          objectKey: null as string | null,
          publicUrl: null as string | null,
          status: "pending" as const,
        };
      }

      // 5) Create presigned PUT URL so the browser can upload bytes directly to S3.
      const uploadUrl = await createPresignedPutUrl({
        key: objectKey,
        contentType: input.contentType,
        expiresInSeconds: 60 * 5, // 5 minutes
      });

      return {
        alreadyExists: false as const,
        imageId,
        uploadUrl,
        objectKey,
        publicUrl, // null if bucket is private.
        status: "pending" as const,
      };
    }),

  /**
   * upload.enqueueTaggingJob (Step 11)
   *
   * Input: { imageId: number }
   */
  enqueueTaggingJob: publicProcedure
    .input(
      z.object({
        imageId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      // Ensure the image exists.
      const imageRow = await db
        .select({
          id: images.id,
          status: images.status,
        })
        .from(images)
        .where(eq(images.id, input.imageId))
        .limit(1);

      const image = imageRow[0];
      if (!image) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Image not found" });
      }

      if (image.status === "indexed") {
        return { enqueued: false as const, reason: "already_indexed" as const };
      }

      // Insert job if missing (idempotent due to unique(image_id)).
      await db
        .insert(tagJobs)
        .values({
          imageId: input.imageId,
          status: "queued",
          attempts: 0,
        })
        .onConflictDoNothing();

      return { enqueued: true as const, reason: "queued" as const };
    }),
});
