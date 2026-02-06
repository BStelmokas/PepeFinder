ALTER TABLE "images" ADD COLUMN "source_subreddit" varchar(64);--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "source_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX "images_source_source_ref_unique" ON "images" USING btree ("source","source_ref");