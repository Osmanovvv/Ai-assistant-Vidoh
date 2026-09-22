import { z } from 'zod';

/**
 * Схема живого ответа на вопрос о своих делах (слой B, 22.09.2026).
 *
 * §13.4 ТЗ: «Напомни, что я хотела сделать с альбомом» → «Ты хотела
 * сделать семейный альбом. Последний шаг, на котором мы остановились:
 * выбрать первые фотографии.» — прозой, не списком. Записи находит код
 * (`answerBacklogQuery`), модель только говорит о найденном словами.
 * Пустая строка — «сказать нечего», тогда ответ словарный, как раньше.
 * Правила §13 и сверка с фактами — кодом (`backlog/live-answer.ts`).
 */
export const ANSWERER_SCHEMA_NAME = 'answerer.v1';

/** Три коротких фразы; длиннее — уже лекция, а не ответ. */
const MAX_ANSWER = 500;

export const answererSchema = z.object({
  answer: z.string().max(MAX_ANSWER),
});

export type LiveAnswer = z.infer<typeof answererSchema>;
