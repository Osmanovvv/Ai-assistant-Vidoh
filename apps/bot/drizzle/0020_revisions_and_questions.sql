-- История изменений и открытые вопросы (задачи 3.3 и 3.5).
--
-- Инвариант 7: каждое автоматическое изменение записи пишется в
-- item_revisions со снимком «до». §7.3: «кнопка отмены откатывает
-- последнюю ревизию», и человек должен иметь возможность откатить любое
-- автоматическое решение за один тап.
CREATE TYPE "public"."changed_by" AS ENUM('user', 'resolver', 'scheduler', 'admin');--> statement-breakpoint
CREATE TYPE "public"."question_outcome" AS ENUM('attached', 'separate', 'timeout', 'superseded');--> statement-breakpoint

CREATE TABLE "item_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"changed_by" "changed_by" NOT NULL,
	"reason" text,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"source_message_id" uuid,
	"reverted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "pending_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"segment" text NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"outcome" "question_outcome",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "item_revisions" ADD CONSTRAINT "item_revisions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_revisions" ADD CONSTRAINT "item_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_revisions" ADD CONSTRAINT "item_revisions_source_message_id_messages_raw_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages_raw"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "item_revisions_item_created_idx" ON "item_revisions" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "item_revisions_user_idx" ON "item_revisions" USING btree ("user_id");--> statement-breakpoint

-- Один открытый вопрос на человека. Индексом, а не проверкой в коде:
-- гонка двух выгрузок обошла бы проверку и оставила бы человека с двумя
-- вопросами, то есть с допросом, которого §7.3 не допускает.
CREATE UNIQUE INDEX "pending_questions_open_uq" ON "pending_questions" USING btree ("user_id") WHERE "pending_questions"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "pending_questions_expires_idx" ON "pending_questions" USING btree ("expires_at");
