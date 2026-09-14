ALTER TABLE "billing_consents" ADD COLUMN "offer_edition" text;--> statement-breakpoint
-- Периодичность обязательна, а строки уже есть: единственный периодический
-- тариф — месяц, поэтому старые заполняются «раз в месяц», а умолчание
-- снимается — новые строки обязаны писать периодичность сами.
ALTER TABLE "billing_consents" ADD COLUMN "period" text DEFAULT 'P1M' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_consents" ALTER COLUMN "period" DROP DEFAULT;
