-- Первая миграция: пользователь, настройки, журнал апдейтов, сырые сообщения.
--
-- Расширение vector создаётся здесь, а не скриптом инициализации Docker:
-- миграция отрабатывает в любом окружении, включая боевое, и не зависит
-- от того, смонтировалась ли папка с хоста. Само поле embedding появится
-- на задаче 2.9, но расширение должно существовать раньше типа.
--
-- pgcrypto не нужен: gen_random_uuid() входит в ядро начиная с PostgreSQL 13.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."energy_level" AS ENUM('empty', 'low', 'normal', 'high');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'voice', 'audio', 'other');--> statement-breakpoint
CREATE TABLE "messages_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"update_id" bigint NOT NULL,
	"tg_chat_id" bigint NOT NULL,
	"tg_message_id" bigint NOT NULL,
	"tg_thread_id" bigint,
	"kind" "message_kind" NOT NULL,
	"text" text,
	"file_id" text,
	"audio_duration_sec" bigint,
	"transcript" text,
	"batch_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"morning_time" time DEFAULT '08:30' NOT NULL,
	"evening_time" time DEFAULT '21:00' NOT NULL,
	"notifications_on" boolean DEFAULT true NOT NULL,
	"quiet_hours_on" boolean DEFAULT true NOT NULL,
	"energy_default" "energy_level" DEFAULT 'normal' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tg_id" bigint NOT NULL,
	"username" text,
	"first_name" text,
	"language_code" text,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"timezone_confirmed" boolean DEFAULT false NOT NULL,
	"has_topics_enabled" boolean DEFAULT false NOT NULL,
	"referral_source" text,
	"consent_at" timestamp with time zone,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"blocked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_tg_id_unique" UNIQUE("tg_id")
);
--> statement-breakpoint
ALTER TABLE "messages_raw" ADD CONSTRAINT "messages_raw_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_raw_chat_message_uq" ON "messages_raw" USING btree ("tg_chat_id","tg_message_id");--> statement-breakpoint
CREATE INDEX "messages_raw_user_received_idx" ON "messages_raw" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE INDEX "messages_raw_batch_idx" ON "messages_raw" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "telegram_updates_received_at_idx" ON "telegram_updates" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "users_active_last_seen_idx" ON "users" USING btree ("last_active_at") WHERE "users"."is_blocked" = false;
