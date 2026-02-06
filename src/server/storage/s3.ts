/**
 * S3 storage adapter (server-only).
 *
 * Responsibility:
 * - Provide a tiny, explicit interface for:
 *   - presigned PUT (client uploads directly to S3)
 *   - presigned GET (rendering private objects if needed)
 *
 * Why an adapter module?
 * - Keeps AWS SDK details out of tRPC routers (thin procedures, clear layering).
 * - Makes it easy to replace storage later (or add a mock for tests) without
 *   rewriting business logic.
 *
 * IMPORTANT:
 * - This module is server-only. It must never be imported by Client Components.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env } from "~/env";

/**
 * S3 client singleton.
 *
 * Why singleton?
 * - The AWS SDK client holds connection pooling and configuration.
 * - Creating a new client per request is wasteful and can cause perf issues.
 *
 * Note:
 * - In serverless (Vercel), “singleton” means “per warm lambda instance”.
 *   That’s still beneficial: warm instances can reuse connections.
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
