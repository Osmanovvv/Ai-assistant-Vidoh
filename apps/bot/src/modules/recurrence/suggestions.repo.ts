import { and, desc, eq, gte } from 'drizzle-orm';

import {
  recurrenceSuggestions,
  type RecurrenceSuggestion,
  type SuggestionOutcome,
} from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { Rhythm } from './detector.js';

/**
 * Память о предложениях запомнить регулярность (задача 3.8в).
 *
 * Две вещи, без которых функция становится ненавистной за месяц:
 *
 * 1. **Отказ помнится навсегда.** Отклонённую связку бот не предлагает
 *    больше никогда — не «через неделю», не «в следующий раз», а никогда.
 * 2. **Не чаще раза в неделю.** Сколько бы совпадений ни нашлось, за семь
 *    дней человек получает одно предложение. Иначе продукт про выдох
 *    превращается в источник вопросов.
 *
 * Связка узнаётся по пересечению записей, а не по тексту. «Оплатить
 * садик», «садик оплатить» и «заплатить за садик» — одно дело, и текстом
 * их не сопоставить; общая запись в двух связках говорит о них больше,
 * чем любая нормализация.
 */

/** Как часто человек может видеть предложение. */
export const SUGGESTION_COOLDOWN_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;

/** Список записей связки в том виде, в каком он лежит в `jsonb`. */
function idsOf(row: Pick<RecurrenceSuggestion, 'itemIds'>): readonly string[] {
  return Array.isArray(row.itemIds) ? (row.itemIds as string[]) : [];
}

export interface OfferParams {
  readonly userId: string;
  /** Запись, о которой спрашиваем: самая свежая из связки. */
  readonly itemId: string;
  readonly itemIds: readonly string[];
  readonly rhythm: Rhythm;
  readonly now?: Date | undefined;
}

/**
 * Можно ли предложить эту связку.
 *
 * Три причины отказа, и все три — забота о человеке, а не осторожность
 * ради осторожности.
 */
export async function canOffer(
  db: Executor,
  params: { readonly userId: string; readonly itemIds: readonly string[]; readonly now?: Date },
): Promise<boolean> {
  const now = params.now ?? new Date();

  const history = await db
    .select()
    .from(recurrenceSuggestions)
    .where(eq(recurrenceSuggestions.userId, params.userId))
    .orderBy(desc(recurrenceSuggestions.createdAt));

  const wanted = new Set(params.itemIds);

  /**
   * Один раз спросили — больше об этой связке не спрашиваем никогда.
   *
   * Отказ и согласие очевидны: в первом случае человек сказал «нет», во
   * втором правило уже есть. **Молчание сюда же**, и это не мелочь:
   * обход накопленной истории (3.17а) идёт каждый вечер, и связка, о
   * которой человек не ответил, возвращалась бы ровно через неделю —
   * и так до конца жизни продукта. Функция, которая раз в неделю
   * переспрашивает одно и то же, становится ненавистной за месяц.
   *
   * Достаточно одной общей записи: значит речь о том же деле.
   */
  const asked = history.some((row) => idsOf(row).some((id) => wanted.has(id)));

  if (asked) return false;

  return !(await offeredRecently(db, { userId: params.userId, now }));
}

/**
 * Было ли предложение за последние семь дней.
 *
 * Отдельно от `canOffer`, потому что вызывается раньше и без связки:
 * обход накопленной истории (3.17а) стоит куда дороже одного запроса, и
 * начинать его, когда предлагать всё равно нельзя, незачем.
 */
export async function offeredRecently(
  db: Executor,
  params: { readonly userId: string; readonly now?: Date | undefined },
): Promise<boolean> {
  const now = params.now ?? new Date();
  const since = new Date(now.getTime() - SUGGESTION_COOLDOWN_DAYS * DAY_MS);

  const recent = await db
    .select({ id: recurrenceSuggestions.id })
    .from(recurrenceSuggestions)
    .where(
      and(
        eq(recurrenceSuggestions.userId, params.userId),
        gte(recurrenceSuggestions.createdAt, since),
      ),
    )
    .limit(1);

  return recent.length > 0;
}

/** Записывает, что предложение сделано. */
export async function recordOffer(
  db: Executor,
  params: OfferParams,
): Promise<RecurrenceSuggestion> {
  const [row] = await db
    .insert(recurrenceSuggestions)
    .values({
      userId: params.userId,
      itemId: params.itemId,
      itemIds: [...params.itemIds],
      kind: params.rhythm.kind,
      interval: params.rhythm.interval,
    })
    .returning();

  if (!row) throw new Error('Предложение не записалось');
  return row;
}

/** Закрывает предложение ответом человека. */
export async function resolveOffer(
  db: Executor,
  params: {
    readonly suggestionId: string;
    readonly userId: string;
    readonly outcome: SuggestionOutcome;
    readonly now?: Date | undefined;
  },
): Promise<RecurrenceSuggestion | undefined> {
  const [row] = await db
    .update(recurrenceSuggestions)
    .set({ outcome: params.outcome, resolvedAt: params.now ?? new Date() })
    .where(
      and(
        eq(recurrenceSuggestions.id, params.suggestionId),
        eq(recurrenceSuggestions.userId, params.userId),
      ),
    )
    .returning();

  return row;
}
