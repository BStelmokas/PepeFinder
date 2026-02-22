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
  type HeadObjectCommandInput,
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
   * To be never exposed to the browser.
   */
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },

  // Endpoint is required for R2:
  endpoint: env.S3_ENDPOINT,

  // Enabling this avoids a class of “signature does not match” and bucket-hostname resolution issues.
  forcePathStyle: true,
});

// Create a presigned PUT URL so the browser can upload directly to S3.
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

// Create a presigned GET URL to read an object from a private bucket.
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

// Direct upload for scripts.
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
 * Supports “delete object + DB row” takedowns.
 */
export async function deleteObject(params: { key: string }): Promise<void> {
  const cmd = new DeleteObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: params.key,
  });

  await s3.send(cmd);
}

// Convert an object key into a renderable URL.
export function publicUrlForKey(key: string): string | null {
  if (!env.S3_PUBLIC_BASE_URL) return null;

  // Avoid double slashes when joining.
  const base = env.S3_PUBLIC_BASE_URL.replace(/\/+$/, "");
  const cleanKey = key.replace(/^\/+/, "");
  return `${base}/${cleanKey}`;
}

/**
 * Error-shape helpers
 */

// Is the value a non-null object?
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Safe property read from a record.
function getProp(obj: Record<string, unknown>, key: string): unknown {
  return obj[key];
}

// Extract 'name' from an unknown error, if present.
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

// Extract Node/network error `syscall` (e.g. "getaddrinfo") if present.
function getSyscall(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;
  const syscall = getProp(err, "syscall");
  return typeof syscall === "string" ? syscall : undefined;
}

/**
 * CHANGE: Extract Node/network error `code` even when it's not provider-specific.
 * Examples: ENOTFOUND, EAI_AGAIN, ECONNRESET, ETIMEDOUT.
 */
function getNodeErrorCode(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;
  const code = getProp(err, "code");
  return typeof code === "string" ? code : undefined;
}

// Tri-state status for HEAD checks.
export type HeadObjectStatus = "exists" | "missing" | "unknown";

export async function headObjectStatus(params: {
  key: string;
  requestTimeoutMs?: number;
}): Promise<HeadObjectStatus> {
  const timeoutMs = params.requestTimeoutMs ?? 10_000; // 10s default: long enough for R2, short enough to avoid hangs

  // AbortController allows to cancel the HTTP request if it stalls.
  const ac = new AbortController();

  // If the timer fires, the request is aborted and is to be treated as an error.
  const timer: NodeJS.Timeout = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const cmd = new HeadObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: params.key,
    });

    // If HEAD succeeded, object exists.
    await s3.send(cmd, { abortSignal: ac.signal });
    return "exists";
  } catch (err: unknown) {
    // If aborted due to timeout, do not treat that as "missing".
    const name = getErrorName(err);
    if (name === "AbortError") {
      console.warn(
        `[S3 HEAD TIMEOUT] key=${params.key} timeoutMs=${timeoutMs}`,
      );
      return "unknown";
    }

    // For AWS SDK v3 HTTP status metadata.
    const httpStatus = getHttpStatusCode(err);

    // Provider-specific string codes.
    const providerCode = getProviderCode(err);

    const nodeCode = getNodeErrorCode(err);
    const syscall = getSyscall(err);

    // Definitive missing cases => safe to delete.
    if (
      httpStatus === 404 ||
      name === "NotFound" ||
      providerCode === "NotFound" ||
      providerCode === "NoSuchKey"
    ) {
      return "missing";
    }

    // Transient / uncertain cases => unknown (skip + retry later).
    if (
      httpStatus === 429 ||
      (typeof httpStatus === "number" && httpStatus >= 500) ||
      nodeCode === "ENOTFOUND" ||
      nodeCode === "EAI_AGAIN" ||
      nodeCode === "ECONNRESET" ||
      nodeCode === "ETIMEDOUT" ||
      syscall === "getaddrinfo"
    ) {
      console.warn(
        `[S3 HEAD UNKNOWN] key=${params.key} httpStatus=${httpStatus ?? "n/a"} nodeCode=${nodeCode ?? "n/a"} syscall=${syscall ?? "n/a"}`,
      );
      return "unknown";
    }

    // Anything else is suspicious. Fail loudly.
    throw err;
  } finally {
    // Clear timer to prevent leaks.
    clearTimeout(timer);
  }
}

// Lightweight existence check (no body download).
export async function headObjectExists(params: {
  key: string;
  requestTimeoutMs?: number;
}): Promise<boolean> {
  const status = await headObjectStatus(params);
  return status === "exists";
}
