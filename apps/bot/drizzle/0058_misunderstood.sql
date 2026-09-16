CREATE TABLE "misunderstood" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"batch_id" uuid,
	"said" text NOT NULL,
	"replied" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "misunderstood" ADD CONSTRAINT "misunderstood_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misunderstood" ADD CONSTRAINT "misunderstood_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "misunderstood_created_idx" ON "misunderstood" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "misunderstood_user_idx" ON "misunderstood" USING btree ("user_id","created_at");