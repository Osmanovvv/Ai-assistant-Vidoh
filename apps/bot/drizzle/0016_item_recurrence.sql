CREATE TYPE "public"."recurrence_source" AS ENUM('stated', 'asked', 'noticed', 'history');--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "recurrence_rule" jsonb;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "recurrence_text" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "recurrence_source" "recurrence_source";--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_recurrence_task_only" CHECK ("items"."recurrence_rule" is null or "items"."type" = 'TASK');--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_recurrence_has_source" CHECK (("items"."recurrence_rule" is null and "items"."recurrence_text" is null) or "items"."recurrence_source" is not null);