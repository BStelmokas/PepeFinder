/**
 * PepeFinder Tagging Worker (Step 11)
 *
 * This is a separate Node process that you run alongside the web app:
 * - `pnpm worker:tagger`
 *
 * Why a separate process?
 * - Worker-only model calls is a hard invariant (cost safety).
 * - We want the web server to remain responsive even if tagging is slow or failing.
 *
 * Why Postgres as the queue?
 * - MVP constraint: no Redis, no external queue.
 * - Postgres row-level locking + SKIP LOCKED gives us safe job claiming with minimal infra.
 *
 * Fail-closed safety:
 * - If TAGGING_PAUSED=true → worker does nothing (search stays live).
 * - If TAGGING_DAILY_CAP reached → worker does nothing (search stays live).
 * - If errors occur → mark image failed + job failed, store last_error.
 *
 * Placeholder tagger:
 * - For now we generate deterministic tags (no AI calls).
 * - We structure code so replacing with a real vision model later is a one-function change:
 *   replace `runTagger()` implementation only.
 */

import { sql } from "drizzle-orm";
import { db } from "~/server/db";
import { env } from "~/env";
import { imageTags, images, tagJobs, tags } from "~/server/db/schema";
import { normalizeTagName } from "~/lib/text/normalize";
import { tagImageWithOpenAI } from "~/server/ai/openai-vision-tagger";
import { resolveImageUrlForModel } from "~/server/storage/resolve-image-url";

/**
 * Small sleep helper so we can “poll” the DB without busy-waiting.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A minimal “tag suggestion” structure.
 * This mirrors what a real model would eventually return:
 * - a tag string
 * - a confidence 0..1
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
  });
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

    // We ignore caption for now (MVP1 scope), but logging it can be helpful for debugging.
    console.log(`caption(image_id=${image.id}): ${result.caption}`);

    // Convert ModelTag (with kind) -> persistence tags.
    // We intentionally ignore `kind` for MVP1, but you could later store it if desired.
    const suggestions: TagSuggestion[] = result.tags.map((t) => ({
      name: t.name,
      confidence: t.confidence,
    }));

    // Write tags + join rows atomically.
    await writeTagsForImage({ imageId: image.id, suggestions });

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
