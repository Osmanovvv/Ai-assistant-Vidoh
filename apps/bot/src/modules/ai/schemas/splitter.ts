import { z } from 'zod';

/**
 * Схема деления покупки на позиции (правка заказчицы 29.09.2026): «Купить
 * овощи, мясо и специи» → «овощи», «мясо», «специи». Модель называет
 * позиции словами самого дела; пусто — это одна покупка. Честность деления
 * проверяет код (`classifier/purchase-split.ts`).
 */
export const SPLITTER_SCHEMA_NAME = 'splitter.v1';

/** Позиция — кусок одного названия дела; двадцать — с запасом на список. */
const MAX_POSITION = 120;
const MAX_POSITIONS = 20;

export const splitterSchema = z.object({
  positions: z.array(z.string().max(MAX_POSITION)).max(MAX_POSITIONS),
});

export type SplitterReply = z.infer<typeof splitterSchema>;
