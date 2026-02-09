/**
 * Backfill captions for images that are already indexed but have no caption.
 *
 * Why this exists:
 * - You processed images before caption persistence was implemented.
 * - Some images may have been indexed without caption.
 *
 * What it does:
 * - Finds images where:
 *   - status = 'indexed'
 *   - caption IS NULL (or empty)
 * - Ensures each has a queued tag_jobs row:
 *   - If a job row exists: set status='queued' and clear last_error
 *   - If no job row exists: insert queued job
 *
 * Safety:
 * - No model calls here.
 * - No changes to existing tags.
 * - Worker remains the only place that calls the model.
 */

import { db } from "~/server/db";
import { images, tagJobs } from "~/server/db/schema";
import { sql } from "drizzle-orm";
