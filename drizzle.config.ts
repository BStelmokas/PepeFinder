// drizzle.config.ts
/**
 * Drizzle Kit configuration (production-safe migration flow).
 *
 * This config is used by drizzle-kit CLI commands:
 * - drizzle-kit generate   -> creates SQL migration files
 * - drizzle-kit migrate    -> applies migration files to the DB
 *
 * Key design choice:
 * - We import env from src/env.ts instead of reading process.env here.
 *   That preserves your invariant: "only read process.env inside src/env.ts".
 */

import { defineConfig } from "drizzle-kit"; // Drizzle Kit config helper. :contentReference[oaicite:4]{index=4}
import { env } from "./src/env"; // Validated environment variables (the only process.env access in project).

export default defineConfig({
  /**
   * dialect tells drizzle-kit which SQL dialect to generate.
   * For Postgres use "postgresql".
   */
  dialect: "postgresql",

  /**
   * schema points to your Drizzle schema definitions.
   * Keep it exactly where T3 expects it.
   */
  schema: "./src/server/db/schema.ts",

  /**
   * out is the folder where migrations are generated.
   * Drizzle's docs commonly use ./drizzle as the migrations folder.
   *
   * This folder should be committed to git.
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
   * - reduces “surprising” migrations
   */
  strict: true,

  /**
   * verbose helps when debugging migration issues.
   * You can flip this off later if you prefer quieter output.
   */
  verbose: true,
});

// import { type Config } from "drizzle-kit";

// import { env } from "~/env";

// export default {
//   schema: "./src/server/db/schema.ts",
//   dialect: "postgresql",
//   dbCredentials: {
//     url: env.DATABASE_URL,
//   },
//   tablesFilter: ["PepeFinder_*"],
// } satisfies Config;
