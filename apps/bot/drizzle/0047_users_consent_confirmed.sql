ALTER TABLE "users" ADD COLUMN "consent_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consent_edition" text;