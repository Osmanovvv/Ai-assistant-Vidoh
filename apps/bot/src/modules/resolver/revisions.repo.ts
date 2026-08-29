import { and, desc, eq, isNull } from 'drizzle-orm';

import {
  itemRevisions,
  items,
  type ChangedBy,
  type Item,
  type ItemRevision,
} from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * История изменений записи (инвариант 7, §7.3 ТЗ, задача 3.3).
 *
 * «Каждое применение изменения пишется в историю ревизий вместе со
 * снимком записи до изменения. Кнопка отмены откатывает последнюю
 * ревизию. Пользовательница должна иметь возможность откатить любое
 * автоматическое решение за один тап.»
 *
 * Ревизия — не журнал для нас, а обещание человеку: всё, что бот сделал
 * сам, можно вернуть. Поэтому снимок полный, а не список полей.
 */

/**
 * Поля, которые откат возвращает на место.
 *
 * Список закрытый и намеренно: восстанавливать «всё, кроме служебного»
 * значило бы однажды затереть новую колонку значением из старого снимка,
 * где её просто нет. Здесь же добавление колонки, которую резолвер умеет
 * менять, обязано пройти через этот список — и тест это проверяет.
 */
export const RESTORABLE_FIELDS = [
  'text',
  'body',
  'type',
  'priority',
  'topic',
  'topicId',
  'status',
  'completedAt',
  'deadlineAt',
  'deadlineAccuracy',
  'isProject',
  'assignee',
  'recurrenceRule',
  'recurrenceText',
  'recurrenceSource',
] as const;

export type RestorableField = (typeof RESTORABLE_FIELDS)[number];

/** Что откат вернёт записи. */
type ItemPatch = Partial<Pick<Item, RestorableField>>;

/** Даты в снимке лежат строками: JSON другого способа не знает. */
const DATE_FIELDS = new Set<RestorableField>(['completedAt', 'deadlineAt']);

export interface RecordRevisionParams {
  readonly itemId: string;
  readonly userId: string;
  readonly changedBy: ChangedBy;
  readonly before: Item;
  readonly after: Item;
  readonly reason?: string | undefined;
  readonly sourceMessageId?: string | undefined;
}

export async function recordRevision(
  db: Executor,
  params: RecordRevisionParams,
): Promise<ItemRevision> {
  const [row] = await db
    .insert(itemRevisions)
    .values({
      itemId: params.itemId,
      userId: params.userId,
      changedBy: params.changedBy,
      before: params.before,
      after: params.after,
      reason: params.reason ?? null,
      sourceMessageId: params.sourceMessageId ?? null,
    })
    .returning();

  if (!row) throw new Error('Ревизия не записалась');
  return row;
}

/** Последняя неотменённая ревизия записи. */
export async function lastRevisionOf(
  db: Executor,
  itemId: string,
): Promise<ItemRevision | undefined> {
  const [row] = await db
    .select()
    .from(itemRevisions)
    .where(and(eq(itemRevisions.itemId, itemId), isNull(itemRevisions.revertedAt)))
    .orderBy(desc(itemRevisions.createdAt))
    .limit(1);

  return row;
}

export type RevertOutcome =
  /** Запись вернулась в прежнее состояние. */
  | { readonly kind: 'reverted'; readonly item: Item }
  /** Эту ревизию уже откатывали. Повторное нажатие — не ошибка. */
  | { readonly kind: 'already' }
  /** Ревизии нет: чужая, выдуманная или удалённая вместе с записью. */
  | { readonly kind: 'gone' };

/**
 * Собирает из снимка то, что нужно вернуть записи.
 *
 * Снимок пришёл из `jsonb`, то есть в нём строки и числа, а не `Date`.
 * Поля, которых в снимке нет вовсе, не трогаются: их не было и в записи.
 */
function restoreFrom(before: unknown): ItemPatch {
  /**
   * Снимок — сериализованная строка той самой таблицы, а перечень полей
   * закрыт списком выше. Проверять каждое значение по отдельности
   * значило бы переписать схему второй раз, уже руками.
   */
  const snapshot = (before ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  for (const field of RESTORABLE_FIELDS) {
    if (!(field in snapshot)) continue;

    const value = snapshot[field];
    patch[field] =
      DATE_FIELDS.has(field) && typeof value === 'string' ? new Date(value) : (value ?? null);
  }

  return patch;
}

/**
 * Откатывает ревизию.
 *
 * **Проверяется владелец, а не только идентификатор.** Короткий код
 * ревизии приходит из нажатия, то есть снаружи, и его можно подобрать.
 *
 * **Повторное нажатие идемпотентно.** Кнопка остаётся в чате навсегда, и
 * человек нажмёт её ещё раз хотя бы случайно. Второй откат вернул бы
 * запись к состоянию, которого человек уже не ждёт.
 */
export async function revertRevision(
  db: Executor,
  params: { readonly revisionId: string; readonly userId: string },
): Promise<RevertOutcome> {
  const [revision] = await db
    .select()
    .from(itemRevisions)
    .where(and(eq(itemRevisions.id, params.revisionId), eq(itemRevisions.userId, params.userId)))
    .limit(1);

  if (!revision) return { kind: 'gone' };
  if (revision.revertedAt !== null) return { kind: 'already' };

  const patch = restoreFrom(revision.before);

  const [item] = await db
    .update(items)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(items.id, revision.itemId), eq(items.userId, params.userId)))
    .returning();

  if (!item) return { kind: 'gone' };

  await db
    .update(itemRevisions)
    .set({ revertedAt: new Date() })
    .where(eq(itemRevisions.id, revision.id));

  return { kind: 'reverted', item };
}
