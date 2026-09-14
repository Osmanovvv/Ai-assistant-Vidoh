-- Шаг опроса «какие сферы важны» убран (правка заказчицы 14.09.2026,
-- п. 1.1): «закончен» был шестым, стал пятым. Кто стоял на прежнем пятом
-- (сферы не выбраны) — опрос для него закончен: вопросов больше нет.
UPDATE "user_settings"
   SET "onboarding_step" = 5,
       "onboarding_done_at" = coalesce("onboarding_done_at", now())
 WHERE "onboarding_step" >= 5;
