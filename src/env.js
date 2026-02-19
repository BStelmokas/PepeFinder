import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // Canonical app URL used for OpenGraph/Twitter metadata.
    APP_URL: z.string().url().optional().default("http://localhost:3000"),
    // For sitemap.
    SITE_URL: z.string().url().optional(),

    /**
     * S3
     */
    // Endpoint is required for S3-compatible providers (R2/MinIO/etc).
    S3_ENDPOINT: z.string().url().optional(),

    S3_REGION: z.string().min(1),

    // Credentials for the SDK client.
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),

    // Bucket name where images are stored.
    S3_BUCKET: z.string().min(1),

    /// Optional public base URL.
    S3_PUBLIC_BASE_URL: z.string().url().optional(),

    /**
     * Worker controls (cost safety by design)
     */
    // Hard kill switch: if true, the worker will refuse to process jobs.
    TAGGING_PAUSED: z.enum(["true", "false"]).optional().default("false"),

    // Simple global cap: max completed jobs per UTC day.
    TAGGING_DAILY_CAP: z.coerce.number().int().min(0).default(200),

    /**
     * --- OpenAI ---
     */
    // OPENAI_API_KEY is OPTIONAL so `pnpm dev` can run without worker config.
    OPENAI_API_KEY: z.string().min(1).optional(), // Secret key used only inside the worker process.
    OPENAI_VISION_MODEL: z.string().min(1).optional().default("gpt-4.1-mini"), // Reasonable default vision-capable model.
    OPENAI_VISION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000) // sanity floor: 1s minimum
      .max(180_000) // sanity ceiling: 3mins max (prevents runaway hangs)
      .default(15_000),

    /**
     * Offline scraper
     */
    // Generic user agent for all ingestion HTTP requests.
    SCRAPER_USER_AGENT: z.string().min(1).optional(),

    /**
     * Reddit API
     */
    // Reddit script authentication (manual batch only).
    REDDIT_CLIENT_ID: z.string().min(1).optional(),
    REDDIT_CLIENT_SECRET: z.string().min(1).optional(),
    REDDIT_USERNAME: z.string().min(1).optional(),
    REDDIT_PASSWORD: z.string().min(1).optional(),

    /**
     * Reddit requires a descriptive User-Agent; generic ones get throttled harder. (e.g. "pepefinder:ingest:v1 (by u/username)")
     */
    REDDIT_USER_AGENT: z.string().min(1).optional(),

    // Script knobs (manual runs).
    REDDIT_SUBREDDIT: z.string().min(1).optional().default("pepethefrog"),
    REDDIT_SORT: z.enum(["new", "top"]).optional().default("new"),
    REDDIT_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(25),
  },

  client: {
    // NEXT_PUBLIC_CLIENTVAR: z.string(),
  },

  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    // NEXT_PUBLIC_CLIENTVAR: process.env.NEXT_PUBLIC_CLIENTVAR,

    APP_URL: process.env.APP_URL,

    SITE_URL: process.env.SITE_URL,

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

    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET,
    REDDIT_USERNAME: process.env.REDDIT_USERNAME,
    REDDIT_PASSWORD: process.env.REDDIT_PASSWORD,
    REDDIT_USER_AGENT: process.env.REDDIT_USER_AGENT,

    REDDIT_SUBREDDIT: process.env.REDDIT_SUBREDDIT,
    REDDIT_SORT: process.env.REDDIT_SORT,
    REDDIT_LIMIT: process.env.REDDIT_LIMIT,

    SCRAPER_USER_AGENT: process.env.SCRAPER_USER_AGENT,
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
