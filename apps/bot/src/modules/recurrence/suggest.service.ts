import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';

import { items, type Item } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { findSimilarItems } from '../embedder/embedder.service.js';
import { detectRhythm, MIN_OCCURRENCES, type Rhythm } from './detector.js';
import { canOffer, recordOffer } from './suggestions.repo.js';

/**
 * Бот замечает повторяемость и предлагает запомнить (задача 3.8в).
 *
 * Собирает вместе три части, каждая из которых проверена отдельно:
 * смысловой поиск похожих записей, определитель ритма и память о
 * предложениях.
 *
 * **Смысловая близость, а не совпадение слов.** «Оплатить садик»,
 * «садик оплатить» и «заплатить за садик» — одно дело, и по словам их не
 * свести. Векторы для этого уже считаются с задачи 2.9.
 *
 * **Предложение конкурирует за единственный вопрос и проигрывает.**
 * Инвариант 10: один вопрос в реплике. Уточняющий вопрос резолвера
 * всегда важнее — там цена ошибки выше, там портится существующая
 * запись. Предложение в таком случае не задаётся вовсе и не встаёт в
 * очередь: дело регулярное, оно повторится, и случай представится снова.
 */

/**
 * Близость, при которой две записи считаются одним делом.
 *
 * **Число не измерено и потому функция выключена.** Порог «это то же
 * самое дело» угадать нельзя: у «оплатить садик» и «оплатить интернет»
 * общего больше, чем кажется вектору. Мерить его надо на живых данных
 * тестовой группы, а до тех пор осторожность важнее полноты — ложное
 * предложение раздражает, а пропущенное не замечают.
 */
export const SAME_TASK_SIMILARITY = 0.8;

export interface SuggestDeps {
  readonly db: Database;
  readonly logger?: Logger | undefined;
}

export interface SuggestParams {
  readonly userId: string;
  /** Только что созданная запись, из-за которой мы смотрим. */
  readonly item: Item;
  readonly now?: Date | undefined;
}

export interface Suggestion {
  readonly suggestionId: string;
  readonly itemId: string;
  readonly title: string;
  readonly rhythm: Rhythm;
  /** Даты, на которых основано предложение. Показываются человеку. */
  readonly dates: readonly Date[];
}

/**
 * Ищет ритм вокруг новой записи и, если нашёлся, оформляет предложение.
 *
 * `undefined` — предлагать нечего или нельзя. Это обычный и самый частый
 * исход: большинство дел не повторяется.
 */
export async function suggestRecurrence(
  deps: SuggestDeps,
  params: SuggestParams,
): Promise<Suggestion | undefined> {
  const now = params.now ?? new Date();

  // Уже регулярное дело — предлагать нечего.
  if (params.item.recurrenceRule !== null) return undefined;
  if (params.item.embedding === null) return undefined;

  const similar = await findSimilarItems(deps.db, {
    userId: params.userId,
    vector: params.item.embedding,
    limit: 12,
    statuses: ['done', 'new', 'active', 'in_progress', 'waiting', 'snoozed'],
  });

  const family = similar.filter((candidate) => candidate.similarity >= SAME_TASK_SIMILARITY);

  if (family.length < MIN_OCCURRENCES) return undefined;

  /**
   * Ритм ищется по датам создания, а не по срокам.
   *
   * Срок мог быть не назван вовсе, а вот сказано о деле было именно
   * тогда, когда о нём вспомнили. Ритм жизни виден по этому.
   */
  const ids = family.map((candidate) => candidate.id);
  const rows = await deps.db
    .select({ id: items.id, createdAt: items.createdAt })
    .from(items)
    .where(and(eq(items.userId, params.userId), inArray(items.id, ids)));

  const dates = rows.map((row) => row.createdAt);
  const rhythm = detectRhythm(dates);
  if (rhythm === undefined) return undefined;

  if (!(await canOffer(deps.db, { userId: params.userId, itemIds: ids, now }))) return undefined;

  const offer = await recordOffer(deps.db, {
    userId: params.userId,
    itemId: params.item.id,
    itemIds: ids,
    rhythm,
    now,
  });

  deps.logger?.info(
    { userId: params.userId, kind: rhythm.kind, occurrences: dates.length },
    'Бот заметил повторяемость и предлагает запомнить',
  );

  return {
    suggestionId: offer.id,
    itemId: params.item.id,
    title: params.item.text,
    rhythm,
    dates: [...dates].sort((left, right) => left.getTime() - right.getTime()),
  };
}
