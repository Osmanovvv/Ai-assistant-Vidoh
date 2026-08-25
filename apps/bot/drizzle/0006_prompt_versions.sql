CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage" "ai_stage" NOT NULL,
	"version" text NOT NULL,
	"prompt" text NOT NULL,
	"schema_name" text NOT NULL,
	"schema_json" jsonb NOT NULL,
	"note" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_stage_version_uq" ON "prompt_versions" USING btree ("stage","version");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_one_active_per_stage_uq" ON "prompt_versions" USING btree ("stage") WHERE "prompt_versions"."is_active";