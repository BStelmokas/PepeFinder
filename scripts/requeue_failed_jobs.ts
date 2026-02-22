/**
 * Requeue failed tagging jobs.
 *
 * Design:
 * - Finds tag_jobs where status = 'failed'
 * - Resets:
 *     tag_jobs.status  -> 'queued'
 *     tag_jobs.last_error -> null
 *     images.status -> 'pending'
 */

import { sql } from "drizzle-orm";
import { db } from "~/server/db";
import { images, tagJobs } from "~/server/db/schema";

async function main(): Promise<void> {
  console.log("=== Requeue failed tagging jobs ===");

  const failedJobs = await db.execute<{
    job_id: number;
    image_id: number;
  }>(sql`
      SELECT id as job_id, image_id
      FROM tag_jobs
      WHERE status = 'failed'
    `);

  console.log(`Found ${failedJobs.length} failed jobs.`);

  if (failedJobs.length === 0) {
    console.log("Nothing to requeue.");
    return;
  }

  await db.transaction(async (tx) => {
    for (const row of failedJobs) {
      // Reset job
      await tx
        .update(tagJobs)
        .set({
          status: "queued",
          lastError: null,
          updatedAt: sql`NOW()`,
        })
        .where(sql`${tagJobs.id} = ${row.job_id}`);

      // Reset image status so worker treats it normally
      await tx
        .update(images)
        .set({
          status: "pending",
          updatedAt: sql`NOW()`,
        })
        .where(sql`${images.id} = ${row.image_id}`);
    }
  });

  console.log("Requeue complete.");
}

main().catch((err) => {
  console.error("Requeue failed:", err);
  process.exit(1);
});
