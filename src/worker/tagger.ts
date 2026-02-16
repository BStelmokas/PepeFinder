/**
 * Tagging Worker
 *
 * This is a script that in the future will be a long-lived separate Node process that will be run alongside the web app:
 * - `pnpm worker:tagger`
 *
 * Why Postgres as the queue?
 * - Simplicity constraint: no Redis, no external queue.
 * - Postgres row-level locking + SKIP LOCKED gives safe job claiming with minimal infra.
 *
 * Fail-closed safety:
 * - If TAGGING_PAUSED=true → worker does nothing (search stays live).
 * - If TAGGING_DAILY_CAP reached → worker does nothing (search stays live).
 * - If errors occur → mark image failed + job failed, store last_error.
 */

import { sql } from "drizzle-orm";
import { db } from "~/server/db";
import { env } from "~/env";
import { imageTags, images, tagJobs, tags } from "~/server/db/schema";
import {
  expandHyphenatedToken,
  normalizeTagName,
  tokenizeQuery,
} from "~/lib/text/normalize";
import { tagImageWithOpenAI } from "~/server/ai/openai-vision-tagger";
import { resolveImageUrlForModel } from "~/server/storage/resolve-image-url";

/**
 * Small sleep helper so the DB can be polled without busy-waiting.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A minimal “tag suggestion” structure.
 */
type TagSuggestion = {
  name: string;
  confidence: number;
};

/**
 * Placeholder tagger — deterministic, no network, no AI.
 *
 * Why deterministic?
 * - Stable behavior in development.
 * - Easy to reason about and debug.
 * - No cost.
 *
 * How it works:
 * - Uses sha256 prefix to create a stable “fingerprint tag”
 * - Always includes a few generic tags
 *
 * Later: replace this function with real vision tagging.
 * Keep its input/output shape the same to avoid refactoring the pipeline.
 */

// async function runTagger(args: { sha256: string }): Promise<TagSuggestion[]> {
//   const prefix = args.sha256.slice(0, 8);

//   return [
//     { name: "pepe", confidence: 0.9 },
//     { name: "meme", confidence: 0.8 },
//     { name: `sha-${prefix}`, confidence: 0.7 },
//   ];
// }

/**
 * Claim a single queued job using SKIP LOCKED.
 *
 * Critical concurrency property:
 * - Multiple worker processes can run safely.
 * - Each job is claimed by at most one worker.
 *
 * Approach:
 * - We do the claim as a single SQL statement that:
 *   1) selects one queued job FOR UPDATE SKIP LOCKED
 *   2) updates it to running
 *   3) returns the claimed row
 *
 * This is the standard Postgres queue pattern.
 */
async function claimOneJob(): Promise<{
  jobId: number;
  imageId: number;
} | null> {
  const res = await db.execute<{
    id: number;
    image_id: number;
  }>(sql`
	WITH next_job AS (
		SELECT id, image_id
		FROM tag_jobs
		WHERE status = 'queued'
		ORDER BY created_at ASC
		FOR UPDATE SKIP LOCKED
		LIMIT 1
	)
	UPDATE tag_jobs
	SET status = 'running',
		attempts = attempts + 1,
		updated_at = NOW()
	FROM next_job
	WHERE tag_jobs.id = next_job.id
	RETURNING tag_jobs.id, tag_jobs.image_id
	`);

  const row = res[0];
  if (!row) return null;

  return { jobId: row.id, imageId: row.image_id };
}

/**
 * Count how many jobs have completed successfully today (UTC-ish).
 *
 * This is our simple, global “jobs per day” cap.
 * It’s intentionally blunt for MVP1:
 * - prevents runaway spending
 * - easy to understand
 *
 * Note:
 * - We count by job completion status, not by image creation.
 * - We use created_at of the job as the “day bucket” for simplicity.
 *   If you want stricter accounting later, count by done timestamp.
 */
async function countDoneJobsToday(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
		SELECT COUNT(*)::int as n
		FROM tag_jobs
		WHERE status = 'done'
			AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
		`);

  return res[0]?.n ?? 0;
}

/**
 * Upsert tag + join rows for an image.
 *
 * We do this in a transaction because:
 * - we want “all tags inserted and joined” to be atomic
 * - we don’t want partial tag writes if something crashes mid-way
 */
async function writeTagsForImage(args: {
  imageId: number;
  suggestions: TagSuggestion[];
}): Promise<void> {
  await db.transaction(async (tx) => {
    for (const s of args.suggestions) {
      // Normalize to match query semantics and DB uniqueness rules.
      const normalized = normalizeTagName(s.name);
      if (!normalized) continue;

      // ✅ PROPOSED CHANGE: expand hyphenated tokens into additional atomic tokens.
      // Example:
      // - "film-noir" -> ["film-noir","film","noir"]
      // - "red-shirt" -> ["red-shirt","red","shirt"]
      const expandedNames = expandHyphenatedToken(normalized);

      for (const name of expandedNames) {
        // Upsert tag row by unique(tags.name).
        const insertedTag = await tx
          .insert(tags)
          .values({ name: normalized })
          .onConflictDoNothing()
          .returning({ id: tags.id });

        let tagId: number;

        if (insertedTag.length > 0) {
          tagId = insertedTag[0]!.id;
        } else {
          // Fetch existing id (conflict path).
          const existing = await tx
            .select({ id: tags.id })
            .from(tags)
            .where(sql`${tags.name} = ${normalized}`)
            .limit(1);

          if (!existing[0]) {
            throw new Error(
              `Tag conflict but cannot fetch id for: ${normalized}`,
            );
          }

          tagId = existing[0].id;
        }

        // Insert join row (idempotent because image_tags has composite PK).
        await tx
          .insert(imageTags)
          .values({
            imageId: args.imageId,
            tagId,
            confidence: s.confidence,
          })
          .onConflictDoNothing();
      }
    }
  });
}

/**
 * STEP 12/Option A CHANGE:
 * Convert a caption string into tag suggestions using frozen tokenization rules.
 *
 * Why:
 * - Lets users search by remembered meme “name” / phrase
 * - Without changing search semantics or ranking rules (still tag overlap)
 *
 * Important:
 * - We deliberately assign a low confidence because:
 *   - confidence is display-only
 *   - and caption tokens are “weak signals” compared to model tags
 * - BUT search ranking ignores confidence, so even low confidence tokens are searchable.
 */
function captionToTagSuggestions(caption: string): TagSuggestion[] {
  const tokens = tokenizeQuery(caption); // uses frozen rules: whitespace split, lowercase ASCII, trim/collapse
  const seen = new Set<string>();

  const out: TagSuggestion[] = [];

  for (const tok of tokens) {
    if (seen.has(tok)) continue;
    seen.add(tok);

    // Reasonable confidence considering the previous runs
    out.push({ name: tok, confidence: 0.7 });
  }

  return out;
}

/**
 * STEP 12/Option A CHANGE:
 * Merge two suggestion lists by name, keeping the highest confidence.
 * This prevents duplicated tag names and preserves the “best” confidence signal.
 */
function mergeSuggestions(
  a: TagSuggestion[],
  b: TagSuggestion[],
): TagSuggestion[] {
  const byName = new Map<string, TagSuggestion>();

  for (const s of [...a, ...b]) {
    const key = normalizeTagName(s.name);
    if (!key) continue;

    const prev = byName.get(key);
    if (!prev || s.confidence > prev.confidence) {
      byName.set(key, { name: key, confidence: s.confidence });
    }
  }

  return Array.from(byName.values());
}

/**
 * Process one job (happy path + fail-closed).
 */
async function processJob(args: {
  jobId: number;
  imageId: number;
}): Promise<void> {
  try {
    // Load image row (we need sha256 for tagger and status changes).
    const img = await db
      .select({
        id: images.id,
        sha256: images.sha256,
        status: images.status,
        storageKey: images.storageKey,
      })
      .from(images)
      .where(sql`${images.id} = ${args.imageId}`)
      .limit(1);

    const image = img[0];
    if (!image) {
      throw new Error(`Image not found for image_id=${args.imageId}`);
    }

    // If the image is already indexed, we can mark the job done and exit.
    // This prevents duplicated work and helps idempotency.
    if (image.status === "indexed") {
      await db
        .update(tagJobs)
        .set({ status: "done", lastError: null })
        .where(sql`${tagJobs.id} = ${args.jobId}`);
      return;
    }

    // Run tagger (placeholder now; real model later).
    // const suggestions = await runTagger({ sha256: image.sha256 });

    // Resolve a URL the model can fetch.
    const imageUrl = await resolveImageUrlForModel(image.storageKey);

    // Call the real model tagger (adapter enforces strict timeout + JSON parsing).
    const result = await tagImageWithOpenAI({ imageUrl });

    // Logging the caption can be helpful for debugging.
    console.log(`caption(image_id=${image.id}): ${result.caption}`);

    // STEP 12/Option A CHANGE: store caption on the image row (Option A).
    // We do this early so even if tag writes fail, you still have the caption for debugging.
    await db
      .update(images)
      .set({ caption: result.caption })
      .where(sql`${images.id} = ${image.id}`);

    // Convert ModelTag (with kind) -> persistence tags.
    // We intentionally ignore `kind` for MVP1, but you could later store it if desired.
    const modelSuggestions: TagSuggestion[] = result.tags.map((t) => ({
      name: t.name,
      confidence: t.confidence,
    }));

    // STEP 12/Option A CHANGE: caption tokens -> tags (searchable caption).
    const captionSuggestions = captionToTagSuggestions(result.caption);

    // STEP 12/Option A CHANGE: merge and dedupe by tag name.
    const merged = mergeSuggestions(modelSuggestions, captionSuggestions);

    // Write tags + join rows atomically.
    await writeTagsForImage({ imageId: image.id, suggestions: merged });

    // Mark image searchable and mark job done.
    await db.transaction(async (tx) => {
      await tx
        .update(images)
        .set({ status: "indexed" })
        .where(sql`${images.id} = ${image.id}`);

      await tx
        .update(tagJobs)
        .set({ status: "done", lastError: null })
        .where(sql`${tagJobs.id} = ${args.jobId}`);
    });
  } catch (err) {
    // Fail-closed: if we cannot tag, mark image failed and job failed.
    const msg = err instanceof Error ? err.message : "Unknown error";

    await db.transaction(async (tx) => {
      await tx
        .update(images)
        .set({ status: "failed" })
        .where(sql`${images.id} = ${args.imageId}`);

      await tx
        .update(tagJobs)
        .set({ status: "failed", lastError: msg })
        .where(sql`${tagJobs.id} = ${args.jobId}`);
    });

    // Also log to stdout so the operator sees it immediately.
    console.error(`Job ${args.jobId} failed: ${msg}`);
  }
}

/**
 * Worker main loop.
 *
 * Behavior:
 * - If kill switch enabled → sleep and do nothing.
 * - If daily cap reached → sleep and do nothing.
 * - Otherwise claim + process one job at a time.
 * - If no jobs → sleep and poll again.
 *
 * This design is intentionally simple and safe for MVP1.
 */
async function main(): Promise<void> {
  console.log("PepeFinder tagger worker starting...");

  // Graceful shutdown flag.
  let shouldStop = false;

  process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down after current job…");
    shouldStop = true;
  });

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down after current job…");
    shouldStop = true;
  });

  while (!shouldStop) {
    // Kill switch (hard stop).
    if (env.TAGGING_PAUSED === "true") {
      console.log("TAGGING_PAUSE=true → worker is paused. ");
      await sleep(60000); // 60 seconds
      continue;
    }

    /**
     * If OPENAI_API_KEY is missing, we fail-closed by pausing job processing.
     *
     * Why pause instead of crashing?
     * - Crashing causes restart loops / noisy logs.
     * - Pausing is safer and makes the worker “operator-friendly”.
     * - Search/browse continues to work; only tagging is halted.
     */
    if (!env.OPENAI_API_KEY) {
      console.log(
        "OPENAI_API_KEY is not set → worker will not process jobs. Set OPENAI_API_KEY to enable tagging.",
      );
      await sleep(5000);
      continue;
    }

    // Daily cap (hard stop).
    const doneToday = await countDoneJobsToday();
    if (doneToday >= env.TAGGING_DAILY_CAP) {
      console.log(
        `Daily cap reached (${doneToday}/${env.TAGGING_DAILY_CAP}) → worker is paused until tomorrow.`,
      );
      await sleep(15 * 60000); // 15 minutes
      continue;
    }

    // Claim a job (if any).
    const job = await claimOneJob();

    if (!job) {
      // No jobs: back off a bit so we don’t hammer the DB.
      await sleep(2000); // 2 seconds
      continue;
    }

    console.log(`Claimed job id=${job.jobId} image_id=${job.imageId}`);

    // Process job (includes its own error handling + fail-closed updates).
    await processJob(job);
  }

  console.log("PepeFinder tagger worker stopped.");
}

main().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
