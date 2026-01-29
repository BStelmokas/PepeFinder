DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_type
		WHERE typname = 'tag_job_status'
	) THEN
		CREATE TYPE tag_job_status AS ENUM ('queued', 'running', 'done', 'failed');
	END IF;
END $$;

CREATE TABLE IF NOT EXISTS "tag_jobs" (
	"id" serial PRIMARY KEY,
	"image_id" integer NOT NULL REFERENCES "images"("id") ON DELETE CASCADE,
	"status" tag_job_status NOT NULL DEFAULT 'queued',
	"attempts" integer NOT NULL DEFAULT 0,
	"last_error" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "tag_jobs_image_id_unique"
	ON "tag_jobs" ("image_id");

CREATE INDEX IF NOT EXISTS "tag_jobs_status_created_at_idx"
	ON "tag_jobs" ("status", "created_at");
