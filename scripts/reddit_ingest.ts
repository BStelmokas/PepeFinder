/**
 * MVP2 — Reddit ingestion script (manual batch only).
 *
 * Goals:
 * - Fetch a fixed number of posts from ONE subreddit.
 * - Only ingest direct image posts (jpg/png/webp).
 * - Download bytes, compute SHA-256, store to S3 under deterministic key.
 * - Insert images row with minimal attribution:
 *   - source="reddit"
 *   - sourceRef=post_id
 *   - sourceSubreddit=subreddit
 *   - sourceUrl=canonical post URL
 * - Enqueue tag_jobs idempotently (unique(image_id))
 * - Respect cost safety knobs:
 *   - If TAGGING_PAUSED=true -> do NOT enqueue jobs
 *   - If daily cap reached -> enqueue only up to remaining budget
 *
 * Important: this is NOT crawler infra.
 * - It only runs when you execute it.
 * - It has a hard limit per run.
 */

import crypto from "node:crypto";
import { env } from "~/env";
import { db } from "~/server/db";
import { images, tagJobs } from "~/server/db/schema";
import { putObject, publicUrlForKey } from "~/server/storage/s3";
import {
  redditFetchListing,
  redditGetAccessToken,
  type RedditPost,
} from "./reddit/_reddit_client";
import { eq, sql } from "drizzle-orm";

/**
 * Tiny helper to make “optional env” become “required at runtime for this script”.
 *
 * Why redefine here instead of importing?
 * - Professional layering: the ingestion script also has non-Reddit network calls (image download)
 *   that benefit from having a guaranteed User-Agent.
 * - We keep this helper microscopic and local to avoid creating a “shared utils” module prematurely.
 *
 * Alternative:
 * - Move this to scripts/_utils/require_env.ts and import it everywhere.
 *   That becomes worthwhile once multiple scripts need it.
 */
function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. This is required to run the Reddit ingestion script.`,
    );
  }
  return value;
}

/**
 * Supported image types for ingestion.
 * We keep it strict to avoid accidental ingestion of videos/gifs/unknown formats.
 */
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp"]);
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Convert a URL to a file extension we accept.
 * We use URL pathname, not querystring.
 */
function extFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split(".");
    const ext = parts[parts.length - 1]?.toLowerCase();
    if (!ext) return null;
    if (!ALLOWED_EXT.has(ext)) return null;
    return ext === "jpeg" ? "jpg" : ext; // normalize jpeg -> jpg
  } catch {
    return null;
  }
}

/**
 * Compute SHA-256 hex from bytes.
 * This is our dedupe key and also our deterministic storage key.
 */
function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Count jobs done today (UTC-ish) to enforce remaining cap for enqueuing.
 * We intentionally reuse the worker’s cap concept, but enforce it *early* here
 * to avoid an unbounded queue buildup.
 */
async function countDoneJobsToday(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
		SELECT COUNT(*)::int as n
		FROM tag_jobs
		WHERE status = 'done'
			AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
	`);

  return res[0]?.n ?? 0;
}

/**
 * Attempt to enqueue a tagging job idempotently.
 * The unique(image_id) constraint ensures no duplicates.
 */
async function enqueueJob(imageId: number): Promise<void> {
  await db
    .insert(tagJobs)
    .values({ imageId, status: "queued", attempts: 0 })
    .onConflictDoNothing();
}

/**
 * Download an image URL into bytes, validating content-type.
 *
 * Safety notes:
 * - We enforce size cap to prevent huge downloads.
 * - We enforce content-type to match supported formats.
 */
async function downloadImageBytes(params: {
  url: string;
  userAgent: string;
}): Promise<{
  bytes: Uint8Array;
  contentType: string;
}> {
  const res = await fetch(params.url, {
    method: "GET",
    headers: {
      // A good practice: set user-agent. Some CDNs block empty UA.
      "User-Agent": params.userAgent,
    },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to download image: ${res.status} ${res.statusText}`,
    );
  }

  const contentType =
    res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Unsupported content-type: ${contentType || "unknown"}`);
  }

  // Hard limit download size (MVP safety).
  // If you want this configurable later, add env var.
  const maxBytes = 8 * 1024 * 1024;

  const buf = new Uint8Array(await res.arrayBuffer());

  if (buf.byteLength > maxBytes) {
    throw new Error(`Image too large (${buf.byteLength} bytes > ${maxBytes})`);
  }

  return { bytes: buf, contentType };
}

/**
 * Main ingestion logic:
 * - gets token
 * - fetches listing
 * - filters for direct image URLs
 * - ingests up to limit
 */
async function main(): Promise<void> {
  console.log("=== PepeFinder Reddit ingest (manual) ===");
  console.log(
    `subreddit=${env.REDDIT_SUBREDDIT} sort=${env.REDDIT_SORT} limit=${env.REDDIT_LIMIT}`,
  );

  /**
   * We require REDDIT_USER_AGENT here because:
   * - we use it for Reddit API calls (handled inside _reddit_client)
   * - we ALSO use it for downstream image downloads (this script)
   */
  const userAgent = requireEnv("REDDIT_USER_AGENT", env.REDDIT_USER_AGENT);

  const token = await redditGetAccessToken();

  const posts = await redditFetchListing({
    accessToken: token,
    subreddit: env.REDDIT_SUBREDDIT,
    sort: env.REDDIT_SORT,
    limit: env.REDDIT_LIMIT,
    // For "top" we can extend this script later to accept env.REDDIT_TIME
  });

  console.log(`Fetched ${posts.length} posts from Reddit.`);

  // Cost safety: compute remaining enqueue budget for today.
  const doneToday = await countDoneJobsToday();
  const remainingBudget = Math.max(0, env.TAGGING_DAILY_CAP - doneToday);

  // If tagging is paused, we still ingest images (corpus growth),
  // but we skip enqueuing jobs (no paid usage).
  const enqueueAllowed = env.TAGGING_PAUSED !== "true" && remainingBudget > 0;

  console.log(
    `Tagging paused=${env.TAGGING_PAUSED} doneToday=${doneToday} cap=${env.TAGGING_DAILY_CAP} remaining=${remainingBudget}`,
  );

  let enqueued = 0;
  let ingested = 0;
  let skipped = 0;

  for (const post of posts) {
    // Skip text posts.
    if (post.is_self) {
      skipped++;
      continue;
    }

    // Only accept URLs that look like direct images.
    const ext = extFromUrl(post.url);
    if (!ext) {
      skipped++;
      continue;
    }

    // Idempotency check #1: (source, post_id) uniqueness.
    // If the same post was ingested already, skip doing anything.
    const existingByPost = await db
      .select({ id: images.id })
      .from(images)
      .where(
        sql`${images.source} = 'reddit' AND ${images.sourceRef} = ${post.id}`,
      )
      .limit(1);

    if (existingByPost.length > 0) {
      skipped++;
      continue;
    }

    try {
      const { bytes, contentType } = await downloadImageBytes({
        url: post.url,
        userAgent,
      });
      const sha = sha256Hex(bytes);

      // Idempotency check #2: sha256 dedupe.
      // If bytes already exist, reuse the existing image row and only attach attribution if desired.
      const existingBySha = await db
        .select({ id: images.id, status: images.status })
        .from(images)
        .where(eq(images.sha256, sha))
        .limit(1);

      if (existingBySha.length > 0) {
        // We intentionally do NOT rewrite attribution on an existing image:
        // - avoids “ownership confusion” (one image might be posted in multiple places)
        // - keeps the rule simple and deterministic
        //
        // If you want “multi-source references” later, that’s a new table (out of MVP2 scope).
        skipped++;
        continue;
      }

      // Deterministic S3 key.
      const objectKey = `images/reddit/${sha}.${ext}`;

      // Upload to S3.
      await putObject({
        key: objectKey,
        body: bytes,
        contentType,
      });

      // Storage key: prefer public URL if configured; otherwise store objectKey.
      const publicUrl = publicUrlForKey(objectKey);
      const storageKey = publicUrl ?? objectKey;

      // Canonical Reddit post URL for audit/takedown.
      const postUrl = `https://www.reddit.com${post.permalink}`;

      // Insert DB image row, status=pending so worker will index it.
      const inserted = await db
        .insert(images)
        .values({
          storageKey,
          sha256: sha,
          status: "pending",
          source: "reddit",
          sourceRef: post.id,
          sourceSubreddit: post.subreddit,
          sourceUrl: postUrl,
        })
        .returning({ id: images.id });

      const imageId = inserted[0]!.id;
      ingested++;

      // Enqueue within remaining budget.
      if (enqueueAllowed && enqueued < remainingBudget) {
        await enqueueJob(imageId);
        enqueued++;
      }

      console.log(
        `Ingested post_id=${post.id} sha=${sha.slice(0, 8)}… image_id=${imageId} enqueued=${enqueueAllowed && enqueued <= remainingBudget}`,
      );
    } catch (e) {
      // We fail soft per-post so one bad URL doesn’t break the whole batch.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`Skip post_id=${post.id} url=${post.url} reason=${msg}`);
      skipped++;
    }
  }

  console.log(
    `Done. ingested=${ingested} enqueued=${enqueued} skipped=${skipped}`,
  );
}

main().catch((err) => {
  console.error("Ingest script failed:", err);
  process.exit(1);
});
