CREATE TYPE "public"."ai_stage" AS ENUM('speech', 'router', 'extractor', 'classifier', 'resolver', 'presenter', 'decomposer', 'embedder');--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"batch_id" uuid,
	"stage" "ai_stage" NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"audio_seconds" integer,
	"cost_micros" bigint,
	"latency_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_user_created_idx" ON "ai_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_calls_batch_idx" ON "ai_calls" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "ai_calls_stage_created_idx" ON "ai_calls" USING btree ("stage","created_at");--> statement-breakpoint
CREATE INDEX "ai_calls_failed_idx" ON "ai_calls" USING btree ("created_at") WHERE "ai_calls"."ok" = false;