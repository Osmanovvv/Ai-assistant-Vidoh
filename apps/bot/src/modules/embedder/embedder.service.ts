import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { items, type ItemStatusValue } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { withRetry, withTimeout, type RetryOptions } from '../../infra/retry.js';
import { meterCall } from '../metering/ai-calls.repo.js';
import type { ModelPricing } from '../metering/pricing.js';
import type { EmbeddingProvider, EmbeddingPurpose } from './providers/types.js';

/**
 * Смысловые представления записей (задача 2.9).
 *
 * §7.2 ТЗ требует смыслового поиска: чтобы понять, о какой записи человек
 * говорит «а, и ещё про врача», сравнения по словам не хватает — он может
 * назвать то же дело совсем другими словами.
 *
 * Вектор считается при создании записи и попадает в `ai_calls`: без этого
 * учёт расхода неполон, а себестоимость выгрузки на задаче 2.21
 * окажется занижена.
 */

export interface EmbedDeps {
  readonly db: Executor;
  readonly provider: EmbeddingProvider;
  readonly retry?: RetryOptions | undefined;
  readonly timeoutMs?: number | undefined;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
  readonly logger?: Logger | undefined;
}

export interface EmbedParams {
  readonly text: string;
  readonly purpose: EmbeddingPurpose;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function embedText(deps: EmbedDeps, params: EmbedParams): Promise<readonly number[]> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return await meterCall(
    deps.db,
    {
      stage: 'embedder',
      model: deps.provider.name,
      userId: params.userId,
      batchId: params.batchId,
    },
    async () => {
      const result = await withRetry(
        () =>
          withTimeout(
            () => deps.provider.embed({ text: params.text, purpose: params.purpose }),
            timeoutMs,
            'смысловое представление',
          ),
        deps.retry ?? {},
      );

      return { value: result.vector, usage: { tokensIn: result.tokens } };
    },
    { pricing: deps.pricing },
  );
}

/**
 * Литерал вектора для pgvector.
 *
 * Числа проходят через `Number`, а не подставляются как есть: строка,
 * попавшая в вектор, стала бы инъекцией в SQL. Параметризовать сам вектор
 * нельзя — драйвер не знает типа `vector`, поэтому он собирается строкой,
 * и безопасность обеспечивается здесь.
 */
export function toVectorLiteral(vector: readonly unknown[]): string {
  const numbers = vector.map((value) => {
    // Тип здесь намеренно `unknown`: вектор приходит из ответа модели и
    // из базы, то есть снаружи, и обещаниям типов тут верить нельзя.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('вектор содержит не число');
    }
    return value;
  });

  return `[${numbers.join(',')}]`;
}

/** Статусы, среди которых имеет смысл искать: §7.2 говорит об активных. */
const SEARCHABLE_STATUSES: readonly ItemStatusValue[] = [
  'new',
  'active',
  'in_progress',
  'waiting',
  'snoozed',
];

export interface SimilarItem {
  readonly id: string;
  /** Заголовок записи. §7.2 запрещает передавать модели полные тексты. */
  readonly text: string;
  readonly topic: string | null;
  readonly deadlineAt: Date | null;
  readonly status: ItemStatusValue;
  readonly updatedAt: Date;
  /** От нуля до единицы: единица — совпадение по смыслу. */
  readonly similarity: number;
}

export interface FindSimilarParams {
  readonly userId: string;
  readonly vector: readonly number[];
  readonly limit?: number;
  /** §8.1 ТЗ: сообщение внутри темы сужает поиск до этой темы. */
  readonly topic?: string | undefined;
  readonly statuses?: readonly ItemStatusValue[] | undefined;
}

const DEFAULT_LIMIT = 10;

/**
 * Ищет записи, близкие по смыслу.
 *
 * Фильтр по `user_id` обязателен и стоит первым: чужие записи не должны
 * попадать в поиск ни при какой ошибке в остальных условиях.
 *
 * Оператор `<=>` — косинусное расстояние: ноль означает совпадение.
 * Близость возвращается как единица минус расстояние, потому что «больше
 * значит похожее» читается проще, чем наоборот.
 */
export async function findSimilarItems(
  db: Executor,
  params: FindSimilarParams,
): Promise<SimilarItem[]> {
  const literal = toVectorLiteral(params.vector);
  const statuses = params.statuses ?? SEARCHABLE_STATUSES;
  const limit = params.limit ?? DEFAULT_LIMIT;

  const rows = await db
    .select({
      id: items.id,
      text: items.text,
      topic: items.topic,
      deadlineAt: items.deadlineAt,
      status: items.status,
      updatedAt: items.updatedAt,
      similarity: sql<number>`1 - (${items.embedding} <=> ${sql.raw(`'${literal}'::vector`)})`,
    })
    .from(items)
    .where(
      sql`${items.userId} = ${params.userId}
        and ${items.embedding} is not null
        and ${items.isDraft} = false
        and ${items.status} = any(${sql.raw(`array[${statuses.map((status) => `'${status}'`).join(',')}]::item_status[]`)})
        ${params.topic === undefined ? sql`` : sql`and ${items.topic} = ${params.topic}`}`,
    )
    .orderBy(sql`${items.embedding} <=> ${sql.raw(`'${literal}'::vector`)}`)
    .limit(limit);

  // Близость приходит числом: node-postgres разбирает double precision
  // сам, в отличие от bigint, который отдаёт строкой.
  return rows;
}

/** Дописывает вектор к уже существующей записи. Нужен досчёту. */
export async function setItemEmbedding(
  db: Executor,
  itemId: string,
  vector: readonly number[],
): Promise<void> {
  const literal = toVectorLiteral(vector);

  await db.execute(
    sql`update ${items} set embedding = ${sql.raw(`'${literal}'::vector`)}, updated_at = now() where ${items.id} = ${itemId}`,
  );
}
