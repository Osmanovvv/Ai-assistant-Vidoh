import { z } from 'zod';

/**
 * Схема чтения ответа на вопрос бота (шаг 3 плана docs/28, 28.09.2026).
 *
 * Бот спросил «07:00 или 19:00?», «Какое дело?», «Перенести «X»?» — и код
 * по своим спискам ответа не узнал. Модель говорит, что человек имел в
 * виду: ответил ли, что выбрал, есть ли в реплике новая мысль. Решает
 * по-прежнему код: выбор сверяется с предложенным, мысль — с репликой
 * (`resolver/answer-reader.ts`).
 */
export const READER_SCHEMA_NAME = 'reader.v1';

export const READER_KINDS = [
  'answer',
  'not_answer',
  'counter_question',
  'undecided',
  'ambiguous',
] as const;

export const readerSchema = z.object({
  kind: z.enum(READER_KINDS),
  choice: z.string().max(200),
  thought: z.string().max(1000),
});

export type ReaderReading = z.infer<typeof readerSchema>;
