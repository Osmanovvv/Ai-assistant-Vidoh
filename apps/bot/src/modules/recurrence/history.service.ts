import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { items } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { findSimilarItems } from '../embedder/embedder.service.js';
import { detectRhythm, MIN_OCCURRENCES } from './detector.js';
import { canOffer, offeredRecently, recordOffer } from './suggestions.repo.js';
import { SAME_TASK_SIMILARITY, type Suggestion } from './suggest.service.js';

/**
 * Регулярность в накопленной истории (запрос на изменение №1, способ
 * четвёртый, задача 3.17а).
 *
 * Определитель из 3.8в смотрит на новую запись и ищет ей прошлое. Здесь
 * наоборот: бот проходит по накопленной истории человека и ищет то, что
 * оказалось регулярным, хотя ни разу так не называлось.
 *
 * **Разница не в алгоритме, а в поводе.** 3.8в срабатывает в момент
 * выгрузки и потому видит только те связки, чьё третье повторение
 * случилось при нём. Обход видит и те, что сложились раньше, — и те, о
 * которых человек перестал говорить, а дело осталось.
 *
 * **Стоит это почти ничего.** Векторы посчитаны при создании записей
 * (2.9), группировка — запросы к базе по индексу, обращения к модели нет
 * вовсе: формулировку собирает `suggest-text.ts` из дат и вида ритма.
 *
 * **Ежедневный проход не нужен.** Если дело регулярное, неделя ничего не
 * решает, а недельный предел на предложения (3.8в) всё равно не даст
 * спросить чаще. Поэтому предел проверяется **до** обхода, а не после:
 * начинать дорогую работу, зная, что спросить нельзя, незачем.
 */

/**
 * Сколько записей просматриваем.
 *
 * Потолок, а не полнота: у человека с тысячей записей обход по всем
 * означал бы тысячу запросов к векторному индексу каждый вечер. Триста
 * свежих покрывают год жизни в продукте, а связка, не попавшая в них,
 * давно не пополнялась — и предлагать по ней правило уже поздно.
 */
export const HISTORY_DEPTH = 300;

/** Сколько похожих тянем на каждую запись: связки длиннее не бывают. */
const FAMILY_LIMIT = 12;

/**
 * Где ищем связку.
 *
 * Закрытые в первую очередь — план говорит про «закрытую историю», и
 * регулярное дело выглядит именно так: его раз за разом закрывают. Но
 * открытые из связки не выкидываем: у ежемесячной оплаты последняя
 * запись обычно ещё открыта, и без неё повторений окажется на одно
 * меньше, чем на самом деле.
 */
const FAMILY_STATUSES = ['done', 'new', 'active', 'in_progress', 'waiting', 'snoozed'] as const;

export interface HistoryDeps {
  readonly db: Database;
  readonly logger?: Logger | undefined;
}

export interface HistoryParams {
  readonly userId: string;
  readonly now?: Date | undefined;
}

/**
 * Ищет в накопленной истории связку с ритмом и оформляет предложение.
 *
 * `undefined` — предлагать нечего или нельзя, и это обычный исход.
 * Функции нужна глубина: три ежемесячных повторения — это три месяца
 * жизни в продукте. У первых пользователей она не сработает вовсе, и это
 * не повод её отлаживать.
 */
export async function sweepHistory(
  deps: HistoryDeps,
  params: HistoryParams,
): Promise<Suggestion | undefined> {
  const now = params.now ?? new Date();

  // Дешёвый запрос раньше дорогого обхода.
  if (await offeredRecently(deps.db, { userId: params.userId, now })) return undefined;

  const history = await deps.db
    .select({
      id: items.id,
      text: items.text,
      createdAt: items.createdAt,
      embedding: items.embedding,
    })
    .from(items)
    .where(
      and(
        eq(items.userId, params.userId),
        eq(items.isDraft, false),
        isNotNull(items.embedding),
        // Уже регулярное дело предлагать не о чем.
        sql`${items.recurrenceRule} is null`,
        inArray(items.status, FAMILY_STATUSES),
      ),
    )
    .orderBy(desc(items.createdAt))
    .limit(HISTORY_DEPTH);

  /**
   * Просмотренные записи, а не просмотренные связки.
   *
   * Связка из четырёх оплат садика найдётся четыре раза — по разу с
   * каждой записи как отправной точки. Без этого множества бот предложил
   * бы одно и то же четырежды подряд; недельный предел спас бы человека
   * от трёх лишних вопросов, но три лишних обхода мы бы всё равно
   * сделали, а первое же предложение съело бы неделю.
   */
  const seen = new Set<string>();

  for (const seed of history) {
    if (seen.has(seed.id)) continue;
    seen.add(seed.id);

    if (seed.embedding === null) continue;

    const similar = await findSimilarItems(deps.db, {
      userId: params.userId,
      vector: seed.embedding,
      limit: FAMILY_LIMIT,
      statuses: FAMILY_STATUSES,
    });

    const family = similar.filter((candidate) => candidate.similarity >= SAME_TASK_SIMILARITY);
    for (const member of family) seen.add(member.id);

    if (family.length < MIN_OCCURRENCES) continue;

    /**
     * Ритм ищется по датам создания, как и в 3.8в.
     *
     * Срок мог быть не назван вовсе, а сказано о деле было именно тогда,
     * когда о нём вспомнили. Ритм жизни виден по этому.
     */
    const ids = family.map((candidate) => candidate.id);
    const known = new Map(history.map((row) => [row.id, row.createdAt]));
    const dates = ids.map((id) => known.get(id)).filter((at): at is Date => at !== undefined);

    if (dates.length < MIN_OCCURRENCES) continue;

    const rhythm = detectRhythm(dates);
    if (rhythm === undefined) continue;

    // Отказ помнится навсегда, согласие — тем более (3.8в).
    if (!(await canOffer(deps.db, { userId: params.userId, itemIds: ids, now }))) continue;

    /**
     * Спрашиваем о самой свежей записи связки.
     *
     * Правило ляжет на неё, и человеку она знакома лучше прочих: о ней
     * он говорил последней.
     */
    const newest = ids.reduce((best, id) => {
      const at = known.get(id)?.getTime() ?? 0;
      return at > (known.get(best)?.getTime() ?? 0) ? id : best;
    }, ids[0] ?? seed.id);

    const title = history.find((row) => row.id === newest)?.text ?? seed.text;

    const offer = await recordOffer(deps.db, {
      userId: params.userId,
      itemId: newest,
      itemIds: ids,
      rhythm,
      now,
    });

    deps.logger?.info(
      { userId: params.userId, kind: rhythm.kind, occurrences: dates.length },
      'Обход истории нашёл регулярность',
    );

    return {
      suggestionId: offer.id,
      itemId: newest,
      title,
      rhythm,
      dates: [...dates].sort((left, right) => left.getTime() - right.getTime()),
    };
  }

  return undefined;
}
