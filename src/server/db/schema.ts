/**
 * Drizzle schema.
 */

import { sql } from "drizzle-orm";
import { desc } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  primaryKey,
  index,
  uniqueIndex,
  integer,
  serial,
  text,
  varchar,
  timestamp,
  real, // Floating point number.
  check,
} from "drizzle-orm/pg-core";

// Image processing lifecycle state.
export const imageStatusEnum = pgEnum("image_status", [
  "pending",
  "indexed",
  "failed",
]);

/**
 * images
 */
export const images = pgTable(
  "images",
  {
    // Surrogate primary key.
    id: serial("id").primaryKey(),

    // Where the image lives in storage.
    storageKey: text("storage_key").notNull(),

    // SHA-256 (hex string) of the raw bytes of the image.
    sha256: varchar("sha256", { length: 64 }).notNull(),

    // Whether this image is eligible for DB-only search.
    status: imageStatusEnum("status").notNull().default("indexed"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),

    // Model-generated caption.
    caption: text("caption"),

    // Simple counter for how many times users flagged an image.
    flagCount: integer("flag_count").notNull().default(0),

    /**
     * Optional attribution fields (kept minimal by design).
     */
    source: varchar("source", { length: 32 }),

    sourceRef: text("source_ref"),

    // Post URL gives an easy takedown/audit trail.
    sourceUrl: text("source_url"),
  },
  (t) => {
    return [
      // Unique storage key: protects against double-seeding the same object key/url.
      uniqueIndex("images_storage_key_unique").on(t.storageKey),

      uniqueIndex("images_sha256_unique").on(t.sha256),

      // Index status to support fast filtering of only searchable images.
      index("images_status_idx").on(t.status),

      /// An index for Postgres to use to speed up sorting when the candidate set is already filtered.
      index("images_created_at_id_idx").on(t.createdAt, t.id),

      uniqueIndex("images_source_source_ref_unique").on(t.source, t.sourceRef),

      // Optional index: helps for later moderation tooling like
      // “show most-flagged images first”.
      // Cheap now and gives an upgrade path later.
      index("images_flag_count_idx").on(t.flagCount),
    ];
  },
);

/**
 * tags
 */
export const tags = pgTable(
  "tags",
  {
    // Surrogate key for joining.
    id: serial("id").primaryKey(),

    // Normalized tag name.
    name: varchar("name", { length: 64 }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => {
    return [
      /**
       * Unique index for fast “token -> tag id” lookup during search.
       * Important for search performance.
       */
      uniqueIndex("tags_name_unique").on(t.name),
    ];
  },
);

/**
 * image_tags
 *
 * Join table linking images to tags.
 */
export const imageTags = pgTable(
  "image_tags",
  {
    // Foreign key to images.
    imageId: integer("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),

    // Foreign key to tags.
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),

    // Confidence score from the tagger, between 0 and 1.
    confidence: real("confidence").notNull().default(1),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => {
    return [
      /// Composite primary key.
      primaryKey({ columns: [t.imageId, t.tagId] }),

      // Search-critical index.
      index("image_tags_tag_id_image_id_idx").on(t.tagId, t.imageId),

      // Image detail index.
      index("image_tags_image_id_confidence_desc_idx").on(
        t.imageId,
        desc(t.confidence),
      ),

      // DB-level invariant: confidence must be within [0, 1].
      check(
        "image_tags_confidence_between_0_and_1",
        sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`,
      ),
    ];
  },
);

/**
 * Postgres-backed queue for tagging jobs.
 */
export const tagJobStatusEnum = pgEnum("tag_job_status", [
  "queued",
  "running",
  "done",
  "failed",
]);

export const tagJobs = pgTable(
  "tag_jobs",
  {
    id: serial("id").primaryKey(),

    // Which image this job is for.
    imageId: integer("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),

    // Job lifecycle status.
    status: tagJobStatusEnum("status").notNull().default("queued"),

    // Attempts count for retry logic.
    attempts: integer("attempts").notNull().default(0),

    // Last error message for debugging failures.
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
      // Hard invariant: one job per image.
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
