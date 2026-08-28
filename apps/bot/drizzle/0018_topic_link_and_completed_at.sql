ALTER TABLE "items" ADD COLUMN "topic_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Перенос: тема хранилась названием, теперь рядом стоит ссылка.
--
-- Сравнение как в коде (normalizeTopicName): регистр не важен, «ё» равна «е».
-- Записи, чьё название темы ни с чем не совпало, остаются без ссылки — таких
-- быть не должно, но молча выдумывать им тему нельзя.
UPDATE "items" SET "topic_id" = t."id"
FROM "topics" t
WHERE t."user_id" = "items"."user_id"
  AND "items"."topic" IS NOT NULL
  AND lower(replace(t."name", chr(1105), chr(1077)))
      = lower(replace("items"."topic", chr(1105), chr(1077)));
