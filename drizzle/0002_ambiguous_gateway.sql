ALTER TABLE "images" ADD COLUMN "flag_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "images_flag_count_idx" ON "images" USING btree ("flag_count");