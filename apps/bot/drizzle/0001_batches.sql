CREATE TYPE "public"."batch_status" AS ENUM('open', 'queued', 'processing', 'awaiting_answer', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "batch_status" DEFAULT 'open' NOT NULL,
	"combined_text" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batches_one_open_per_user_uq" ON "batches" USING btree ("user_id") WHERE "batches"."status" = 'open';--> statement-breakpoint
CREATE INDEX "batches_status_opened_idx" ON "batches" USING btree ("status","opened_at");--> statement-breakpoint
CREATE INDEX "batches_user_opened_idx" ON "batches" USING btree ("user_id","opened_at");