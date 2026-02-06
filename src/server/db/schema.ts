/**
 * Drizzle schema for PepeFinder MVP0.
 *
 * Design goals (MVP0):
 * - Exactly the 3 core concepts: images, tags, image_tags.
 * - Deterministic, DB-only search path later:
 *   - Query tokens -> tag ids (via tags.name unique index)
 *   - tag ids -> image ids (via image_tags index on (tag_id, image_id))
 *   - rank by match_count (COUNT DISTINCT tag_id per image)
 * - Image detail fast:
 *   - image_id -> tags ordered by confidence DESC (via index on (image_id, confidence DESC))
 *
 * IMPORTANT constraints we’re respecting:
 * - Keep T3 structure intact: this file lives exactly here.
 * - Postgres timestamps stored as UTC by using timestamptz (withTimezone: true).
 * - Small, pragmatic schema: <= 10 columns/table, “one table = one concept”.
 */

import { sql } from "drizzle-orm"; // Used for expressing SQL fragments (e.g., CHECK constraints) in a typed way.
import { desc } from "drizzle-orm"; // Used to build DESC indexes in a DB-native way (important for image detail ordering).
import {
  pgEnum, // Postgres ENUM type builder (maps to a real enum type in Postgres).
  pgTable, // Defines a Postgres table in Drizzle.
  primaryKey, // Defines composite primary keys (perfect for join tables like image_tags).
  index, // Defines normal indexes (we’ll use these for search & detail performance).
  uniqueIndex, // Defines unique indexes (we’ll use these for tags.name and dedupe-friendly fields).
  integer, // Integer column type (good for serial id FKs).
  serial, // Auto-incrementing integer primary key (simple, stable for MVP).
  text, // Text type (good for storage keys / URLs).
  varchar, // Bounded string (good for normalized tag names).
  timestamp, // Timestamptz (withTimezone: true) for UTC-safe timestamps.
  real, // Floating point number (good enough for confidence 0..1).
  check, // Database-level invariant enforcement (confidence must be 0..1).
} from "drizzle-orm/pg-core";

/**
 * Image processing lifecycle state (MVP0 uses seeded-only, but MVP1 will need this immediately).
 *
 * Why an enum (instead of free text)?
 * - Prevents invalid values from ever entering the DB.
 * - Makes filtering indexed vs pending images cheaper and safer.
 * - Keeps semantics explicit and reviewable.
 */
export const imageStatusEnum = pgEnum("image_status", [
  "pending", // The image exists but has not been fully tagged/indexed yet (common for uploads + worker).
  "indexed", // Tagging is complete; image is eligible for search results.
  "failed", // Tagging failed (or was skipped due to caps/kill-switch); image stays browseable but not searchable.
]);

/**
 * images
 *
 * One row per stored image in our private corpus.
 * This table is intentionally small: it’s the “entity” table we will join against.
 */
export const images = pgTable(
  "images",
  {
    /**
     * Surrogate primary key.
     *
     * Why serial (int) for MVP?
     * - Dead simple for local/prod parity.
     * - Efficient join keys for image_tags.
     * - Avoids needing extensions (like uuid-ossp) in early MVP environments.
     *
     * Alternative in production: UUID for harder-to-guess IDs.
     * But we can add that later if needed; MVP0 doesn’t require it.
     */
    id: serial("id").primaryKey(),

    /**
     * Where the image lives in storage.
     *
     * For MVP0 (seeded), this can be:
     * - a local path
     * - a public URL
     * - or (later) an S3 object key
     *
     * We call it "storage_key" to avoid committing to “URL vs S3 key”.
     */
    storageKey: text("storage_key").notNull(),

    /**
     * SHA-256 (hex string) of the raw bytes of the image.
     *
     * Why store this now (even in MVP0)?
     * - MVP1 requires dedupe (same image uploaded twice).
     * - Having it as a unique column is a cheap and reliable dedupe primitive.
     */
    sha256: varchar("sha256", { length: 64 }).notNull(),

    /**
     * Whether this image is eligible for DB-only search.
     *
     * In MVP0 seeded dataset, you’ll likely set everything to "indexed".
     * In MVP1 uploads, new images begin as "pending" until the worker tags them.
     */
    status: imageStatusEnum("status").notNull().default("indexed"),

    /**
     * created_at / updated_at (UTC)
     *
     * We store timestamptz (withTimezone: true), which is the correct Postgres type for UTC-safe timestamps.
     * - defaultNow() makes the DB set the time (good: consistent across app instances).
     * - $onUpdate ensures the ORM updates updated_at whenever the row is updated.
     */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),

    /**
     * Optional attribution fields (kept minimal by design).
     *
     * Why include anything now?
     * - Even with private corpus, you’ll frequently want to record “where did this come from?”
     * - MVP2 (Reddit seeding) will benefit immediately from a place to put source info.
     *
     * Why not add more?
     * - We’re staying within MVP scope and avoiding schema bloat.
     */
    source: varchar("source", { length: 32 }), // e.g. "seed", "reddit" (later), "manual" — intentionally small/freeform.
    sourceRef: text("source_ref"), // e.g. a Reddit post id or URL — flexible text to avoid premature modeling.

    /**
     * MVP2 additions (strictly minimal, but very useful):
     * - subreddit gives you traceability for content provenance
     * - post URL gives you an easy takedown/audit trail
     */
    sourceSubreddit: varchar("source_subreddit", { length: 64 }),
    sourceUrl: text("source_url"),
  },
  (t) => {
    return [
      /**
       * Unique storage key: protects against double-seeding the same object key/url.
       * (This is not as strong as sha256, but it’s a nice practical guardrail.)
       */
      uniqueIndex("images_storage_key_unique").on(t.storageKey),

      /**
       * Unique sha256: our strongest dedupe primitive.
       * This will be the backbone of MVP1 upload dedupe.
       */
      uniqueIndex("images_sha256_unique").on(t.sha256),

      /**
       * Index status to support fast filtering of only searchable images (status = 'indexed').
       * This becomes important as soon as uploads/pending/failed exist.
       */
      index("images_status_idx").on(t.status),

      /**
       * Deterministic tie-breaker in your frozen semantics is:
       * created_at DESC, then id.
       * Postgres can use this index to speed up sorting when the candidate set is already filtered.
       */
      index("images_created_at_id_idx").on(t.createdAt, t.id),

      /**
       * MVP2 idempotency by source post:
       * Unique(source, source_ref) ensures we never create two DB rows for the same reddit post.
       *
       * Postgres allows multiple NULLs in UNIQUE indexes, so this won’t break seed images
       * (which typically have null source/sourceRef).
       */
      uniqueIndex("images_source_source_ref_unique").on(t.source, t.sourceRef),
    ];
  },
);

/**
 * tags
 *
 * One row per normalized tag name.
 * Stored tags must match your frozen normalization rules:
 * - lowercase ASCII
 * - whitespace split tokens
 * - no unicode normalization, no stemming
 *
 * IMPORTANT: we do not enforce “ASCII-only” at the DB level in MVP0.
 * Why?
 * - Postgres CHECK constraints for ASCII are possible, but that pushes normalization logic into SQL.
 * - Your spec says normalization is an app-level pure module (Step 4).
 * So for MVP0: enforce uniqueness + store what the app normalized.
 */
export const tags = pgTable(
  "tags",
  {
    /**
     * Surrogate key for joining.
     */
    id: serial("id").primaryKey(),

    /**
     * Normalized tag name.
     *
     * We use varchar to keep it bounded and index-friendly.
     * 64 is arbitrary but practical; you can bump it later without huge pain.
     */
    name: varchar("name", { length: 64 }).notNull(),

    /**
     * When the tag was first created.
     * Useful for debugging and potential future analytics.
     */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => {
    return [
      /**
       * Unique index for fast “token -> tag id” lookup during search.
       * This is one of the two most important indexes in MVP0 search performance.
       */
      uniqueIndex("tags_name_unique").on(t.name),
    ];
  },
);

/**
 * image_tags
 *
 * Join table linking images to tags.
 *
 * Why a dedicated join table?
 * - Images have many tags; tags appear on many images (many-to-many).
 * - This table is the core search accelerator: we query it by tag_id and group by image_id.
 *
 * We also store confidence (0..1) for display and later improvements.
 * IMPORTANT: per your spec, confidence does NOT affect ranking in MVP search.
 */
export const imageTags = pgTable(
  "image_tags",
  {
    /**
     * Foreign key to images.
     * onDelete: "cascade" ensures if an image is removed, its join rows don’t become garbage.
     */
    imageId: integer("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),

    /**
     * Foreign key to tags.
     * onDelete: "cascade" ensures if a tag is ever removed, join rows are cleaned up.
     * (In practice tags are rarely deleted, but this keeps integrity strict.)
     */
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),

    /**
     * Confidence score from the tagger, between 0 and 1.
     *
     * Storage choice:
     * - real (float4) is plenty for UI display and lightweight.
     * Alternative:
     * - numeric(3,2) for strict decimals; heavier and unnecessary for MVP.
     */
    confidence: real("confidence").notNull().default(1),

    /**
     * created_at (UTC)
     * Useful for debugging “when was this tag attached?”
     */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => {
    return [
      /**
       * Composite primary key = the natural identity of this join row.
       *
       * This enforces: an image cannot have the same tag twice.
       * It also acts as a unique constraint with an index.
       *
       * Your spec requested composite unique(image_id, tag_id) — this is stronger and standard:
       * - a composite PK is both uniqueness + identity.
       */
      primaryKey({ columns: [t.imageId, t.tagId] }),

      /**
       * Search-critical index:
       * - We will fetch image_ids by tag_id IN (...)
       * - Then group by image_id and count distinct tag_id
       *
       * Index on (tag_id, image_id) makes that path efficient.
       * This is the second most important index for MVP0 search performance.
       */
      index("image_tags_tag_id_image_id_idx").on(t.tagId, t.imageId),

      /**
       * Image detail index:
       * - Fetch tags for a single image_id
       * - Order by confidence DESC
       *
       * This avoids sorting a large intermediate result in-memory.
       */
      index("image_tags_image_id_confidence_desc_idx").on(
        t.imageId,
        desc(t.confidence),
      ),

      /**
       * DB-level invariant: confidence must be within [0, 1].
       *
       * Why enforce in the DB *and* the app later?
       * - App-level validation prevents bad data from entering (fast feedback).
       * - DB-level check prevents bad data from ever persisting (last line of defense).
       */
      check(
        "image_tags_confidence_between_0_and_1",
        sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`,
      ),
    ];
  },
);

/**
 * Postgres-backed queue for tagging jobs.
 *
 * Why a table queue?
 * - We want "no infra beyond Postgres" for MVP1.
 * - Postgres row-level locking + SKIP LOCKED provides safe concurrency.
 * - Unique(image_id) guarantees we never enqueue duplicates for the same image.
 */
export const tagJobStatusEnum = pgEnum("tag_job_status", [
  "queued", // Waiting to be claimed.
  "running", // Claimed by a worker.
  "done", // Completed successfully.
  "failed", // Completed with error (fail-closed).
]);

export const tagJobs = pgTable(
  "tag_jobs",
  {
    id: serial("id").primaryKey(),

    /**
     * Which image this job is for.
     * onDelete cascade keeps queue clean if an image is deleted.
     */
    imageId: integer("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),

    /**
     * Job lifecycle status.
     */
    status: tagJobStatusEnum("status").notNull().default("queued"),

    /**
     * Attempts count for retry logic.
     * MVP1 keeps retry minimal, but we store this now because it’s
     * the first thing you’ll want when the worker sometimes fails.
     */
    attempts: integer("attempts").notNull().default(0),

    /**
     * Last error message (small) for debugging failures.
     * We keep it as text to avoid truncation surprises.
     */
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => {
    return [
      /**
       * Hard invariant: one job per image.
       * This prevents duplicate spending and duplicate work.
       */
      uniqueIndex("tag_jobs_image_id_unique").on(t.imageId),

      /**
       * Worker query pattern:
       * - find queued jobs quickly
       * - claim oldest first (created_at ASC) for fairness
       */
      index("tag_jobs_status_created_at_idx").on(t.status, t.createdAt),
    ];
  },
);
