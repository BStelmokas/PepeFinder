/**
 * Drizzle Kit configuration (production-safe migration flow).
 *
 * This config is used by drizzle-kit CLI commands:
 * - drizzle-kit generate   -> creates SQL migration files
 * - drizzle-kit migrate    -> applies migration files to the DB
 *
 * Key design choice:
 * - Import env from src/env.ts instead of reading process.env here.
 */

import { defineConfig } from "drizzle-kit";
import { env } from "./src/env";

export default defineConfig({
  dialect: "postgresql",

  // schema points to the Drizzle schema definitions.
  schema: "./src/server/db/schema.ts",

  /**
   * out is the folder where migrations are generated.
   * Drizzle's docs commonly use ./drizzle as the migrations folder.
   *
   * This folder is committed to git.
   */
  out: "./drizzle",

  /**
   * dbCredentials tells drizzle-kit where to run migrations.
   * Using a URL is the simplest approach for Postgres.
   */
  dbCredentials: {
    url: env.DATABASE_URL,
  },

  /**
   * strict is a helpful safety mode:
   * - makes drizzle-kit more cautious about ambiguous diffs
   * - reduces surprising migrations
   */
  strict: true,

  // verbose helps when debugging migration issues.
  verbose: true,
});
