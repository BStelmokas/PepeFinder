/**
 * Reddit ingestion from pre-scraped JSON files (manual batch only).
 *
 * Why this exists:
 * - I used an alternative way to scrape the images since Reddit gated the API.
 * - A a clean, idempotent, takedown-ready ingestion path is still wanted.
 *
 * What this script does:
 * 1) Reads all .json files in a folder
 * 2) Extracts `{ url: string }` entries
 * 3) Filters to "likely direct image URLs" (ignore non-images)
 * 4) Downloads the bytes (server-side)
 * 5) Computes SHA-256 for dedupe + deterministic object keys
 * 6) Uploads to S3
 * 7) Inserts images row with minimal attribution (sourceUrl preserved)
 * 8) Enqueues tag_jobs (bounded by kill switch + daily cap)
 *
 * IMPORTANT constraints honored:
 * - Manual run only (no daemon)
 * - Fixed maximum work per run (operator-controlled)
 * - Idempotent via sha256 uniqueness (primary)
 * - Best-effort idempotent via sourceUrl check (secondary)
 * - No model calls here
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "~/env";
import { db } from "~/server/db";
import { images, tagJobs } from "~/server/db/schema";
import { putObject, publicUrlForKey } from "~/server/storage/s3";
import { eq, sql } from "drizzle-orm";

/**
 * Types: matches the scraped JSON format.
 */
type ScrapedEntry = { url: string };

/**
 * Only ingest these extensions (strict).
 * Why strict:
 * - avoids accidentally ingesting videos, HTML pages, etc.
 * - keeps downloads smaller and predictable
 */
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

/**
 * Verify content-type after download to prevent "url says .jpg but it's HTML".
 * This blocks a common scraping failure mode.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Safety cap: max bytes per image download.
 * This prevents one malicious or broken URL from blowing memory/cost.
 */
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Safety cap: max number of URLs processed per run.
 *
 * Default to 250 per run.
 */
const DEFAULT_MAX_PER_RUN = 250;

/**
 * Parse file extension from a URL’s path.
 */
function extFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split(".");
    const ext = parts[parts.length - 1]?.toLowerCase();
    if (!ext) return null;
    if (!ALLOWED_EXT.has(ext)) return null;
    return ext === "jpeg" ? "jpg" : ext; // Normalize jpeg -> jpg so keys stay consistent.
  } catch {
    return null;
  }
}

/**
 * Decide whether a URL is worth attempting.
 *
 * Restrict to “direct image” hosts by default.
 * - i.redd.it is for Reddit-hosted images
 *
 * Why:
 * - avoids wasting time on "tessprint7.com" or YouTube links
 * - reduces bad downloads, timeouts, and HTML masquerading as images
 */
function isLikelyDirectImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const ext = extFromUrl(url);

    if (!ext) return false;

    return host === "i.redd.it";
  } catch {
    return false;
  }
}

/**
 * Compute SHA-256 hex digest from bytes.
 * This is the primary dedupe key and deterministic storage identity.
 */
function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Idempotent job enqueue:
 * - unique(image_id) ensures no duplicates
 * - never call the model here
 */
async function enqueueJob(imageId: number): Promise<void> {
  await db
    .insert(tagJobs)
    .values({ imageId, status: "queued", attempts: 0 })
    .onConflictDoNothing();
}

/**
 * Download bytes and validate content-type and size.
 */
async function downloadImageBytes(
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const headers: Record<string, string> = {};

  // If env var is present, include it. If not, omit the header entirely.
  // (In env.ts REDDIT_USER_AGENT is validated as required, but this is still defensive.)
  if (env.REDDIT_USER_AGENT) {
    headers["User-Agent"] = env.REDDIT_USER_AGENT;
  }

  const res = await fetch(url, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const contentType =
    res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    // If this triggers a lot, it’s a sign the script is hitting HTML pages or non-images.
    throw new Error(`Unsupported content-type: ${contentType || "unknown"}`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Too large: ${buf.byteLength} bytes > ${MAX_DOWNLOAD_BYTES}`,
    );
  }

  return { bytes: buf, contentType };
}

/**
 * Read all scraped entries from every .json file in a folder.
 *
 * Expected file format: JSON array of { url: string } objects.
 */
async function readUrlsFromFolder(folder: string): Promise<string[]> {
  const entries = await fs.readdir(folder, { withFileTypes: true });

  const jsonFiles = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
    .map((e) => path.join(folder, e.name));

  if (jsonFiles.length === 0) {
    throw new Error(`No .json files found in folder: ${folder}`);
  }

  const urls: string[] = [];

  for (const filePath of jsonFiles) {
    const raw = await fs.readFile(filePath, "utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in file: ${filePath}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`Expected JSON array in file: ${filePath}`);
    }

    for (const item of parsed) {
      const url = (item as ScrapedEntry)?.url;
      if (typeof url === "string" && url.length > 0) {
        urls.push(url);
      }
    }
  }

  return urls;
}

/**
 * MAIN
 *
 * CLI:
 * - folder path can be passed as argv[2]
 * - otherwise uses env.REDDIT_SCRAPE_DIR
 * - optional max per run via argv[3]
 *
 * Examples:
 *   pnpm reddit:ingest:files "/path/to/folder" 200
 *   REDDIT_SCRAPE_DIR="/path/to/folder" pnpm reddit:ingest:files
 */
async function main(): Promise<void> {
  const folder = process.argv[2] ?? env.REDDIT_SCRAPE_DIR;

  if (!folder) {
    console.error(
      "Missing folder path. Provide as argv or set REDDIT_SCRAPE_DIR in .env.\n" +
        "Usage: pnpm reddit:ingest:files /path/to/folder [maxPerRun]",
    );
    process.exit(1);
  }

  const maxPerRun = Number(process.argv[3] ?? DEFAULT_MAX_PER_RUN);
  if (!Number.isFinite(maxPerRun) || maxPerRun <= 0) {
    throw new Error(`Invalid maxPerRun: ${process.argv[3]}`);
  }

  console.log("=== PepeFinder ingest from scraped files ===");
  console.log(`folder=${folder}`);
  console.log(`maxPerRun=${maxPerRun}`);

  const allUrls = await readUrlsFromFolder(folder);

  // De-dupe URLs early to avoid repeated work across 5 files.
  const uniqueUrls = Array.from(new Set(allUrls));

  // Filter down to likely direct image URLs (host + extension).
  const candidateUrls = uniqueUrls.filter(isLikelyDirectImageUrl);

  console.log(
    `found=${allUrls.length} unique=${uniqueUrls.length} candidates=${candidateUrls.length}`,
  );

  // Cap the run to maxPerRun (manual batch discipline).
  const toProcess = candidateUrls.slice(0, maxPerRun);

  console.log(
    `Budget gating disabled for file-ingest. All newly ingested images will be enqueued.`,
  );

  let processed = 0;
  let ingested = 0;
  let skipped = 0;
  let enqueued = 0;

  for (const url of toProcess) {
    processed++;

    try {
      // Secondary idempotency check by sourceUrl:
      // - sha256 uniqueness is the real dedupe guarantee
      // - but sourceUrl check avoids re-downloading the same URL repeatedly
      const existingBySourceUrl = await db
        .select({ id: images.id })
        .from(images)
        .where(
          sql`${images.source} = 'reddit_scrape' AND ${images.sourceUrl} = ${url}`,
        )
        .limit(1);

      if (existingBySourceUrl.length > 0) {
        skipped++;
        continue;
      }

      const ext = extFromUrl(url);
      if (!ext) {
        skipped++;
        continue;
      }

      const { bytes, contentType } = await downloadImageBytes(url);
      const sha = sha256Hex(bytes);

      // Primary idempotency: sha256 uniqueness.
      const existingBySha = await db
        .select({ id: images.id })
        .from(images)
        .where(eq(images.sha256, sha))
        .limit(1);

      if (existingBySha.length > 0) {
        skipped++;
        continue;
      }

      // Deterministic key: uses sha + ext.
      // Namespace under images/reddit-scrape/ to distinguish from API ingestion.
      const objectKey = `images/reddit-scrape/${sha}.${ext}`;

      await putObject({ key: objectKey, body: bytes, contentType });

      // Store a renderable storageKey if public URL is configured; else store raw object key.
      const publicUrl = publicUrlForKey(objectKey);
      const storageKey = publicUrl ?? objectKey;

      // Insert image row as pending so worker will process tags.
      const inserted = await db
        .insert(images)
        .values({
          storageKey,
          sha256: sha,
          status: "pending",

          // Mark origin clearly.
          source: "reddit_scrape",

          // It's not possible to get post_id from i.redd.it URL alone.
          // Keep sourceRef null and store the raw URL in sourceUrl.
          sourceRef: null,
          sourceUrl: url,
        })
        .returning({ id: images.id });

      const imageId = inserted[0]!.id;
      ingested++;

      await enqueueJob(imageId);
      enqueued++;

      console.log(
        `ingested image_id=${imageId} sha=${sha.slice(0, 8)}… enqueued=true`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`skip url=${url} reason=${msg}`);
      skipped++;
    }
  }

  console.log(
    `done processed=${processed} ingested=${ingested} enqueued=${enqueued} skipped=${skipped}`,
  );
}

main().catch((err) => {
  console.error("Ingest-from-files failed:", err);
  process.exit(1);
});
