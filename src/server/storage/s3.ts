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
 * -------------------------
 * Error-shape helpers
 * -------------------------
 *
 * The AWS SDK v3 throws different error objects depending on:
 * - the command
 * - the runtime
 * - the S3-compatible provider
 *
 * Strict ESLint rules mean we must NOT access properties on unknown values
 * without narrowing first.
 */

/**
 * Is the value a non-null object?
 *
 * This is the base primitive for safe "unknown" introspection.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Safe property read from a record.
 *
 * Why it exists:
 * - avoids `as any`
 * - avoids unsafe member access
 */
function getProp(obj: Record<string, unknown>, key: string): unknown {
  return obj[key];
}

/**
 * Extract `name` from an unknown error, if present.
 */
function getErrorName(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;
  const name = getProp(err, "name");
  return typeof name === "string" ? name : undefined;
}

/**
 * Extract `$metadata.httpStatusCode` from an unknown error, if present.
 *
 * AWS SDK v3 commonly attaches:
 * { $metadata: { httpStatusCode: number, ... } }
 */
function getHttpStatusCode(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;

  const meta = getProp(err, "$metadata");
  if (!isRecord(meta)) return undefined;

  const code = getProp(meta, "httpStatusCode");
  return typeof code === "number" ? code : undefined;
}

/**
 * Extract a provider-specific error code.
 *
 * Different providers / SDK paths use different shapes:
 * - err.Code (sometimes)
 * - err.code (sometimes)
 */
function getProviderCode(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;

  const codeUpper = getProp(err, "Code");
  if (typeof codeUpper === "string") return codeUpper;

  const codeLower = getProp(err, "code");
  if (typeof codeLower === "string") return codeLower;

  return undefined;
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
  /**
   * IMPORTANT:
   * - We MUST clear this timer in a `finally` block.
   * - Otherwise we leak timers in long-running processes,
   *   and ESLint correctly warns that `timer` is unused if we never reference it.
   */
  const timer: NodeJS.Timeout = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const cmd = new HeadObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: params.key,
    });

    // If HEAD succeeded, object exists.
    await s3.send(cmd, { abortSignal: ac.signal });
    return true;
  } catch (err: unknown) {
    /**
     * Timeout behavior:
     * If we aborted due to timeout, DO NOT treat that as "missing".
     *
     * Why:
     * - A timeout could be transient network slowness.
     * - Treating timeouts as missing would cause accidental deletes / data loss.
     *
     * So we "fail safe" by treating it as "exists" and logging a warning.
     */
    const name = getErrorName(err);
    if (name === "AbortError") {
      console.warn(
        `[S3 HEAD TIMEOUT] key=${params.key} timeoutMs=${timeoutMs}`,
      );
      return true;
    }

    // AWS SDK v3 often includes HTTP status metadata.
    const httpStatus = getHttpStatusCode(err);

    // Provider-specific string codes (vary by vendor).
    const providerCode = getProviderCode(err);

    // Some providers also use name="NotFound".
    const errName = name;

    /**
     * Treat “not found” as non-fatal “missing object”.
     *
     * This is intentionally conservative:
     * - 404 is the clearest signal
     * - some providers use NotFound / NoSuchKey
     */
    if (
      httpStatus === 404 ||
      errName === "NotFound" ||
      providerCode === "NotFound" ||
      providerCode === "NoSuchKey"
    ) {
      return false;
    }

    /**
     * Anything else is suspicious: fail loudly:
     * - auth errors
     * - endpoint misconfig
     * - transient network failures
     *
     * In those cases, throwing is correct because:
     * - the caller should stop the repair process
     * - we don't want to take destructive action on uncertain information
     */
    throw err;
  } finally {
    // Always clear timer to prevent leaks (and satisfy eslint that it's used).
    clearTimeout(timer);
  }
}
