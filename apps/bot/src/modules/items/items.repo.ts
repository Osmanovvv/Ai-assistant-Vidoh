import { asc, eq } from 'drizzle-orm';

import { items, type Item, type NewItem } from '../../db/schema.js';
import type { Database, Executor } from '../../infra/db.js';
import type { ClassifiedItem } from '../classifier/classifier.service.js';

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
}

function toRow(params: SaveItemsParams, item: ItemToSave): NewItem {
  return {
    userId: params.userId,
    sourceBatchId: params.batchId,
    text: item.text,
    type: item.type,
    priority: item.priority,
    topic: item.topic,
    isProject: item.isProject,
    deadlineAt: item.deadline?.at ?? null,
    deadlineAccuracy: item.deadline?.accuracy ?? null,
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
    return await tx
      .insert(items)
      .values(params.items.map((item) => toRow(params, item)))
      .returning();
  });
}

export async function saveDraft(db: Executor, params: SaveDraftParams): Promise<Item> {
  const [row] = await db
    .insert(items)
    .values({
      userId: params.userId,
      sourceBatchId: params.batchId,
      text: params.text,
      isDraft: true,
      draftReason: params.reason,
    })
    .returning();

  if (!row) throw new Error('Черновик не сохранился');

  return row;
}

/** Записи выгрузки в порядке создания. Нужно ответу человеку и тестам. */
export async function itemsForBatch(db: Executor, batchId: string): Promise<Item[]> {
  return await db
    .select()
    .from(items)
    .where(eq(items.sourceBatchId, batchId))
    .orderBy(asc(items.createdAt), asc(items.id));
}
