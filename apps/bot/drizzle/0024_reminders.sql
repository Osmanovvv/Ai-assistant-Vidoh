-- Напоминания (§11 ТЗ, задача 3.14).
--
-- Планировщик раскладывает будущее по строкам, а отправка потом читает
-- готовое. Разделение нужно ради двух вещей: ключа, исключающего дубли
-- при повторном запуске, и распределения отправки во времени — Telegram
-- не даёт разослать всё разом.
--
-- item_id необязателен: у утреннего и вечернего напоминания записи нет,
-- определяющим является kind.
CREATE TYPE "public"."reminder_kind" AS ENUM('morning', 'evening', 'deadline_eve', 'deadline_day', 'project');--> statement-breakpoint

CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid,
	"kind" "reminder_kind" NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"dedupe_key" text NOT NULL,
	"sent_at" timestamp with time zone,
	"skipped_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Тот самый ключ. Уникальность в базе, а не проверкой перед вставкой:
-- между «проверил» и «вставил» помещается второй экземпляр процесса.
CREATE UNIQUE INDEX "reminders_user_key_uq" ON "reminders" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "reminders_pending_idx" ON "reminders" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "reminders_user_kind_idx" ON "reminders" USING btree ("user_id","kind");--> statement-breakpoint

-- Границы тишины (задача 3.17). Выключатель quiet_hours_on существовал
-- с задачи 2.13 и до сих пор ничего не выключал: часов, которые он мог
-- бы погасить, не было.
ALTER TABLE "user_settings" ADD COLUMN "quiet_from" time DEFAULT '22:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "quiet_to" time DEFAULT '08:00' NOT NULL;
