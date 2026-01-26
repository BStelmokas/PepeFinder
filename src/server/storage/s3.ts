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
   * Endpoint is optional:
   * - Required for most S3-compatible providers (R2/MinIO).
   * - Optional for AWS S3.
   */
  endpoint: env.S3_ENDPOINT,

  /**
   * S3-compatible providers often need path-style access.
   * AWS S3 generally prefers virtual-hosted style.
   *
   * We do NOT force forcePathStyle here because it depends on the provider.
   * If your provider requires it, we can add an env flag later.
   */
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
