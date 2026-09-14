DROP TABLE "user_state" CASCADE;--> statement-breakpoint
ALTER TABLE "user_settings" DROP COLUMN "energy_default";--> statement-breakpoint
DROP TYPE "public"."energy_level";