/**
 * Tagging Worker
 *
 * This is a script that in the future will be a long-lived separate Node process that will be run alongside the web app.
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

// Small sleep helper so the DB can be polled without busy-waiting.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TagSuggestion = {
  name: string;
  confidence: number;
};

// Claim a single queued job using SKIP LOCKED.
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

// Count how many jobs have completed successfully today (UTC-ish).
async function countDoneJobsToday(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
		SELECT COUNT(*)::int as n
		FROM tag_jobs
		WHERE status = 'done'
			AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
		`);

  return res[0]?.n ?? 0;
}

// Upsert tag + join rows for an image.
async function writeTagsForImage(args: {
  imageId: number;
  suggestions: TagSuggestion[];
}): Promise<void> {
  await db.transaction(async (tx) => {
    for (const s of args.suggestions) {
      // Normalize to match query semantics and DB uniqueness rules.
      const normalized = normalizeTagName(s.name);
      if (!normalized) continue;

      // Expand hyphenated tokens into additional atomic tokens.
      const expandedNames = expandHyphenatedToken(normalized);

      // Dedupe expansions to avoid wasting DB work.
      const uniqueExpandedNames = Array.from(new Set(expandedNames));

      for (const name of uniqueExpandedNames) {
        // Upsert tag row by unique(tags.name).
        const insertedTag = await tx
          .insert(tags)
          .values({ name })
          .onConflictDoNothing()
          .returning({ id: tags.id });

        let tagId: number;

        if (insertedTag.length > 0) {
          // Happy path: inserted a new tag row and got its id back.
          tagId = insertedTag[0]!.id;
        } else {
          // Conflict path: Fetch existing id.
          const existing = await tx
            .select({ id: tags.id })
            .from(tags)
            .where(sql`${tags.name} = ${name}`)
            .limit(1);

          if (!existing[0]) {
            throw new Error(`Tag conflict but cannot fetch id for: ${name}`);
          }

          tagId = existing[0].id;
        }

        // Insert join row.
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

// Convert a caption string into tag suggestions using frozen tokenization rules.
function captionToTagSuggestions(caption: string): TagSuggestion[] {
  const tokens = tokenizeQuery(caption);
  const seen = new Set<string>();

  const out: TagSuggestion[] = [];

  for (const tok of tokens) {
    if (seen.has(tok)) continue;
    seen.add(tok);

    // Reasonable confidence given the observed track record.
    out.push({ name: tok, confidence: 0.7 });
  }

  return out;
}

// Merge two suggestion lists by name, keeping the highest confidence.
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

// Process one job.
async function processJob(args: {
  jobId: number;
  imageId: number;
}): Promise<void> {
  try {
    // Load image row (sha256 is needed for tagger and status changes).
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

    // Prevent duplicated work if the image is already indexed.
    if (image.status === "indexed") {
      await db
        .update(tagJobs)
        .set({ status: "done", lastError: null })
        .where(sql`${tagJobs.id} = ${args.jobId}`);
      return;
    }

    // Resolve a URL the model can fetch.
    const imageUrl = await resolveImageUrlForModel(image.storageKey);

    // Call the real model tagger.
    const result = await tagImageWithOpenAI({ imageUrl });

    console.log(`caption(image_id=${image.id}): ${result.caption}`);

    // Store caption on the image row.
    await db
      .update(images)
      .set({ caption: result.caption })
      .where(sql`${images.id} = ${image.id}`);

    // Convert ModelTag -> persistence tags.
    const modelSuggestions: TagSuggestion[] = result.tags.map((t) => ({
      name: t.name,
      confidence: t.confidence,
    }));

    // Caption tokens -> tags.
    const captionSuggestions = captionToTagSuggestions(result.caption);

    // Merge and dedupe by tag name.
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

    console.error(`Job ${args.jobId} failed: ${msg}`);
  }
}

/**
 * Main.
 *
 * Behavior:
 * - If kill switch enabled → sleep and do nothing.
 * - If daily cap reached → sleep and do nothing.
 * - Otherwise claim + process one job at a time.
 * - If no jobs → sleep and poll again.
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

    // If OPENAI_API_KEY is missing, fail-closed by pausing job processing.
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
      // No jobs: back off a bit to not hammer the DB.
      await sleep(2000); // 2 seconds
      continue;
    }

    console.log(`Claimed job id=${job.jobId} image_id=${job.imageId}`);

    // Process job.
    await processJob(job);
  }

  console.log("PepeFinder tagger worker stopped.");
}

main().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
