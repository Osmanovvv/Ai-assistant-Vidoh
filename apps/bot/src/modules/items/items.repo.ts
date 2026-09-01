import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';

import { items, topics, type Item, type NewItem } from '../../db/schema.js';
import type { Database, Executor } from '../../infra/db.js';
import type { ClassifiedItem } from '../classifier/classifier.service.js';
import { normalizeTopicName } from '../topics/topics.repo.js';
import { withCapital } from './item-text.js';

/**
 * Сохранение записей (задача 2.8).
 *
 * §5 ТЗ плюс `source_batch_id`: запись рождается из выгрузки, то есть из
 * склейки нескольких сообщений.
 *
 * Всё пишется одной транзакцией. Частичный сбой не должен оставлять
 * половину разбора: человек увидел бы три дела из пяти и решил, что
 * остальное потерялось. А оно бы и потерялось — второй раз выгрузку никто
 * не разберёт, она уже помечена обработанной.
 */

/**
 * Запись к сохранению: классификация плюс смысловое представление.
 *
 * Вектор считается при создании записи (задача 2.9) и приходит сюда
 * готовым. Считать его внутри значило бы, что сохранение обращается к
 * модели, а тогда транзакция держалась бы на время сетевого вызова.
 */
export interface ItemToSave extends ClassifiedItem {
  readonly embedding?: readonly number[] | undefined;
}

export interface SaveItemsParams {
  readonly userId: string;
  readonly batchId: string;
  readonly items: readonly ItemToSave[];
}

/** Черновик: разобрать не удалось, но текст терять нельзя (§17 ТЗ). */
export interface SaveDraftParams {
  readonly userId: string;
  readonly batchId: string;
  readonly text: string;
  /** Чем именно не удалось: пойдёт в админку к тому, кто будет разбирать. */
  readonly reason: string;
  /**
   * Место внутри выгрузки, как у разобранных записей.
   *
   * Нужно по той же причине: без него у записей одной выгрузки совпадает
   * и время создания, и порядок, и любая сортировка разрешает ничью
   * идентификатором — то есть случайно. Человек, открывший выгрузку своих
   * данных, увидел бы свои же фразы в произвольном порядке.
   */
  readonly order?: number | undefined;
}

/**
 * Ссылка на тему по её названию.
 *
 * Разбор называет тему словом — так её называет модель, — а истина в
 * базе это `topic_id`. Сопоставление здесь, а не в разборе: базе решать,
 * какая запись к какой теме относится.
 */
function toRow(
  params: SaveItemsParams,
  item: ItemToSave,
  order: number,
  topicIds: ReadonlyMap<string, string>,
): NewItem {
  return {
    userId: params.userId,
    sourceBatchId: params.batchId,
    sourceOrder: order,
    // Заглавная в начале: см. item-text.ts, задача 3.25.
    text: withCapital(item.text),
    type: item.type,
    priority: item.priority,
    topic: item.topic,
    topicId: topicIds.get(normalizeTopicName(item.topic)) ?? null,
    isProject: item.isProject,
    deadlineAt: item.deadline?.at ?? null,
    deadlineAccuracy: item.deadline?.accuracy ?? null,
    // Задача 2.18а: правило живёт рядом с фразой человека, и фраза
    // сохраняется даже тогда, когда правило не получилось.
    recurrenceRule: item.recurrence?.rule ?? null,
    recurrenceText: item.recurrence?.text ?? null,
    recurrenceSource: item.recurrence?.source ?? null,
    embedding: item.embedding === undefined ? null : [...item.embedding],
  };
}

/**
 * Пишет разобранные записи выгрузки.
 *
 * Одним запросом внутри транзакции: одна вставка на все записи и быстрее,
 * и атомарна сама по себе, а транзакция нужна, чтобы к ней можно было
 * добавить сохранение черновиков и не разъехаться.
 */
export async function saveItems(db: Database, params: SaveItemsParams): Promise<Item[]> {
  if (params.items.length === 0) return [];

  return await db.transaction(async (tx) => {
    const own = await tx
      .select({ id: topics.id, name: topics.name })
      .from(topics)
      .where(eq(topics.userId, params.userId));

    const topicIds = new Map(own.map((topic) => [normalizeTopicName(topic.name), topic.id]));

    return await tx
      .insert(items)
      .values(params.items.map((item, order) => toRow(params, item, order, topicIds)))
      .returning();
  });
}

export async function saveDraft(db: Executor, params: SaveDraftParams): Promise<Item> {
  const [row] = await db
    .insert(items)
    .values({
      userId: params.userId,
      sourceBatchId: params.batchId,
      sourceOrder: params.order ?? null,
      text: params.text,
      isDraft: true,
      draftReason: params.reason,
    })
    .returning();

  if (!row) throw new Error('Черновик не сохранился');

  return row;
}

/**
 * Открытые записи человека — то, из чего фильтр выдачи выбирает действия.
 *
 * Выдача смотрит на весь бэклог, а не только на последнюю выгрузку: §13.2
 * спрашивает «что взять на сегодня», и дело, названное вчера и срочное
 * сегодня, важнее только что упомянутого «когда-нибудь».
 *
 * Потолок нужен, чтобы один человек с тысячей записей не тянул их все в
 * память на каждый разбор. Порядок — от свежих: годность и важность
 * проверяет фильтр, а вот отсечение по потолку должно быть предсказуемым.
 */
export const OPEN_STATUSES = ['new', 'active', 'in_progress', 'waiting'] as const;

/**
 * Что значит «запись в работе» — одним условием на весь продукт.
 *
 * Тот же список статусов лежал в четырёх местах: выдача, сводки тем,
 * планировщик и здесь. Пока условие было одно, это была просто копия; с
 * появлением фона (§13.6) копия стала опасной — забыть про фон в одном из
 * четырёх мест значит показать в выдаче то, что человек убрал с глаз.
 *
 * Сводки тем сюда не входят намеренно: §13.6 требует, чтобы ушедшее в фон
 * **осталось доступно через бэклог**. Там у списка своё условие, и это
 * разница по смыслу, а не забытая копия.
 */
export function openItemsWhere(userId: string) {
  return and(
    eq(items.userId, userId),
    eq(items.isDraft, false),
    isNull(items.backgroundedAt),
    inArray(items.status, [...OPEN_STATUSES]),
  );
}

export async function openItemsFor(db: Executor, userId: string, limit = 300): Promise<Item[]> {
  return await db
    .select()
    .from(items)
    .where(openItemsWhere(userId))
    .orderBy(desc(items.createdAt), asc(items.sourceOrder), desc(items.id))
    .limit(limit);
}

/**
 * Записи выгрузки в том порядке, в каком человек их назвал.
 *
 * Время создания у них одинаковое — они пишутся одной вставкой, — поэтому
 * порядок держится на `source_order`, а не на нём.
 */
export async function itemsForBatch(db: Executor, batchId: string): Promise<Item[]> {
  return await db
    .select()
    .from(items)
    .where(eq(items.sourceBatchId, batchId))
    .orderBy(asc(items.createdAt), asc(items.sourceOrder), asc(items.id));
}
