DO $$ BEGIN
	CREATE TYPE "image_status" AS ENUM ('pending', 'indexed', 'failed');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
	CREATE TYPE "public"."tag_job_status" AS ENUM ('queued', 'running', 'done', 'failed');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
CREATE TABLE IF NOT EXISTS "image_tags" (
	"image_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_tags_image_id_tag_id_pk" PRIMARY KEY("image_id","tag_id"),
	CONSTRAINT "image_tags_confidence_between_0_and_1" CHECK ("image_tags"."confidence" >= 0 AND "image_tags"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS  "images" (
	"id" serial PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"status" "image_status" DEFAULT 'indexed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" varchar(32),
	"source_ref" text,
	"source_subreddit" varchar(64),
	"source_url" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS  "tag_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"image_id" integer NOT NULL,
	"status" "tag_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS  "tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "image_tags"
    ADD CONSTRAINT "image_tags_image_id_images_id_fk"
    FOREIGN KEY ("image_id") REFERENCES "images"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "image_tags"
    ADD CONSTRAINT "image_tags_tag_id_tags_id_fk"
    FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "tag_jobs"
    ADD CONSTRAINT "tag_jobs_image_id_images_id_fk"
    FOREIGN KEY ("image_id") REFERENCES "public"."images"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS  "image_tags_tag_id_image_id_idx" ON "image_tags" USING btree ("tag_id","image_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS  "image_tags_image_id_confidence_desc_idx" ON "image_tags" USING btree ("image_id","confidence" desc);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS  "images_storage_key_unique" ON "images" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS  "images_sha256_unique" ON "images" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS  "images_status_idx" ON "images" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS  "images_created_at_id_idx" ON "images" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS  "images_source_source_ref_unique" ON "images" USING btree ("source","source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS  "tag_jobs_image_id_unique" ON "tag_jobs" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS  "tag_jobs_status_created_at_idx" ON "tag_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS  "tags_name_unique" ON "tags" USING btree ("name");
