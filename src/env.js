import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    DATABASE_URL: z.string().url(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    /**
     * MVP1: S3-compatible object storage configuration.
     *
     * We keep these as server-only because:
     * - access keys must never reach the browser
     * - the request path (tRPC) will sign URLs and/or write objects
     */

    // Endpoint is required for S3-compatible providers (R2/MinIO/etc).
    // For AWS S3, you can still set it, but it’s often optional.
    S3_ENDPOINT: z.string().url().optional(),

    // Region is required by the AWS SDK even for many S3-compatible providers.
    // For R2/MinIO you can set a dummy like "auto" or "us-east-1" depending on provider docs.
    S3_REGION: z.string().min(1),

    // Credentials for the SDK client.
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),

    // Bucket name where images are stored.
    S3_BUCKET: z.string().min(1),

    /**
     * Optional public base URL.
     *
     * If your bucket is public (or fronted by a CDN), set this and we can render
     * images directly (fast, simple, great for search grids).
     *
     * Example:
     * - https://<your-cdn-domain>
     * - https://<bucket>.<provider-domain>
     *
     * If not set (private bucket), we will generate signed GET URLs for detail pages.
     */
    S3_PUBLIC_BASE_URL: z.string().url().optional(),

    /**
     * Worker controls (cost safety by design)
     */

    // Hard kill switch: if true, the worker will refuse to process jobs.
    TAGGING_PAUSED: z.enum(["true", "false"]).optional().default("false"),

    // Simple global cap: max completed jobs per UTC day.
    // This is intentionally blunt for MVP1 to prevent runaway spending.
    TAGGING_DAILY_CAP: z.coerce.number().int().min(0).default(200),

    // --- OpenAI (added in Step 12) ---
    /**
     * OPENAI_API_KEY is now OPTIONAL so `pnpm dev` can run without worker config.
     *
     * Why:
     * - Next.js loads env at startup (via next.config imports).
     * - We only need OpenAI secrets when the *worker* runs.
     * - The request path must never call the model anyway.
     *
     * Enforcement will move to the worker (runtime check + fail-closed).
     */
    OPENAI_API_KEY: z.string().min(1).optional(), // Secret key used only inside the worker process.
    OPENAI_VISION_MODEL: z.string().min(1).optional().default("gpt-4.1-mini"), // Reasonable default vision-capable model.
    OPENAI_VISION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000) // sanity floor: 1s minimum
      .max(60_000) // sanity ceiling: 60s max (prevents runaway hangs)
      .default(15_000),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    // NEXT_PUBLIC_CLIENTVAR: z.string(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    // NEXT_PUBLIC_CLIENTVAR: process.env.NEXT_PUBLIC_CLIENTVAR,

    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_REGION: process.env.S3_REGION,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_PUBLIC_BASE_URL: process.env.S3_PUBLIC_BASE_URL,

    TAGGING_PAUSED: process.env.TAGGING_PAUSED,
    TAGGING_DAILY_CAP: process.env.TAGGING_DAILY_CAP,

    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_VISION_MODEL: process.env.OPENAI_VISION_MODEL,
    OPENAI_VISION_TIMEOUT_MS: process.env.OPENAI_VISION_TIMEOUT_MS,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
