CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"html" text NOT NULL,
	"edition_date" date,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_by" text
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"slug" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"html" text NOT NULL,
	"edition_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_slug_documents_slug_fk" FOREIGN KEY ("slug") REFERENCES "public"."documents"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_versions_slug_idx" ON "document_versions" USING btree ("slug","saved_at");