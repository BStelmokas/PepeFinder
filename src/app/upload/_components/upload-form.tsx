"use client";

/**
 * UploadForm (Client Component)
 *
 * Why this must be a Client Component:
 * - File input (<input type="file">) is inherently client-side.
 * - SHA-256 hashing uses browser Web Crypto (crypto.subtle).
 * - Upload progress and polling require client state.
 *
 * Key architectural constraints we obey:
 * - All writes go through tRPC React client:
 *   - We call upload.createUploadPlan (authoritative server boundary).
 * - Actual file bytes go directly to S3 via presigned PUT:
 *   - This avoids pushing large bytes through Next serverless functions.
 * - No AI calls happen here or on request path.
 *
 * UX goals:
 * - Minimal and professional UI.
 * - Clear states: idle -> hashing -> requesting URL -> uploading -> indexing/polling -> done/failed.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "~/trpc/react"; // T3’s tRPC React client (TanStack Query) - authoritative for client reads/writes.

/**
 * Keep client-side validation aligned with server rules for UX consistency.
 * Server is still authoritative (re-validates), but this avoids wasting time.
 *
 * NOTE: These must match the server values in upload router.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MiB

type UiStage =
  | "idle"
  | "validating"
  | "hashing"
  | "planning"
  | "uploading"
  | "enqueuing"
  | "indexing"
  | "failed";

/**
 * Convert an ArrayBuffer to lowercase hex.
 *
 * Why this exists:
 * - Web Crypto returns ArrayBuffer digests.
 * - The server expects sha256 as a 64-char hex string.
 * - Hex is deterministic and easy to store/debug.
 */
function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Compute SHA-256 of a File using Web Crypto.
 *
 * Why do this client-side?
 * - tRPC is JSON; sending raw bytes to the server is awkward and expensive.
 * - Presigned PUT lets bytes go directly to object storage.
 * - SHA-256 is needed for deterministic object keys + dedupe.
 */
async function sha256File(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bufferToHex(digest);
}

export function UploadForm() {
  const router = useRouter();

  // Local UI state.
  const [stage, setStage] = useState<UiStage>("idle");
  const [error, setError] = useState<string | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Once we have an imageId, we can poll its status via image.getById.
  const [imageId, setImageId] = useState<number | null>(null);

  /**
   * tRPC mutation: ask the server for an upload plan.
   *
   * This is the authoritative server boundary that:
   * - re-validates size/type
   * - dedupes by sha256
   * - inserts pending image row (if new)
   * - returns a presigned PUT URL (if new)
   */
  const createPlan = api.upload.createUploadPlan.useMutation();

  /**
   * New in Step 11:
   * - enqueueTaggingJob tells the server “bytes exist, please queue worker tagging”
   * - It is idempotent due to unique(image_id) in tag_jobs.
   */
  const enqueueJob = api.upload.enqueueTaggingJob.useMutation();

  /**
   * Poll image.getById once we have an imageId.
   *
   * Polling strategy:
   * - enabled only when stage === "indexing" and imageId exists
   * - refetch every 2 seconds (cheap at MVP scale)
   *
   * What we’re waiting for:
   * - status === "indexed" -> redirect to /image/[id]
   * - status === "failed"  -> show error
   *
   * Note:
   * - Right now, nothing actually flips pending -> indexed for uploads until we add the worker.
   * - That’s okay: UI will show “Indexing…” which is truthful.
   * - Once the worker exists, this page becomes fully functional without changes.
   */
  const imageQuery = api.image.getById.useQuery(
    { id: imageId ?? 1 },
    {
      enabled: imageId !== null && stage === "indexing",
      refetchInterval: 2000,
      retry: false,
    },
  );

  /**
   * Derived “status” for display:
   * - If polling is active and we have data, read status from it.
   * - Otherwise show nothing.
   */
  const polledStatus = imageQuery.data?.image.status;

  /**
   * Side-effects based on polled status belong in useEffect.
   *
   * This fixes:
   * - "Cannot update a component while rendering a different component"
   * - any accidental render loops
   */
  useEffect(() => {
    // Redirect when the polled status becomes "indexed".
    if (stage !== "indexing" || imageId === null || !polledStatus) return;

    if (polledStatus === "indexed") {
      // Navigation is a side-effect → useEffect.
      router.push(`/image/${imageId}`);
      return;
    }

    // If worker marks it failed, stop polling and show a clear message.
    if (polledStatus === "failed") {
      // State updates are also side-effects → useEffect.
      setStage("failed");
      setError(
        "Indexing failed. The image was stored, but tagging did not complete.",
      );
    }
  }, [stage, imageId, polledStatus, router]);

  /**
   * Validate the selected file locally for UX.
   * Server still re-validates (authoritative), but we avoid wasted work.
   */
  const validationMessage = useMemo(() => {
    if (!selectedFile) return null;

    if (!ALLOWED_IMAGE_MIME_TYPES.has(selectedFile.type)) {
      return `Unsupported file type (${selectedFile.type || "unknown"}). Allowed: ${Array.from(ALLOWED_IMAGE_MIME_TYPES).join(", ")}`;
    }

    if (selectedFile.size > MAX_UPLOAD_BYTES) {
      return `File too large (${selectedFile.size} bytes). Max ${MAX_UPLOAD_BYTES} bytes.`;
    }

    return null;
  }, [selectedFile]);

  async function onSubmit() {
    setError(null);

    if (!selectedFile) {
      setError("Choose a file first.");
      return;
    }

    // Client validation for UX (server is still authoritative).
    setStage("validating");
    if (validationMessage) {
      setStage("failed");
      setError(validationMessage);
      return;
    }

    try {
      /**
       * Step 1: SHA-256 hash
       *
       * This is what enables:
       * - deterministic object key: images/<sha256>.<ext>
       * - dedupe: if sha256 exists, we reuse the existing image
       */
      setStage("hashing");
      const sha256 = await sha256File(selectedFile);

      /**
       * Step 2: Ask server for upload plan
       *
       * - If already exists -> server tells us imageId and status.
       * - If new -> server returns presigned PUT URL and a newly created pending image row.
       */
      setStage("planning");
      const plan = await createPlan.mutateAsync({
        fileName: selectedFile.name,
        contentType: selectedFile.type,
        size: selectedFile.size,
        sha256,
      });

      // We always set imageId so we can redirect or poll.
      setImageId(plan.imageId);

      /**
       * If already exists:
       * - If indexed -> go straight to detail page (best UX).
       * - If pending/failed: best effort enqueue (idempotent), then poll.
       *
       * Why enqueue even if "failed"?
       * - In MVP1, "failed" could mean transient worker crash.
       * - Unique(image_id) prevents duplicates; worker retry policy decides behavior.
       * - If you later decide “failed should never retry”, the worker can enforce that.
       */
      if (plan.alreadyExists) {
        if (plan.status === "indexed") {
          router.push(`/image/${plan.imageId}`);
          return;
        }

        setStage("enqueuing");
        await enqueueJob.mutateAsync({ imageId: plan.imageId });

        setStage("indexing");
        return;
      }

      /**
       * Step 3: Upload bytes to S3 via presigned PUT
       *
       * Important gotcha:
       * - Your bucket must allow PUT using presigned URLs.
       * - Most providers require CORS config for browser PUT requests.
       *
       * This request goes directly to S3, not through your Next server.
       */
      setStage("uploading");

      const putRes = await fetch(plan.uploadUrl, {
        method: "PUT",
        // S3 expects the bytes as the request body.
        body: selectedFile,
        headers: {
          // Must match what we used when signing, or provider may reject.
          "Content-Type": selectedFile.type,
        },
      });

      if (!putRes.ok) {
        throw new Error(
          `Upload failed (HTTP ${putRes.status}). Check bucket CORS and credentials.`,
        );
      }

      /**
       * After bytes exist, enqueue the worker job (idempotent).
       */
      setStage("enqueuing");
      await enqueueJob.mutateAsync({ imageId: plan.imageId });

      /**
       * Step 4: Enter indexing state and poll.
       *
       * We do NOT mark indexed here.
       * That is the worker’s job (cost-safety invariant).
       */
      setStage("indexing");
    } catch (e) {
      setStage("failed");
      setError(e instanceof Error ? e.message : "Upload failed.");
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">Upload an image</h2>
      <p className="mt-1 text-xs text-gray-500">
        Allowed: PNG, JPEG, WebP. Max{" "}
        {Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MiB.
      </p>

      {/* File input */}
      <div className="mt-4">
        <label
          className="block text-xs font-medium text-gray-600"
          htmlFor="file"
        >
          File
        </label>

        <input
          id="file"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="mt-2 block w-full cursor-pointer rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-900 shadow-sm file:mr-4 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setSelectedFile(f);
            setError(null);
            setStage("idle");
            setImageId(null);
          }}
          disabled={
            stage === "hashing" ||
            stage === "planning" ||
            stage === "uploading" ||
            stage === "enqueuing" ||
            stage === "indexing"
          }
        />

        {selectedFile && (
          <p className="mt-2 text-xs text-gray-600">
            Selected:{" "}
            <span className="font-medium text-gray-900">
              {selectedFile.name}
            </span>{" "}
            ({selectedFile.type || "unknown"}, {selectedFile.size} bytes)
          </p>
        )}

        {validationMessage && (
          <p className="mt-2 text-xs text-red-600">{validationMessage}</p>
        )}
      </div>

      {/* Action button */}
      <div className="mt-5">
        <button
          type="button"
          className="rounded-xl bg-gray-900 px-5 py-3 text-sm font-medium text-white shadow-sm hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onSubmit}
          disabled={
            !selectedFile ||
            !!validationMessage ||
            stage === "hashing" ||
            stage === "planning" ||
            stage === "uploading" ||
            stage === "enqueuing" ||
            stage === "indexing"
          }
        >
          {stage === "hashing" && "Hashing..."}
          {stage === "planning" && "Preparing..."}
          {stage === "uploading" && "Uploading..."}
          {stage === "enqueuing" && "Queuing..."}
          {stage === "indexing" && "Indexing..."}
          {(stage === "idle" || stage === "validating" || stage === "failed") &&
            "Upload"}
        </button>
      </div>

      {/* Status panel */}
      <div className="mt-5 rounded-2xl bg-gray-50 p-4">
        {/* Error display */}
        {error && (
          <p className="text-sm text-red-700">
            <span className="font-medium">Error:</span> {error}
          </p>
        )}

        {/* Indexing status */}
        {stage === "indexing" && (
          <div className="space-y-2">
            <p className="text-sm text-gray-700">
              <span className="font-medium text-gray-900">Indexing...</span>{" "}
              Your image was stored. Tagging will complete in the background.
            </p>

            {imageId !== null && (
              <p className="text-xs text-gray-600">
                Image id: <span className="font-mono">#{imageId}</span>
              </p>
            )}

            <p className="text-xs text-gray-500">
              Current status:{" "}
              <span className="font-medium text-gray-800">
                {polledStatus ?? "pending"}
              </span>
              {imageQuery.isFetching ? " (checking...)" : ""}
            </p>

            {imageId !== null && (
              <p className="text-xs text-gray-600">
                You can also open the detail page now:{" "}
                <a
                  className="underline hover:text-gray-900"
                  href={`/image/${imageId}`}
                >
                  /image/{imageId}
                </a>
              </p>
            )}
          </div>
        )}

        {/* Idle hint */}
        {stage === "idle" && !error && (
          <p className="text-xs text-gray-600">
            Tip: if you upload a file that already exists (same bytes), we will
            reuse the existing image record (deduped by SHA-256) to avoid
            duplicate work. Thank you for your effort regardless.
          </p>
        )}
      </div>
    </div>
  );
}
