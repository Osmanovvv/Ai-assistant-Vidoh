ALTER TABLE "items" ADD COLUMN "deferred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "offered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "reviewed_at" timestamp with time zone;