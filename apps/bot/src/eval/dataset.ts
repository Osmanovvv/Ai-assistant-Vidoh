import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { DEADLINE_ACCURACY, ITEM_TYPES, PRIORITIES } from '../modules/ai/schemas/index.js';
import { RECURRENCE_KINDS } from '../modules/recurrence/recurrence.js';

/**
 * Контрольный набор (задача 2.19).
 *
 * §21 п.10 требует доли верной классификации, §10.3 — прогона на каждое
 * изменение промпта. В §20 контрольный набор стоит на одиннадцатом этапе
 * — это поздно: без него нечем мерить изменения промпта с первого дня
 * разбора.
 *
 * **Где лежит сам набор.** План писал `tests/eval/dataset/*.json`, но
 * настоящие выгрузки — материал заказчицы, а репозиторий публичный.
 * Поэтому размеченный набор живёт в `docs/eval`, вне репозитория, рядом с
 * промптами и по той же причине. В репозитории остаётся только
 * синтетический набор с заранее известным ответом: он выдуман, и на нём
 * проверяется сам стенд.
 *
 * **Ожидание задаётся ключевыми словами, а не дословным текстом.** Модель
 * перефразирует: «проверить список продуктов» превращается в «проверить
 * продукты». Сверка по строке занижала бы качество на пересказе, а не на
 * ошибке. Поэтому единица считается найденной, если в её тексте есть все
 * заданные корни.
 */

const expectedUnitSchema = z.object({
  /**
   * Корни, по которым единица узнаётся. Все обязательны — так «купить
   * кофе» не спутается с «купить пуфики».
   */
  keywords: z.array(z.string().min(2)).min(1),
  type: z.enum(ITEM_TYPES),
  /** Важность или `*`, если разметка её не решает. */
  priority: z.union([z.enum(PRIORITIES), z.literal('*')]),
  /** Тема или `*`: «конспектировать марафон» — это работа или личное? */
  topic: z.string().min(1),
  /** Ожидаемый вид повторения (задача 2.18а). */
  recurrence: z.enum(RECURRENCE_KINDS).default('none'),
  /**
   * Ожидаемая точность срока (задача 2.7): `none` — срока человек не
   * называл, `day` — назвал день, `week`, `month`. Звёздочка — разметка
   * не решает.
   *
   * По умолчанию `none`, и это главное здесь: **отсутствие срока — тоже
   * ожидание.** Выдуманный срок хуже отсутствующего: фильтр выдачи ставит
   * дела «на сегодня» впереди всех, и мелочь с придуманной датой
   * вытесняет из выдачи важное без срока. Именно так и случилось на
   * живой выгрузке 27.08.2026: пять покупок получили сегодняшнюю дату и
   * заняли всю выдачу, а врачи в неё не попали.
   */
  deadline: z.union([z.enum(DEADLINE_ACCURACY), z.literal('*')]).default('none'),
  /** Ожидаемая дата в виде ГГГГ-ММ-ДД, если её можно посчитать однозначно. */
  deadlineDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
  /** Зачем этот случай в наборе. Идёт в отчёт рядом с промахом. */
  why: z.string().default(''),
});

export type ExpectedUnit = z.infer<typeof expectedUnitSchema>;

export const evalCaseSchema = z.object({
  id: z.string().min(1),
  note: z.string().default(''),
  /** Склеенный текст выгрузки — ровно то, что получит разбор. */
  text: z.string().min(1),
  topics: z.array(z.string().min(1)).min(1),
  defaultTopic: z.string().min(1),
  timeZone: z.string().min(1).default('Europe/Moscow'),
  /** Момент разбора: без него «в четверг» плавает от прогона к прогону. */
  now: z.iso.datetime(),
  expected: z.object({
    units: z.array(expectedUnitSchema),
    /** §13.7: ожидается ли срабатывание кризисного контура. */
    crisis: z.boolean().default(false),
  }),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

export class DatasetError extends Error {
  constructor(file: string, problem: string) {
    super(`Набор «${file}» не читается: ${problem}`);
    this.name = 'DatasetError';
  }
}

/**
 * Загружает набор из папки.
 *
 * Кривой файл — это отказ, а не пропуск: набор, из которого молча выпал
 * случай, даёт завышенную оценку качества, и заметить это неоткуда.
 */
export async function loadDataset(directory: string): Promise<EvalCase[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();

  const cases: EvalCase[] = [];

  for (const file of files) {
    const raw = await readFile(join(directory, file), 'utf8');

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new DatasetError(file, 'не разбирается как JSON');
    }

    const parsed = evalCaseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DatasetError(file, parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    cases.push(parsed.data);
  }

  if (cases.length === 0) {
    throw new DatasetError(directory, 'ни одного случая — проверять нечего');
  }

  return cases;
}
