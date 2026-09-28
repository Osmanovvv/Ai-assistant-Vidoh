import { z } from 'zod';

/**
 * Схема живого ответа там, где у бота нет своего (план docs/29,
 * 28.09.2026): болтовня, вопрос про бота, просьба, чувства без дел,
 * обрывок. Модель пишет одну-три фразы; факты даёт код и он же проверяет
 * ответ (`talk/talk.ts`). Пусто — сказать нечего, ответ словарный.
 */
export const TALKER_SCHEMA_NAME = 'talker.v1';

/** Три коротких фразы; длиннее страж и так не пропустит. */
const MAX_REPLY = 400;

export const talkerSchema = z.object({
  reply: z.string().max(MAX_REPLY),
});

export type TalkReply = z.infer<typeof talkerSchema>;
