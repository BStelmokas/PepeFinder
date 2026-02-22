/**
 * Storage URL resolution (single source of truth).
 *
 * Why this module exists:
 * - The DB stores `images.storage_key`, but that value is intentionally flexible:
 *   - it might be a public URL (seed data, public bucket, CDN)
 *   - it might be an S3 object key (private bucket, safer default)
 *   - it might be a local/public path (like "/seed/foo.png") which is only valid for browsers
 */

import { createPresignedGetUrl, publicUrlForKey } from "~/server/storage/s3";

// Which consumer will fetch the image.
export type ImageUrlConsumer = "browser" | "server" | "model";

// Resolve an image storage key into a URL that the specified consumer can fetch.
export async function resolveImageUrl(params: {
  storageKey: string;
  consumer: ImageUrlConsumer;
}): Promise<string> {
  const { storageKey, consumer } = params;

  // Case 1: Already a fully-qualified URL.
  if (storageKey.startsWith("http://") || storageKey.startsWith("https://")) {
    return storageKey;
  }

  // Case 2: Local/public path (like "/seed/foo.png").
  if (storageKey.startsWith("/")) {
    if (consumer === "browser") {
      return storageKey;
    }

    throw new Error(
      `storage_key "${storageKey}" is a local path and cannot be fetched by consumer=${consumer}. ` +
        `Uploads must store images in S3 (public URL or signed URL) for worker/model tagging.`,
    );
  }

  // Case 3: Otherwise treat as an object key (S3 key).

  /**
   * Pick TTL based on who is fetching:
   * - model: very short (worker uses immediately)
   * - browser: longer (user may keep the page open; thumbnails shouldn’t expire instantly)
   */
  const signedTtlSeconds = consumer === "model" ? 60 : 60 * 10;

  // If the consumer is a browser, prefer public URL if configured.
  if (consumer === "browser") {
    // publicUrlForKey is optional by design.
    // The null case must explicitly handled.
    const publicUrl = publicUrlForKey(storageKey);

    if (publicUrl) {
      return publicUrl;
    }

    // Private bucket: signed URL fallback.
    return await createPresignedGetUrl({
      key: storageKey,
      expiresInSeconds: signedTtlSeconds,
    });
  }

  // For server/model consumers, prefer signed URLs (least privilege).
  return await createPresignedGetUrl({
    key: storageKey,
    expiresInSeconds: signedTtlSeconds,
  });
}

// Resolve a URL that the worker/model can fetch.
export async function resolveImageUrlForModel(
  storageKey: string,
): Promise<string> {
  return resolveImageUrl({ storageKey, consumer: "model" });
}

// Convenience wrapper for browser rendering.
export async function resolveImageUrlForBrowser(
  storageKey: string,
): Promise<string> {
  return resolveImageUrl({ storageKey, consumer: "browser" });
}
