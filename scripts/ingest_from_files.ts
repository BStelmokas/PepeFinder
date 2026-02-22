/**
 * Generic multi-source ingestion script for scraped JSON image links.
 *
 * Why this exists:
 *  - Reddit started gating its API (Pinterest never had one open)
 *  - In response, images were scraped through alternative means (i.e. Apify) and now sit as links inside .json files
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "~/env";
import { db } from "~/server/db";
import { images, tagJobs } from "~/server/db/schema";
import { putObject, publicUrlForKey } from "~/server/storage/s3";
import { eq, sql } from "drizzle-orm";

// Small config map that isolates “source-specific” differences.
const SOURCE_CONFIG = {
  reddit: {
    displayName: "reddit",
    dbSource: "reddit_scrape",
    urlField: "url",
    allowedHosts: ["i.redd.it", "preview.redd.it", "i.imgur.com"],
    s3Prefix: "images/reddit-scrape",
  },
  pinterest: {
    displayName: "pinterest",
    dbSource: "pinterest_scrape",
    urlField: "imageURL",
    allowedHosts: ["i.pinimg.com"],
    s3Prefix: "images/pinterest-scrape",
  },
} as const;

// A union of valid source keys.
type SourceKey = keyof typeof SOURCE_CONFIG;

// Allowed file formats for ingestion.
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

// Allowed content-types for downloaded bytes.
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Safety cap on download size.
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

// Batch discipline
const DEFAULT_MAX_PER_RUN = 250;

// Parse file extension from a URL’s path.
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

// Generic host + extension filter using per-source config.
function isLikelyAllowedImageUrl(
  url: string,
  allowedHosts: readonly string[],
): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const ext = extFromUrl(url);

    if (!ext) return false;
    return allowedHosts.includes(host);
  } catch {
    return false;
  }
}

// Compute SHA-256 hex digest from bytes.
function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Idempotent job enqueue.
// unique(image_id) ensures no duplicates.
async function enqueueJob(imageId: number): Promise<void> {
  await db
    .insert(tagJobs)
    .values({ imageId, status: "queued", attempts: 0 })
    .onConflictDoNothing();
}

// Download image bytes and validate content-type and size.
async function downloadImageBytes(
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const headers: Record<string, string> = {};

  // If env var is present, include it.
  if (env.SCRAPER_USER_AGENT) {
    headers["User-Agent"] = env.SCRAPER_USER_AGENT;
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

// Read all scraped entries from every .json file in a folder.
async function readUrlsFromFolder(
  folder: string,
  urlField: string,
): Promise<string[]> {
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
      // "Any" is intentional here because these are offline operator files.
      const url = (item as any)?.[urlField];
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
 *   pnpm ingest:files <source> <folder> [maxPerRun]
 *
 * Examples:
 *   pnpm ingest:files reddit "/path/to/reddit-folder" 10000
 *   pnpm ingest:files pinterest "/path/to/pinterest-folder" 8000
 */
async function main(): Promise<void> {
  const sourceKey = process.argv[2] as SourceKey | undefined;
  const folder = process.argv[3];
  const maxPerRun = Number(process.argv[4] ?? DEFAULT_MAX_PER_RUN);

  // Validate source selection.
  if (!sourceKey || !(sourceKey in SOURCE_CONFIG)) {
    console.error(
      `Missing/invalid source.\n` +
        `Usage: pnpm ingest:files <${Object.keys(SOURCE_CONFIG).join("|")}> <folder> [maxPerRun]\n` +
        `Example: pnpm ingest:files reddit "/path/to/folder" 1000`,
    );
    process.exit(1);
  }

  // Validate folder.
  if (!folder) {
    console.error(
      `Missing folder.\nUsage: pnpm ingest:files ${sourceKey} <folder> [maxPerRun]`,
    );
    process.exit(1);
  }

  // Validate maxPerRun.
  if (!Number.isFinite(maxPerRun) || maxPerRun <= 0) {
    throw new Error(`Invalid maxPerRun: ${process.argv[4]}`);
  }

  const cfg = SOURCE_CONFIG[sourceKey];

  console.log("=== PepeFinder ingest from scraped files ===");
  console.log(`source=${cfg.displayName} dbSource=${cfg.dbSource}`);
  console.log(`folder=${folder}`);
  console.log(`maxPerRun=${maxPerRun}`);

  // 1) Read raw URLs from files.
  const allUrls = await readUrlsFromFolder(folder, cfg.urlField);

  // 2) De-dupe early to avoid repeated work across multiple files.
  const uniqueUrls = Array.from(new Set(allUrls));

  // 3) Filter down to likely direct image URLs (host + extension).
  const candidateUrls = uniqueUrls.filter((u) =>
    isLikelyAllowedImageUrl(u, cfg.allowedHosts),
  );

  console.log(
    `found=${allUrls.length} unique=${uniqueUrls.length} candidates=${candidateUrls.length}`,
  );

  // 4) Cap the work to maxPerRun (manual batch discipline).
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
          sql`${images.source} = ${cfg.dbSource} AND ${images.sourceUrl} = ${url}`,
        )
        .limit(1);

      if (existingBySourceUrl.length > 0) {
        skipped++;
        continue;
      }

      // Extension gate: quick skip before any network work.
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

      // Deterministic key.
      const objectKey = `${cfg.s3Prefix}/${sha}.${ext}`;

      // Upload bytes to S3.
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

          // Provenance markers.
          source: cfg.dbSource,
          sourceRef: null, // Stable IDs do not exist in these scrape formats.
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
      // Per-item soft failure.
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
