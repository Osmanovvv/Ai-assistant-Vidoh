CREATE TYPE "public"."currency" AS ENUM('usd', 'rub');--> statement-breakpoint
ALTER TABLE "ai_calls" ADD COLUMN "cost_currency" "currency";