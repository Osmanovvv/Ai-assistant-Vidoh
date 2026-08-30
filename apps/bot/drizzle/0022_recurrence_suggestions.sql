-- Предложения запомнить регулярность (задача 3.8в).
--
-- Бот замечает, что «оплатить садик» приходит четвёртый раз примерно
-- раз в месяц, и предлагает запомнить это как правило.
--
-- **Отказ запоминается навсегда — это половина задачи.** Функция,
-- которая раз в неделю переспрашивает одно и то же, становится
-- ненавистной за месяц.
--
-- Связка хранится списком записей, а не текстом: «оплатить садик»,
-- «садик оплатить» и «заплатить за садик» — одно дело, и текстом их не
-- сопоставить.
CREATE TYPE "public"."suggestion_outcome" AS ENUM('accepted', 'declined', 'ignored');--> statement-breakpoint

CREATE TABLE "recurrence_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"item_ids" jsonb NOT NULL,
	"kind" text NOT NULL,
	"interval" integer NOT NULL,
	"outcome" "suggestion_outcome",
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "recurrence_suggestions" ADD CONSTRAINT "recurrence_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_suggestions" ADD CONSTRAINT "recurrence_suggestions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "recurrence_suggestions_user_created_idx" ON "recurrence_suggestions" USING btree ("user_id","created_at");
