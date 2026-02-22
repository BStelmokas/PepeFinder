/**
 * One-off seed script.
 *
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

import { db } from "~/server/db";
import { imageTags, images, tags } from "~/server/db/schema";
import { normalizeTagName } from "~/lib/text/normalize";
import { eq } from "drizzle-orm";

// The manifest shape.
type SeedManifest = {
  images: Array<{
    file: string;
    tags: string[];
  }>;
};

// Compute SHA-256 (hex) for a file buffer.
function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Read and parse seed.json from a directory.
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

  // Tiny runtime shape check
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

// Ensure `public/seed` exists and return its absolute path.
function ensurePublicSeedDir(projectRoot: string): string {
  const publicSeedDir = path.join(projectRoot, "public", "seed");

  if (!fs.existsSync(publicSeedDir)) {
    fs.mkdirSync(publicSeedDir, { recursive: true });
  }

  return publicSeedDir;
}

// Copy an image into `public/seed/` if missing.
function copyToPublicSeedIfMissing(sourcePath: string, destPath: string): void {
  if (fs.existsSync(destPath)) {
    return;
  }

  fs.copyFileSync(sourcePath, destPath);
}

// Upsert-like helper for images.
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

  // 2) If not inserted, fetch existing by sha256 (the strongest dedupe key).
  const existing = await db
    .select({ id: images.id })
    .from(images)
    .where(eq(images.sha256, args.sha256))
    .limit(1);

  if (existing.length === 0) {
    // This should be impossible if the uniqueness constraints are working.
    throw new Error(
      `Image insert conflicted but existing row not found (sha256=${args.sha256}).`,
    );
  }

  return existing[0]!.id;
}

// Upsert-like helper for tags.
async function getOrCreateTagId(rawTag: string): Promise<number | null> {
  // Normalize exactly once here so seed tags match query token semantics forever.
  const normalized = normalizeTagName(rawTag);

  // If normalization yields null, this tag is invalid under the frozen rules..
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

  // This should be impossible unless constraints are broken.
  if (existing.length === 0) {
    throw new Error(
      `Tag insert conflicted but existing row not found (name=${normalized}).`,
    );
  }

  return existing[0]!.id;
}

// Main
async function main(): Promise<void> {
  // Directory containing seed.json and images.
  const seedDir = process.env.SEED_DIR;

  if (!seedDir) {
    throw new Error(
      `Missing SEED_DIR.\n` +
        `Example:\n` +
        `  SEED_DIR="/Users/you/Desktop/PepeSeed" pnpm db:seed\n`,
    );
  }

  // Resolve seedDir to an absolute path.
  const resolvedSeedDir = path.resolve(seedDir);

  // Project root.
  const projectRoot = process.cwd();

  // Read and validate the manifest.
  const manifest = readManifest(resolvedSeedDir);

  // Ensure the public seed directory exists for serving images.
  const publicSeedDir = ensurePublicSeedDir(projectRoot);

  console.log(`Seeding from: ${resolvedSeedDir}`);
  console.log(`Copying images into: ${publicSeedDir}`);
  console.log(`Manifest entries: ${manifest.images.length}`);

  // Track counters.
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

    // Read file bytes.
    const bytes = fs.readFileSync(sourcePath);

    // Compute stable dedupe hash.
    const sha = sha256Hex(bytes);

    // Copy into public/seed/<file> if needed so Next can serve it.
    const destPath = path.join(publicSeedDir, item.file);
    copyToPublicSeedIfMissing(sourcePath, destPath);

    // The URL path stored in DB and rendered directly in <img src="...">.
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

      // Insert join row.
      const inserted = await db
        .insert(imageTags)
        .values({
          imageId,
          tagId,
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

// An explicit failure path.
main().catch((err) => {
  console.error(`❌ Seed failed`);
  console.error(err);
  process.exit(1);
});
