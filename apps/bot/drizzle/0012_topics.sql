CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"emoji" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"tg_thread_id" integer,
	"summary_message_id" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "topics_user_name_uq" ON "topics" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_user_thread_uq" ON "topics" USING btree ("user_id","tg_thread_id") WHERE "topics"."tg_thread_id" is not null;--> statement-breakpoint
CREATE INDEX "topics_user_sort_idx" ON "topics" USING btree ("user_id","sort_order");