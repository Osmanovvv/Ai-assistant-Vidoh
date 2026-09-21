ALTER TYPE "public"."reminder_kind" ADD VALUE 'deadline_hour' BEFORE 'project';--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "deadline_time" integer;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_deadline_time_day_only" CHECK ("items"."deadline_time" is null or ("items"."deadline_accuracy" = 'day' and "items"."deadline_time" between 0 and 1439));