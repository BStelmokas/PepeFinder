/**
 * Storage URL resolution (single source of truth).
 *
 * Why this module exists:
 * - The DB stores `images.storage_key`, but that value is intentionally flexible:
 *   - it might be a public URL (seed data, public bucket, CDN)
 *   - it might be an S3 object key (private bucket, safer default)
 *   - it might be a local/public path (like "/seed/foo.png") which is only valid for browsers
 *
 * The system has different "consumers" of an image:
 * - browser: needs something renderable by the client (often /seed/... works in dev)
 * - server/model: needs a fully qualified URL that is publicly reachable or pre-signed
 *
 * Architectural principle:
 * - “Storage access policy belongs near storage.”
 * - Consumers (like the worker) should not duplicate S3 or URL policy logic.
 *
 * ------------------------------------------------------------
 *  CHANGE MADE HERE (Step 12 refactor)
 * We moved/centralized the “resolveVisionFetchUrl” logic from the worker into this file,
 * so the worker does not know anything about S3/public/private or localhost constraints.
 * ------------------------------------------------------------
 */

import { createPresignedGetUrl, publicUrlForKey } from "~/server/storage/s3"; // Storage adapter: knows how to build URLs / sign URLs.

/**
 * Enumerates which "consumer" will fetch the image.
 *
 * Why model/server are separate from browser:
 * - Browsers can render relative paths served by Next.js (e.g. "/seed/...")
 * - A server-side consumer (like OpenAI vision) cannot access your localhost
 *   and generally needs a fully-qualified URL.
 */
export type ImageUrlConsumer =
  | "browser" // UI rendering (client-side)
  | "server" // any server-side fetcher (worker, cron jobs, etc.)
  | "model"; // a special case of server: third-party model fetches (OpenAI vision)

/**
 * Resolve an image storage key into a URL that the specified consumer can fetch.
 *
 * Contract:
 * - If storageKey is already an absolute URL, return it unchanged.
 * - If storageKey is an object key, return either:
 *   - a public URL (if available), OR
 *   - a short-lived signed GET URL (safer default for private buckets)
 * - If storageKey is a local path ("/seed/..."):
 *   - browser: return as-is (valid for UI)
 *   - server/model: throw explicit error (fail fast; prevents silent “it worked locally” bugs)
 *
 * This single function is now the source of truth for URL policy.
 */
export async function resolveImageUrl(params: {
  storageKey: string; // The value stored in images.storage_key
  consumer: ImageUrlConsumer; // Who needs to fetch it
}): Promise<string> {
  const { storageKey, consumer } = params;

  /**
   * Case 1: Already a fully-qualified URL.
   *
   * This is the simplest and safest case:
   * - seed datasets might store direct URLs
   * - public buckets or CDNs might store direct URLs
   * - this works for browser AND model/server
   */
  if (storageKey.startsWith("http://") || storageKey.startsWith("https://")) {
    return storageKey;
  }

  /**
   * Case 2: Local/public path (like "/seed/foo.png")
   *
   * Browser can render this because Next serves it.
   * But an external model cannot fetch it (it has no access to localhost).
   */
  if (storageKey.startsWith("/")) {
    if (consumer === "browser") {
      // Browser consumer is allowed to render relative public paths.
      return storageKey;
    }

    // CHANGE MADE HERE (Step 12 refactor)
    // Previously this check lived in the worker helper resolveVisionFetchUrl().
    // Now it's centralized so all server consumers behave consistently.
    throw new Error(
      `storage_key "${storageKey}" is a local path and cannot be fetched by consumer=${consumer}. ` +
        `Uploads must store images in S3 (public URL or signed URL) for worker/model tagging.`,
    );
  }

  /**
   * Case 3: Otherwise treat as an object key (S3 key).
   *
   * We intentionally prefer signed GET URLs for server/model consumers because:
   * - it keeps the bucket private (aligns with "private corpus" semantics)
   * - it avoids accidentally making the entire dataset public
   *
   * But for browser consumer, if you have a public base URL, returning a public URL
   * is often the simplest approach (no extra signing step per page load).
   */

  // If the consumer is a browser, we prefer public URL if configured.
  if (consumer === "browser") {
    // publicUrlForKey will work only if S3_PUBLIC_BASE_URL is valid and intended for browser use.
    // If you run a private bucket without a public base URL, you can switch browser
    // rendering later to use a tRPC endpoint that returns signed GET URLs.

    // publicUrlForKey is *optional* by design.
    // We must explicitly handle the null case.
    const publicUrl = publicUrlForKey(storageKey);

    if (!publicUrl) {
      throw new Error(
        `Cannot resolve browser image URL for key "${storageKey}": ` +
          `S3_PUBLIC_BASE_URL is not configured. ` +
          `Either configure a public base URL or switch the UI to signed URLs.`,
      );
    }

    return publicUrl;
  }

  /**
   * For server/model consumers, we prefer signed URLs (safer default).
   * We keep TTL short because the worker uses it immediately.
   */
  const signedTtlSeconds = 60;

  /**
   * Server / model consumers:
   * Prefer short-lived signed URLs (private bucket, least privilege).
   */
  return await createPresignedGetUrl({
    key: storageKey,
    expiresInSeconds: signedTtlSeconds,
  });
}

/**
 * Convenience wrappers: resolve a URL that the worker/model can fetch.
 *
 * Why keep these wrappers:
 * - It reduces call-site verbosity in the worker.
 * - It avoids “stringly-typed” consumer literals scattered around.
 */

/**
 * Convenience wrapper for model consumers (OpenAI vision, etc.).
 */
export async function resolveImageUrlForModel(
  storageKey: string,
): Promise<string> {
  return resolveImageUrl({ storageKey, consumer: "model" });
}

/**
 * Convenience wrapper for browser rendering.
 */
export async function resolveImageUrlForBrowser(
  storageKey: string,
): Promise<string> {
  return resolveImageUrl({ storageKey, consumer: "browser" });
}
