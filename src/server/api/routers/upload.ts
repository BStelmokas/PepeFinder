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
 * IMPORTANT invariants:
 * - No AI calls on request path.
 * - Minimal new deps (AWS SDK only).
 * - Uses DB uniqueness to guarantee idempotency and dedupe.
 *
 * Why client computes SHA-256 (two-step flow)?
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

/**
 * tRPC router: upload (MVP1)
 *
 * Step 11 adds:
 * - upload.enqueueTaggingJob: a server-only mutation that creates a tag_jobs row if missing.
 *
 * Important invariant:
 * - enqueue mutation does NOT call any model.
 * - Worker is the only place where paid model calls will ever happen.
 */
import { images, tagJobs } from "~/server/db/schema";
import { createPresignedPutUrl, publicUrlForKey } from "~/server/storage/s3";

/**
 * Allowlist of MIME types for MVP1.
 *
 * Why allowlist?
 * - It’s safer than trying to “block bad types”.
 * - It avoids accepting arbitrary bytes that could be surprising later.
 *
 * Expand this list only intentionally.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * Small size cap for MVP1.
 *
 * Why cap at all?
 * - Prevents accidental huge uploads and runaway storage bills.
 * - Makes worst-case request times predictable.
 *
 * You can raise this later once you have monitoring and budgets.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * Derive a file extension from a MIME type.
 *
 * Why not trust the original filename?
 * - Filenames are user-controlled and messy.
 * - MIME type is what S3 will store and what browsers interpret.
 */
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
      // This should be unreachable because we validate MIME types before calling.
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
   *
   * Why return imageId even before upload?
   * - We insert the DB row first (status=pending) so the system has a durable identity.
   * - Later steps (job queue / worker) can reference this image id.
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
      const sha256 = input.sha256.toLocaleLowerCase();

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

      /**
       * storageKey stored in DB:
       * - If you have a public base URL, store the full URL so it is immediately renderable.
       * - Otherwise store the object key; detail pages can create signed GET URLs.
       */
      const publicUrl = publicUrlForKey(objectKey);
      const storageKey = publicUrl ?? objectKey;

      /**
       * Insert image row as pending.
       *
       * Why pending?
       * - Worker (Step 10/11+) will later generate tags.
       * - Search procedure filters to status='indexed', so uploads won't show in search until done.
       */
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
        expiresInSeconds: 60 * 5, // 5 minutes is a common, safe default for upload URLs.
      });

      return {
        alreadyExists: false as const,
        imageId,
        uploadUrl,
        objectKey,
        publicUrl, // null if bucket is private (fine).
        status: "pending" as const,
      };
    }),

  /**
   * upload.enqueueTaggingJob (Step 11)
   *
   * Input: { imageId: number }
   *
   * Behavior:
   * - Ensures a tag_jobs row exists (unique(image_id) ensures no duplicates).
   * - Does NOT call any model.
   *
   * Why this is a separate mutation (instead of automatically enqueuing in createUploadPlan)?
   * - createUploadPlan happens *before* the bytes are uploaded.
   * - We only want to enqueue once we believe the object exists in S3.
   * - Separating “plan” from “enqueue” makes failure modes cleaner:
   *   - if upload fails, no job is created
   *   - if upload succeeds, enqueue is explicit and idempotent
   */
  enqueueTaggingJob: publicProcedure
    .input(
      z.object({
        imageId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      // Ensure the image exists (otherwise we'd create a dangling job).
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

      // If the image is already indexed, there is no reason to enqueue.
      // This is important: “no user behavior should cause unbounded paid usage”.
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
