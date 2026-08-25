CREATE TYPE "public"."deadline_accuracy" AS ENUM('day', 'week', 'month');--> statement-breakpoint
CREATE TYPE "public"."item_priority" AS ENUM('NOW', 'SOON', 'LATER', 'NONE');--> statement-breakpoint
CREATE TYPE "public"."item_status" AS ENUM('new', 'active', 'in_progress', 'waiting', 'delegated', 'done', 'snoozed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."item_type" AS ENUM('TASK', 'DESIRE', 'IDEA', 'INFO', 'EMOTION');--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_batch_id" uuid,
	"text" text NOT NULL,
	"type" "item_type",
	"priority" "item_priority",
	"topic" text,
	"status" "item_status" DEFAULT 'new' NOT NULL,
	"is_project" boolean DEFAULT false NOT NULL,
	"assignee" text,
	"deadline_at" timestamp with time zone,
	"deadline_accuracy" "deadline_accuracy",
	"is_draft" boolean DEFAULT false NOT NULL,
	"draft_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_draft_or_classified" CHECK (("items"."is_draft" = true) or ("items"."type" is not null and "items"."priority" is not null and "items"."topic" is not null)),
	CONSTRAINT "items_deadline_with_accuracy" CHECK (("items"."deadline_at" is null) = ("items"."deadline_accuracy" is null))
);
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_source_batch_id_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_user_status_priority_idx" ON "items" USING btree ("user_id","status","priority");--> statement-breakpoint
CREATE INDEX "items_user_deadline_idx" ON "items" USING btree ("user_id","deadline_at");--> statement-breakpoint
CREATE INDEX "items_source_batch_idx" ON "items" USING btree ("source_batch_id");--> statement-breakpoint
CREATE INDEX "items_drafts_idx" ON "items" USING btree ("created_at") WHERE "items"."is_draft" = true;