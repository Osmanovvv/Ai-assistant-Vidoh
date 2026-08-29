import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';

import { items, type ItemStatusValue } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { findSimilarItems, SEARCHABLE_STATUSES } from '../embedder/embedder.service.js';
import type { Period } from './period.js';

/**
 * Подбор кандидатов (§7.2 ТЗ, задача 3.1).
 *
 * Чтобы поправить, закрыть или отменить запись, надо сначала понять, о
 * какой записи речь. ТЗ называет три источника и требует их объединить:
 *
 * 1. **Короткая память сессии** — записи, созданные или изменённые
 *    недавно. ТЗ отдельно отмечает: «именно этот источник закрывает
 *    сценарий с врачом и пятницей».
 * 2. **Смысловой поиск** — активные записи, ближайшие по вектору к
 *    тексту сегмента.
 * 3. **Совпадение по сроку** — записи со сроком в упомянутом периоде.
 *
 * **Полные тексты модели не передаются** — §7.2 запрещает прямо, это
 * раздувает расход. Отсюда состав карточки кандидата: идентификатор,
 * заголовок, тема, срок, статус, время последнего изменения.
 *
 * **Общего предела списку нет, и это осознанно.** Предел стоит на каждом
 * источнике, а срезать объединение сверху значило бы молча выбрасывать
 * кандидата, которого один из источников счёл нужным. В худшем случае
 * список — сорок записей, на деле около десяти: источники сильно
 * пересекаются. Если объём станет заметен по расходу, резать надо будет
 * с числом в руках, а не наугад.
 */

export type CandidateSource = 'session' | 'semantic' | 'deadline';

/** Карточка кандидата: ровно то, что §7.2 разрешает показать модели. */
export interface Candidate {
  readonly id: string;
  /** Заголовок записи, а не её содержимое. */
  readonly text: string;
  readonly topic: string | null;
  readonly deadlineAt: Date | null;
  readonly status: ItemStatusValue;
  readonly updatedAt: Date;
  /**
   * Близость по смыслу от нуля до единицы.
   *
   * `null` означает «не мерили»: запись пришла из короткой памяти или по
   * сроку, а смысловой поиск её не вернул. Ноль значил бы «мерили и не
   * похоже» — разница важна для порога в 3.2.
   */
  readonly similarity: number | null;
  /** Какими источниками найдена. Пригождается порогу и разбору жалоб. */
  readonly sources: readonly CandidateSource[];
}

export interface CollectParams {
  readonly userId: string;
  readonly now?: Date | undefined;
  /**
   * Вектор текста сегмента. Без него смысловой поиск не выполняется —
   * это не ошибка: у выгрузки, чей вектор не посчитался, остаются два
   * других источника.
   */
  readonly vector?: readonly number[] | undefined;
  /** §7.2: период, упомянутый в сегменте. */
  readonly period?: Period | undefined;
  /** §8.1: сообщение внутри ветки сужает поиск до её темы. */
  readonly topic?: string | undefined;
  readonly limits?: Partial<CandidateLimits> | undefined;
}

export interface CandidateLimits {
  /**
   * Окно короткой памяти в часах.
   *
   * §7.2 выносит его в настройки, а настройки — четвёртый этап. Сутки
   * взяты из плана: поправка приходит через минуты, но человек может
   * вернуться к сказанному и вечером того же дня.
   */
  readonly sessionHours: number;
  readonly session: number;
  readonly semantic: number;
  readonly deadline: number;
}

export const DEFAULT_LIMITS: CandidateLimits = {
  sessionHours: 24,
  session: 20,
  semantic: 10,
  deadline: 10,
};

/** Поля карточки — один список на все три источника. */
const CARD = {
  id: items.id,
  text: items.text,
  topic: items.topic,
  deadlineAt: items.deadlineAt,
  status: items.status,
  updatedAt: items.updatedAt,
} as const;

/**
 * Общие условия для всех источников.
 *
 * Фильтр по человеку стоит первым и обязателен: чужая запись не должна
 * попасть в список ни при какой ошибке в остальных условиях. Черновики
 * исключены — они сами ждут разбора, поправлять в них нечего.
 */
function common(userId: string, statuses: readonly ItemStatusValue[], topic?: string) {
  return and(
    eq(items.userId, userId),
    eq(items.isDraft, false),
    inArray(items.status, [...statuses]),
    topic === undefined ? undefined : eq(items.topic, topic),
  );
}

/** Источник 1: что человек трогал недавно. */
async function fromSession(
  db: Executor,
  params: CollectParams,
  limits: CandidateLimits,
  now: Date,
): Promise<Omit<Candidate, 'similarity' | 'sources'>[]> {
  const since = new Date(now.getTime() - limits.sessionHours * 60 * 60_000);

  return await db
    .select(CARD)
    .from(items)
    .where(
      and(common(params.userId, SEARCHABLE_STATUSES, params.topic), gte(items.updatedAt, since)),
    )
    .orderBy(desc(items.updatedAt))
    .limit(limits.session);
}

/** Источник 3: у записи срок в тот же день, что назвал человек. */
async function fromDeadline(
  db: Executor,
  params: CollectParams,
  limits: CandidateLimits,
): Promise<Omit<Candidate, 'similarity' | 'sources'>[]> {
  const period = params.period;
  if (period === undefined) return [];

  return await db
    .select(CARD)
    .from(items)
    .where(
      and(
        common(params.userId, SEARCHABLE_STATUSES, params.topic),
        gte(items.deadlineAt, period.from),
        lt(items.deadlineAt, period.to),
      ),
    )
    .orderBy(sql`${items.deadlineAt} asc`)
    .limit(limits.deadline);
}

/**
 * Собирает кандидатов из трёх источников и объединяет.
 *
 * Одна запись может прийти сразу из нескольких — это не дубль, а более
 * сильный кандидат, и список источников у него длиннее. Близость
 * сохраняется, даже если смысловой поиск нашёл запись не первым.
 *
 * Порядок — от свежих к старым. Сценарий §7.2 держится именно на
 * свежести: поправка приходит через минуту после сказанного.
 */
export async function collectCandidates(db: Executor, params: CollectParams): Promise<Candidate[]> {
  const limits = { ...DEFAULT_LIMITS, ...params.limits };
  const now = params.now ?? new Date();

  const [session, deadline, semantic] = await Promise.all([
    fromSession(db, params, limits, now),
    fromDeadline(db, params, limits),
    params.vector === undefined
      ? Promise.resolve([])
      : findSimilarItems(db, {
          userId: params.userId,
          vector: params.vector,
          limit: limits.semantic,
          topic: params.topic,
          statuses: SEARCHABLE_STATUSES,
        }),
  ]);

  const merged = new Map<string, Candidate>();

  const add = (
    row: Omit<Candidate, 'similarity' | 'sources'>,
    source: CandidateSource,
    similarity: number | null,
  ): void => {
    const seen = merged.get(row.id);

    if (seen === undefined) {
      merged.set(row.id, { ...row, similarity, sources: [source] });
      return;
    }

    merged.set(row.id, {
      ...seen,
      similarity: similarity ?? seen.similarity,
      sources: [...seen.sources, source],
    });
  };

  for (const row of session) add(row, 'session', null);
  for (const row of semantic) add(row, 'semantic', row.similarity);
  for (const row of deadline) add(row, 'deadline', null);

  return [...merged.values()].sort(
    (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
  );
}
