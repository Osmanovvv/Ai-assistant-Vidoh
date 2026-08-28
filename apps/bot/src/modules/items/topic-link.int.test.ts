import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, topics } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import type { ClassifiedItem } from '../classifier/classifier.service.js';
import { createTopics } from '../topics/topics.repo.js';
import { moveItemToTopic } from '../topics/topics.service.js';
import { upsertUser } from '../users/users.repo.js';
import { saveItems } from './items.repo.js';

/**
 * Тема записи хранится ссылкой, а название лежит рядом кэшем (§5 ТЗ).
 *
 * Названием она хранилась с тех пор, когда таблицы тем не существовало.
 * Нашлось сверкой с ТЗ 28.08.2026: переименуй человек тему — записи с
 * прежним названием выпали бы и из списка темы, и из закреплённой сводки.
 * Молча, потому что ошибки при этом не происходит.
 *
 * **Два поля — два источника истины, и расходятся они беззвучно.** Поэтому
 * здесь проверяется не «ссылка появилась», а именно согласие: кто меняет
 * тему, обязан менять оба поля.
 */

let userId = '';
let batchId = '';
let seq = 0;

function classified(overrides: Partial<ClassifiedItem> = {}): ClassifiedItem {
  return {
    text: 'купить продукты',
    type: 'TASK',
    priority: 'SOON',
    topic: 'покупки',
    isProject: false,
    ...overrides,
  };
}

beforeEach(async () => {
  seq++;
  const user = await upsertUser(testDb(), { tgId: 7700 + seq, firstName: 'Аня' });
  userId = user.id;

  await createTopics(testDb(), userId, [
    { name: 'покупки', isDefault: false },
    { name: 'Здоровье', isDefault: false },
    { name: 'личное', isDefault: true },
  ]);

  const [batch] = await testDb()
    .insert(batches)
    .values({ userId, status: 'processing' })
    .returning({ id: batches.id });

  batchId = batch?.id ?? '';
});

async function saved(): Promise<{ topic: string | null; topicId: string | null }[]> {
  return await testDb()
    .select({ topic: items.topic, topicId: items.topicId })
    .from(items)
    .where(eq(items.userId, userId));
}

describe('ссылка на тему при сохранении разбора', () => {
  it('название и ссылка указывают на одну и ту же тему', async () => {
    await saveItems(testDb(), { userId, batchId, items: [classified()] });

    const rows = await saved();
    expect(rows[0]?.topic).toBe('покупки');
    expect(rows[0]?.topicId).not.toBeNull();

    const [topic] = await testDb()
      .select({ name: topics.name })
      .from(topics)
      .where(eq(topics.id, rows[0]?.topicId ?? ''));

    expect(topic?.name).toBe('покупки');
  });

  it('регистр и «ё» ссылку не ломают', async () => {
    // Модель возвращает название так, как считает нужным. Правило сравнения
    // одно на весь проект — normalizeTopicName.
    await saveItems(testDb(), {
      userId,
      batchId,
      items: [classified({ topic: 'здоровье' })],
    });

    const rows = await saved();
    expect(rows[0]?.topicId).not.toBeNull();
  });

  it('незнакомое название оставляет ссылку пустой, а не выдумывает тему', async () => {
    // Классификация обязана выбирать из тем человека, и такого быть не
    // должно. Но если случится — приписать запись случайной теме хуже, чем
    // оставить без ссылки: название при этом сохранено.
    await saveItems(testDb(), {
      userId,
      batchId,
      items: [classified({ topic: 'бизнес' })],
    });

    const rows = await saved();
    expect(rows[0]?.topic).toBe('бизнес');
    expect(rows[0]?.topicId).toBeNull();
  });
});

describe('перенос записи в другую тему', () => {
  it('меняет и ссылку, и название', async () => {
    // Иначе один из двух источников истины останется прежним, и запись
    // окажется одновременно в двух темах — в одной по ссылке, в другой по
    // названию.
    await saveItems(testDb(), { userId, batchId, items: [classified()] });

    const [item] = await testDb()
      .select({ id: items.id })
      .from(items)
      .where(eq(items.userId, userId));

    await moveItemToTopic(testDb(), {
      itemId: item?.id ?? '',
      userId,
      topicName: 'Здоровье',
    });

    const rows = await saved();
    expect(rows[0]?.topic).toBe('Здоровье');

    const [topic] = await testDb()
      .select({ name: topics.name })
      .from(topics)
      .where(eq(topics.id, rows[0]?.topicId ?? ''));

    expect(topic?.name).toBe('Здоровье');
  });
});
