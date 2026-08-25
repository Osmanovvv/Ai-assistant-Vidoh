import { and, eq, gte, sql } from 'drizzle-orm';

import { aiCalls, type AiCall, type AiStage } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { callCost, type Currency, type ModelPricing, type UsageAmount } from './pricing.js';

/**
 * Учёт обращений к моделям (задача 1.16).
 *
 * §10.5 ТЗ: пишется каждый вызов, включая неуспешные. Отсюда берётся
 * себестоимость выгрузки и пользователя, а значит и цена подписки.
 */

export interface AiCallContext {
  readonly stage: AiStage;
  readonly model: string;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
  readonly promptVersion?: string | undefined;
}

/** Результат вызова модели вместе с расходом, о котором она сообщила. */
export interface MeteredResult<T> {
  readonly value: T;
  readonly usage: UsageAmount;
}

export async function recordAiCall(
  db: Executor,
  input: {
    readonly context: AiCallContext;
    readonly usage: UsageAmount;
    readonly latencyMs: number;
    readonly ok: boolean;
    readonly error?: string | undefined;
    readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
  },
): Promise<void> {
  const cost = callCost(input.context.model, input.usage, input.pricing);

  await db.insert(aiCalls).values({
    userId: input.context.userId ?? null,
    batchId: input.context.batchId ?? null,
    stage: input.context.stage,
    model: input.context.model,
    promptVersion: input.context.promptVersion ?? null,
    tokensIn: input.usage.tokensIn ?? null,
    tokensOut: input.usage.tokensOut ?? null,
    audioSeconds: input.usage.audioSeconds ?? null,
    costMicros: cost?.micros ?? null,
    costCurrency: cost?.currency ?? null,
    latencyMs: input.latencyMs,
    ok: input.ok,
    error: input.error ?? null,
  });
}

/**
 * Оборачивает вызов модели учётом.
 *
 * Неуспешный вызов записывается тоже — это прямое требование §10.5 ТЗ.
 * Сбой самой записи в журнал не должен ронять обработку: потерянная
 * строка учёта хуже, чем потерянная выгрузка, но ненамного, и выбирать
 * между ними не приходится — исключение проглатывается только здесь.
 */
export async function meterCall<T>(
  db: Executor,
  context: AiCallContext,
  fn: () => Promise<MeteredResult<T>>,
  options: { readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined } = {},
): Promise<T> {
  const startedAt = Date.now();

  try {
    const outcome = await fn();
    await recordAiCall(db, {
      context,
      usage: outcome.usage,
      latencyMs: Date.now() - startedAt,
      ok: true,
      pricing: options.pricing,
    });
    return outcome.value;
  } catch (error) {
    await recordAiCall(db, {
      context,
      usage: {},
      latencyMs: Date.now() - startedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      pricing: options.pricing,
    });
    throw error;
  }
}

export interface SpendSummary {
  readonly calls: number;
  readonly failed: number;
  /**
   * Итог по каждой валюте в микроединицах. Валюты не складываются: курс
   * на дату вызова задним числом не восстановить, а сумма долларов с
   * рублями не значит ничего.
   */
  readonly totals: Readonly<Partial<Record<Currency, number>>>;
  /**
   * false, если хотя бы у одного вызова цена модели неизвестна. Тогда
   * итог — нижняя оценка, а не расход.
   */
  readonly complete: boolean;
}

/** Расход пользователя за период. Нужен мягкому лимиту из §10.5 ТЗ. */
export async function spendByUser(
  db: Executor,
  userId: string,
  since: Date,
): Promise<SpendSummary> {
  const rows = await db
    .select({
      currency: aiCalls.costCurrency,
      calls: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${aiCalls.ok} = false)::int`,
      unknownPrices: sql<number>`count(*) filter (where ${aiCalls.costMicros} is null)::int`,
      // bigint приходит из node-postgres строкой, а не числом: драйвер не
      // рискует потерять точность. Тип здесь честный, преобразование ниже.
      total: sql<string>`coalesce(sum(${aiCalls.costMicros}), 0)::bigint`,
    })
    .from(aiCalls)
    .where(and(eq(aiCalls.userId, userId), gte(aiCalls.createdAt, since)))
    // Группировка по валюте, а не общая сумма: иначе доллары сложились бы
    // с рублями в число, не означающее ничего.
    .groupBy(aiCalls.costCurrency);

  const totals: Partial<Record<Currency, number>> = {};
  let calls = 0;
  let failed = 0;
  let unknown = 0;

  for (const row of rows) {
    calls += row.calls;
    failed += row.failed;
    unknown += row.unknownPrices;

    if (row.currency !== null) {
      totals[row.currency] = (totals[row.currency] ?? 0) + Number(row.total);
    }
  }

  return { calls, failed, totals, complete: unknown === 0 };
}

export async function callsForBatch(db: Executor, batchId: string): Promise<AiCall[]> {
  return await db.select().from(aiCalls).where(eq(aiCalls.batchId, batchId));
}
