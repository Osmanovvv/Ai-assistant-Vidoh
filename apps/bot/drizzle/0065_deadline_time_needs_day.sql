-- Час — только у точного срока, теперь без дыры для пустой точности
-- («с нуля» Никиты 25.09.2026).
--
-- Прежний страж сравнивал пустую точность с 'day', получал NULL, а NULL
-- проверка пропускает. Умолчание «Позже» так и оставляло час у дела без
-- дня; новый день потом молча получал старый час.
--
-- Сперва уборка: пока выкладка не дошла, старый код ещё может оставить
-- такой час, и новый страж без неё уронил бы миграцию — а с ней и бота.
-- Час без дня никому не виден и ничего не значит; на бою 25.09.2026 таких
-- записей было 0.
UPDATE "items" SET "deadline_time" = NULL
WHERE "deadline_time" IS NOT NULL AND "deadline_accuracy" IS DISTINCT FROM 'day';--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_deadline_time_day_only";--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_deadline_time_day_only" CHECK ("items"."deadline_time" is null or ("items"."deadline_accuracy" is not null and "items"."deadline_accuracy" = 'day' and "items"."deadline_time" between 0 and 1439));
