import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { itemStatus } from '../db/schema.js';
import type { Candidate } from '../modules/resolver/candidates.js';
import { RESOLVER_ACTIONS, RESOLVER_MODES } from '../modules/ai/schemas/index.js';

/**
 * Контрольный набор резолвера (§10.3 ТЗ, к задачам 3.1–3.7).
 *
 * **Его не было, и это дыра того же рода, из-за которой `router@4` уехал в
 * бой с потерей трёх единиц.** Промпт есть, пороги есть, а измерить их
 * нечем: нынешний набор мерит разбор выгрузки, а резолвер принимает
 * решение о существующей записи. Разные задачи, разные ошибки.
 *
 * **Случай здесь — это не текст, а положение.** Что человек сказал, какие
 * записи у него были в этот момент, откуда каждая взялась и насколько
 * свежая. Именно от этого зависит решение, а не от одной фразы.
 *
 * **Подбор кандидатов сюда не входит.** У него свои тесты на живой базе;
 * здесь кандидаты заданы прямо, чтобы мерить только решение. Иначе
 * промах подбора выглядел бы как ошибка резолвера, и чинили бы не то.
 *
 * Настоящие случаи живут в `docs/eval/resolver` — вне репозитория, как
 * и остальной набор: это материал заказчицы. В репозитории остаётся
 * синтетический, на котором проверяется сам стенд.
 */

/** Кандидат в разметке: то же, что видит модель, но словами разметчика. */
const candidateSchema = z.object({
  text: z.string().min(1),
  topic: z.string().min(1).nullable().default(null),
  /** Срок в виде ГГГГ-ММ-ДД или пусто. */
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .nullable()
    .default(null),
  status: z.enum(itemStatus.enumValues).default('new'),
  /**
   * Сколько минут назад запись трогали.
   *
   * От этого зависит подтверждение свежестью, а значит и разница между
   * «применить» и «спросить». Число, а не дата: случай не должен
   * протухать оттого, что прошёл месяц.
   */
  updatedMinutesAgo: z.number().min(0).default(60),
  sources: z
    .array(z.enum(['session', 'semantic', 'deadline']))
    .min(1)
    .default(['session']),
  similarity: z.number().min(0).max(1).nullable().default(null),
});

const expectedSchema = z.object({
  /** Что должна решить пороговая логика. */
  kind: z.enum(['apply', 'ask', 'create']),
  /**
   * Номер кандидата в списке, начиная с единицы. Ноль — записи нет.
   *
   * Проверяется только при `apply` и `ask`: при `create` речь ни о какой
   * записи не идёт.
   *
   * **Список номеров означает «любой из них подойдёт».** Бывают случаи,
   * где неопределённость и есть суть: «купила» при двух одинаково
   * свежих покупках. Решение там определено — спросить, — а про какую из
   * двух спрашивать, не определено ничем. Требовать в разметке одну
   * значило бы мерить не качество разбора, а совпадение с моей догадкой.
   * Первый же прогон на это и наткнулся.
   */
  target: z.union([z.number().int().min(0), z.array(z.number().int().min(1)).min(1)]).default(0),
  /** Ожидаемое действие. Не задано — не проверяется. */
  action: z.enum(RESOLVER_ACTIONS).optional(),
  /**
   * §7.4: ожидается замена полей или дополнение подробностей.
   *
   * Не задано — случай не про это различение, и требовать от модели
   * угаданного режима было бы придиркой.
   */
  mode: z.enum(RESOLVER_MODES).optional(),
  /**
   * Что должно случиться с формулировкой записи.
   *
   * `unchanged` — модель не имеет права переписывать заголовок: человек
   * поправил срок, а не слова. `rewritten` — наоборот, поправка сидит
   * **внутри** формулировки, и без нового текста запись останется врать.
   *
   * **Ради этого поля набор и расширен** (02.09.2026). Промпт можно
   * попросить смелее переписывать текст — и получить взамен, что модель
   * начнёт переписывать слова человека там, где её не просили. Пока риск
   * не измеряется, такую правку выкладывать нельзя.
   */
  text: z.enum(['unchanged', 'rewritten']).optional(),
  /** Ожидаемый новый срок в виде ГГГГ-ММ-ДД, если случай про срок. */
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
});

export const resolverCaseSchema = z.object({
  id: z.string().min(1),
  /** Откуда взят случай: живая речь или придуман. Это важно знать. */
  note: z.string().min(1),
  /** Что человек сказал сейчас. */
  segment: z.string().min(1),
  timeZone: z.string().min(1).default('Europe/Moscow'),
  /** Момент, от которого считается свежесть и сроки. */
  now: z.string().min(1),
  candidates: z.array(candidateSchema),
  expected: expectedSchema,
});

export type ResolverCase = z.infer<typeof resolverCaseSchema>;

export class ResolverDatasetError extends Error {
  constructor(file: string, problem: string) {
    super(`Случай «${file}» размечен неверно: ${problem}`);
    this.name = 'ResolverDatasetError';
  }
}

/**
 * Превращает разметку в то, что видит резолвер.
 *
 * Даты считаются от `now` случая, а не от часов: набор, который через
 * месяц начинает мерить другое, — это не набор.
 */
export function candidatesOf(item: ResolverCase): Candidate[] {
  const now = new Date(item.now);

  return item.candidates.map((candidate, index) => ({
    // Идентификатор виден только нам: модели уходят номера.
    id: `case-${item.id}-${String(index + 1)}`,
    text: candidate.text,
    topic: candidate.topic,
    deadlineAt:
      candidate.deadline === null ? null : new Date(`${candidate.deadline}T00:00:00.000Z`),
    status: candidate.status,
    updatedAt: new Date(now.getTime() - candidate.updatedMinutesAgo * 60_000),
    similarity: candidate.similarity,
    sources: candidate.sources,
  }));
}

/** Номера кандидатов, любой из которых считается верным. */
export function targetsOf(item: ResolverCase): readonly number[] {
  const target = item.expected.target;
  if (Array.isArray(target)) return target;
  return target === 0 ? [] : [target];
}

export async function loadResolverCases(directory: string): Promise<ResolverCase[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const cases: ResolverCase[] = [];

  for (const file of files) {
    const raw: unknown = JSON.parse(await readFile(join(directory, file), 'utf8'));
    const parsed = resolverCaseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new ResolverDatasetError(file, parsed.error.issues[0]?.message ?? 'не по схеме');
    }

    const item = parsed.data;

    // Ожидание, указывающее на несуществующего кандидата, — это ошибка
    // разметки, и она обязана падать здесь, а не искажать замер.
    const wanted = targetsOf(item);

    for (const number of wanted) {
      if (number > item.candidates.length) {
        throw new ResolverDatasetError(file, `кандидата №${String(number)} нет`);
      }
    }

    if (item.expected.kind !== 'create' && wanted.length === 0) {
      throw new ResolverDatasetError(file, 'для «применить» и «спросить» нужен номер записи');
    }

    cases.push(item);
  }

  return cases;
}
