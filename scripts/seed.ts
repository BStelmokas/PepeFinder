/**
 * PepeFinder MVP0 — One-off seed script (idempotent)
 *
 * Why this exists (architecture, not “just a script”):
 * - MVP0 requires a manually seeded dataset (50–200 images).
 * - This must NOT become a product feature:
 *   - no UI
 *   - no uploads
 *   - no API routes
 * - It *is* an internal operator tool: repeatable, safe to re-run, and boring.
 *
 * Key invariants we enforce:
 * - Uses the single Drizzle db singleton from `src/server/db.ts` (non-negotiable).
 * - Idempotent re-runs using DB uniqueness:
 *   - images.sha256 is unique
 *   - tags.name is unique
 *   - image_tags has composite PK (image_id, tag_id)
 * - Tag normalization matches frozen query semantics via our pure module.
 *
 * Storage model for MVP0:
 * - We copy files into `public/seed/` (served by Next.js dev server as `/seed/<file>`).
 * - We store `storageKey` in DB as `/seed/<file>`.
 *
 * Why copy into `public/` instead of using file:// paths?
 * - Browsers won’t reliably render arbitrary local file paths in <img src="...">.
 * - Next.js can serve public assets consistently in dev and prod.
 * - This keeps UI behavior predictable while we’re still pre-S3.
 *
 * How to run:
 * - Set SEED_DIR to the folder containing:
 *   - seed.json
 *   - the referenced image files
 * - Then: `pnpm db:seed`
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { db } from "~/server/db"; // Required: singleton DB instance (do not instantiate elsewhere).
import { imageTags, images, tags } from "~/server/db/schema"; // DB schema tables (typed).
import { normalizeTagName } from "~/lib/text/normalize"; // Frozen tag normalization (must match query semantics).
import { eq } from "drizzle-orm"; // Typed SQL operator for lookups.

/**
 * The manifest shape you described.
 *
 * We keep the type tiny and explicit:
 * - We only parse what we need.
 * - Validation is done with a light runtime check below (no new deps).
 */
type SeedManifest = {
  images: Array<{
    file: string;
    tags: string[];
  }>;
};

/**
 * Compute SHA-256 (hex) for a file buffer.
 *
 * Why SHA-256?
 * - Stable fingerprint for dedupe.
 * - Cheap at this dataset size.
 * - Becomes a first-class primitive for MVP1 uploads.
 */
function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Read and parse seed.json from a directory.
 *
 * We do minimal validation (without new deps) because:
 * - This is an operator script, not a public boundary.
 * - But we still want good errors if the JSON is malformed.
 */
function readManifest(seedDir: string): SeedManifest {
  const manifestPath = path.join(seedDir, "seed.json");

  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `seed.json not found at: ${manifestPath}\n` +
        `Set SEED_DIR to a folder containing seed.json and the image files.`,
    );
  }

  const raw = fs.readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  // Tiny runtime shape check: enough to avoid confusing failures later.
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("images" in parsed) ||
    !Array.isArray((parsed as any).images)
  ) {
    throw new Error(
      `seed.json has unexpected shape. Expected: { "images": [ { "file": "...", "tags": ["..."] } ] }`,
    );
  }

  return parsed as SeedManifest;
}

/**
 * Ensure `public/seed` exists and return its absolute path.
 *
 * Why:
 * - Next.js serves `public/**` at the site root.
 * - So `public/seed/apu-hat.png` becomes `/seed/apu-hat.png`.
 */
function ensurePublicSeedDir(projectRoot: string): string {
  const publicSeedDir = path.join(projectRoot, "public", "seed");

  if (!fs.existsSync(publicSeedDir)) {
    fs.mkdirSync(publicSeedDir, { recursive: true });
  }

  return publicSeedDir;
}

/**
 * Copy an image into `public/seed/` if missing.
 *
 * Idempotency:
 * - If the destination file already exists, we do not overwrite it.
 * - In early MVP0 we prefer “do not surprise me” over “sync every run”.
 *
 * Later, if you want strict syncing, you can compare hashes and overwrite if changed.
 */
function copyToPublicSeedIfMissing(sourcePath: string, destPath: string): void {
  if (fs.existsSync(destPath)) {
    return;
  }

  fs.copyFileSync(sourcePath, destPath);
}

/**
 * Upsert-like helper for images:
 * - Try insert (unique on sha256 + storageKey).
 * - If it already exists, fetch its id.
 *
 * Why not a true SQL UPSERT with RETURNING?
 * - Drizzle supports onConflict behaviors, but “return the existing row id on conflict”
 *   is not consistently ergonomic across all Drizzle versions/configs.
 * - This two-step approach is simple, explicit, and perfectly fine at seed scale (50–200 rows).
 */
async function getOrCreateImage(args: {
  storageKey: string;
  sha256: string;
  source?: string;
  sourceRef?: string;
}): Promise<number> {
  // 1) Attempt to insert.
  const inserted = await db
    .insert(images)
    .values({
      storageKey: args.storageKey,
      sha256: args.sha256,
      status: "indexed", // Seeded dataset is immediately searchable.
      source: args.source,
      sourceRef: args.sourceRef,
    })
    // If a row already exists (by unique constraint), do nothing.
    .onConflictDoNothing()
    // If inserted, return its id.
    .returning({ id: images.id });

  if (inserted.length > 0) return inserted[0]!.id;

  // 2) If not inserted, fetch existing by sha256 (our strongest dedupe key).
  const existing = await db
    .select({ id: images.id })
    .from(images)
    .where(eq(images.sha256, args.sha256))
    .limit(1);

  if (existing.length === 0) {
    // This should be impossible if the uniqueness constraints are working.
    // We throw loudly because silent corruption is worse than a failed seed run.
    throw new Error(
      `Image insert conflicted but existing row not found (sha256=${args.sha256}).`,
    );
  }

  return existing[0]!.id;
}

/**
 * Upsert-like helper for tags:
 * - Normalize tag name using frozen semantics.
 * - Insert if missing.
 * - Fetch id.
 */
async function getOrCreateTagId(rawTag: string): Promise<number | null> {
  // Normalize exactly once here so seed tags match query token semantics forever.
  const normalized = normalizeTagName(rawTag);

  // If normalization yields null, this tag is invalid under our frozen rules.
  // We skip it rather than failing the entire seed run.
  if (!normalized) return null;

  // Attempt insert (unique on tags.name).
  const inserted = await db
    .insert(tags)
    .values({ name: normalized })
    .onConflictDoNothing()
    .returning({ id: tags.id });

  if (inserted.length > 0) return inserted[0]!.id;

  // If not inserted, fetch existing id.
  const existing = await db
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.name, normalized))
    .limit(1);

  // Like images: this should be impossible unless constraints are broken.
  if (existing.length === 0) {
    throw new Error(
      `Tag insert conflicted but existing row not found (name=${normalized}).`,
    );
  }

  return existing[0]!.id;
}

/**
 * Main seed routine.
 *
 * We keep this sequential and simple:
 * - 50 images is tiny
 * - clarity > clever concurrency here
 */
async function main(): Promise<void> {
  // Operator-provided directory containing seed.json and images.
  const seedDir = process.env.SEED_DIR;

  if (!seedDir) {
    throw new Error(
      `Missing SEED_DIR.\n` +
        `Example:\n` +
        `  SEED_DIR="/Users/you/Desktop/PepeSeed" pnpm db:seed\n`,
    );
  }

  // Resolve seedDir to an absolute path for predictable file I/O.
  const resolvedSeedDir = path.resolve(seedDir);

  // Project root heuristic:
  // - This script runs from repo root when invoked via pnpm.
  // - So process.cwd() is a good approximation of the repo root.
  const projectRoot = process.cwd();

  // Read and validate the manifest.
  const manifest = readManifest(resolvedSeedDir);

  // Ensure our public seed directory exists for serving images.
  const publicSeedDir = ensurePublicSeedDir(projectRoot);

  console.log(`Seeding from: ${resolvedSeedDir}`);
  console.log(`Copying images into: ${publicSeedDir}`);
  console.log(`Manifest entries: ${manifest.images.length}`);

  // Track counters for a clean operator summary.
  let imagesProcessed = 0;
  let tagLinksCreated = 0;
  let invalidTagsSkipped = 0;

  for (const item of manifest.images) {
    // Resolve the source file path.
    const sourcePath = path.join(resolvedSeedDir, item.file);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(
        `Image file not found: ${sourcePath}\n` +
          `Manifest references "${item.file}" but the file does not exist in SEED_DIR.`,
      );
    }

    // Read file bytes (needed for SHA-256 and later correctness).
    const bytes = fs.readFileSync(sourcePath);

    // Compute stable dedupe hash.
    const sha = sha256Hex(bytes);

    // Copy into public/seed/<file> if needed so Next can serve it.
    const destPath = path.join(publicSeedDir, item.file);
    copyToPublicSeedIfMissing(sourcePath, destPath);

    // The URL path we store in DB and render directly in <img src="...">.
    const storageKey = `/seed/${item.file}`;

    // Insert (or fetch) the image row.
    const imageId = await getOrCreateImage({
      storageKey,
      sha256: sha,
      source: "seed",
      sourceRef: item.file,
    });

    // Link tags for this image.
    for (const rawTag of item.tags) {
      const tagId = await getOrCreateTagId(rawTag);

      if (!tagId) {
        invalidTagsSkipped++;
        continue;
      }

      // Insert join row (idempotent due to composite PK).
      const inserted = await db
        .insert(imageTags)
        .values({
          imageId,
          tagId,
          // Seeded tags are “ground truth” from your manifest, so we use 1.0.
          // Later, worker tagging will produce real probabilities.
          confidence: 1,
        })
        .onConflictDoNothing()
        .returning({ imageId: imageTags.imageId });

      if (inserted.length > 0) {
        tagLinksCreated++;
      }
    }

    imagesProcessed++;
  }

  console.log(`Seed complete`);
  console.log(`- images processed: ${imagesProcessed}`);
  console.log(`- tag links created: ${tagLinksCreated}`);
  console.log(`- invalid tags skipped: ${invalidTagsSkipped}`);
}

// Run main() with an explicit failure path that sets a non-zero exit code.
// This is important for operator scripts (CI, deploy hooks, etc.).
main().catch((err) => {
  console.error(`❌ Seed failed`);
  console.error(err);
  process.exit(1);
});
