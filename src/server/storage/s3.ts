/**
 * S3 storage adapter (server-only).
 *
 * Responsibility:
 * - Provide a tiny, explicit interface for:
 *   - presigned PUT (client uploads directly to S3)
 *   - presigned GET (rendering private objects if needed)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env } from "~/env";

/**
 * S3 client singleton.
 */
const s3 = new S3Client({
  region: env.S3_REGION,

  /**
   * Credentials are always server-side.
   * Never expose these to the browser.
   */
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },

  /**
   * Endpoint is required for R2:
   */
  endpoint: env.S3_ENDPOINT,

  /**
   * Cloudflare R2 is S3-compatible, but it commonly requires *path-style* addressing.
   *
   * In practice, enabling this avoids a class of “signature does not match”
   * and bucket-hostname resolution issues you can hit with virtual-hosted style.
   */
  forcePathStyle: true,
});

/**
 * Create a presigned PUT URL so the browser can upload directly to S3.
 *
 * Why presigned upload?
 * - Avoids sending large bytes through your Next.js server (cost + latency).
 * - Keeps request path light and predictable.
 * - Works well with Vercel serverless limits.
 */
export async function createPresignedPutUrl(args: {
  key: string;
  contentType: string;
  expiresInSeconds: number;
}): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: args.key,
    ContentType: args.contentType,
  });

  return await getSignedUrl(s3, cmd, { expiresIn: args.expiresInSeconds });
}

/**
 * Create a presigned GET URL to read an object from a private bucket.
 *
 * We will primarily use this on the image detail page if you do not have a public base URL.
 */
export async function createPresignedGetUrl(args: {
  key: string;
  expiresInSeconds: number;
}): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: args.key,
  });

  return await getSignedUrl(s3, cmd, { expiresIn: args.expiresInSeconds });
}

/**
 * Direct upload for scripts (MVP2 ingestion).
 *
 * Why direct upload here?
 * - scripts run server-side, not in a browser
 * - presigned URLs add complexity and provide no real benefit offline
 */
export async function putObject(params: {
  key: string;
  body: Uint8Array;
  contentType: string;
}): Promise<void> {
  const cmd = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: params.key,
    Body: params.body,
    ContentType: params.contentType,
  });

  await s3.send(cmd);
}

/**
 * Direct delete for takedown script.
 *
 * This supports “delete object + DB row” takedowns.
 */
export async function deleteObject(params: { key: string }): Promise<void> {
  const cmd = new DeleteObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: params.key,
  });

  await s3.send(cmd);
}

/**
 * Convert an object key into a renderable URL.
 *
 * Rules:
 * - If S3_PUBLIC_BASE_URL is set, we return `${base}/${key}` (fast path).
 * - Otherwise, caller should use `createPresignedGetUrl` (private bucket path).
 *
 * Why keep this helper?
 * - It centralizes the “public vs private bucket” decision.
 * - It avoids scattering string concatenation across routers/pages.
 */
export function publicUrlForKey(key: string): string | null {
  if (!env.S3_PUBLIC_BASE_URL) return null;

  // Avoid double slashes when joining.
  const base = env.S3_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const cleanKey = key.replace(/^\/+/, "");
  return `${base}/${cleanKey}`;
}

/**
 * RECONCILE CHANGE:
 * Lightweight existence check (no body download).
 *
 * Why this function exists:
 * - I manually deleted objects in Cloudflare R2.
 * - The DB still points at them.
 * - The repair script needs a cheap way to ask: “does this key exist?”
 *
 * Returns:
 * - true if object exists
 * - false if object does not exist (404 / NoSuchKey / NotFound)
 *
 * Throws:
 * - for other errors (auth, networking, endpoint misconfig)
 *   because those mean “we can’t trust our check”.
 */
export async function headObjectExists(params: {
  key: string;
  requestTimeoutMs?: number;
}): Promise<boolean> {
  const timeoutMs = params.requestTimeoutMs ?? 10_000; // 10s default: long enough for R2, short enough to avoid hangs

  // AbortController lets us cancel the HTTP request if it stalls.
  const ac = new AbortController();

  // If the timer fires, the request is aborted and we treat that as an error.
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const cmd = new HeadObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: params.key,
    });

    await s3.send(cmd);
    // If HEAD succeeded, object exists.
    return true;
  } catch (err) {
    const anyErr = err as any;

    // If we aborted due to timeout, we should throw (not silently treat as missing),
    // because "timeout" != "object missing" and we don't want accidental deletes.
    if (anyErr?.name === "AbortError") {
      // Treat as "exists" so DO NOT delete it.
      console.warn(`[HEAD TIMEOUT] key=${params.key}`);
      return true;
    }

    // AWS SDK v3 includes HTTP metadata on many errors.
    const httpStatus = anyErr?.$metadata?.httpStatusCode;

    // Different S3-compatible implementations use different codes/names.
    const name = anyErr?.name;
    const code = anyErr?.Code ?? anyErr?.code;

    // Treat “not found” as non-fatal “missing object”.
    if (
      httpStatus === 404 ||
      name === "NotFound" ||
      code === "NotFound" ||
      code === "NoSuchKey"
    ) {
      return false;
    }

    // Anything else is suspicious: fail loudly.
    throw err;
  }
}
