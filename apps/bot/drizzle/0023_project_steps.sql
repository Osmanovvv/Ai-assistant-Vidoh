-- Шаги большой составной цели (§5 ТЗ, задача 3.12).
--
-- «День рождения сына» — это не задача, а проект: внутри десяток дел, и
-- человек думает о нём как об одном. §13.2 требует урезать большую цель
-- до посильного первого шага, поэтому наружу выдаётся только ближайший
-- шаг. Десять пунктов в ответ на «что сегодня» — это не помощь, а та же
-- гора, только в профиль.
--
-- Отдельной таблицей, а не записями: у шагов нет ни темы, ни приоритета,
-- ни срока, и попав в общий список дел они удвоили бы его.
CREATE TABLE "project_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"position" integer NOT NULL,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "project_steps" ADD CONSTRAINT "project_steps_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_steps" ADD CONSTRAINT "project_steps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Два шага с номером три — это два «ближайших», и выдача начнёт
-- показывать то один, то другой в зависимости от порядка строк.
CREATE UNIQUE INDEX "project_steps_item_position_uq" ON "project_steps" USING btree ("item_id","position");--> statement-breakpoint
CREATE INDEX "project_steps_user_idx" ON "project_steps" USING btree ("user_id");
