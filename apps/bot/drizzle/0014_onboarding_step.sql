ALTER TABLE "user_settings" ADD COLUMN "onboarding_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "onboarding_done_at" timestamp with time zone;