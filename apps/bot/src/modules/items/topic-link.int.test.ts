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

describe('первая выгрузка разбирается раньше тем (§12.2)', () => {
  /**
   * ТЗ ставит онбординг **после** первой выгрузки, а темы создаёт его
   * ответами. Значит первая выгрузка любого человека сохраняется, когда тем
   * ещё нет, и ссылку взять неоткуда — `saveItems` не в чем искать название.
   *
   * Без привязки в момент создания тем ссылка осталась бы пустой навсегда.
   * Найдено 29.08.2026 на боевых данных: 37 записей из 38 без ссылки, и все
   * из первой выгрузки. Случай не краевой, а гарантированный — он приходится
   * на самую большую выгрузку, ту, ради которой человек пришёл.
   */
  async function userWithoutTopics(): Promise<{ userId: string; batchId: string }> {
    const user = await upsertUser(testDb(), { tgId: 8800 + seq, firstName: 'Оля' });

    const [batch] = await testDb()
      .insert(batches)
      .values({ userId: user.id, status: 'processing' })
      .returning({ id: batches.id });

    return { userId: user.id, batchId: batch?.id ?? '' };
  }

  it('темы, созданные онбордингом, подбирают уже сохранённые записи', async () => {
    const fresh = await userWithoutTopics();

    await saveItems(testDb(), {
      userId: fresh.userId,
      batchId: fresh.batchId,
      items: [
        classified({ text: 'позвонить в сад', topic: 'семья' }),
        classified({ text: 'сдать анализы', topic: 'Здоровье' }),
        classified({ text: 'купить кофе', topic: 'покупки' }),
      ],
    });

    const before = await testDb()
      .select({ topicId: items.topicId })
      .from(items)
      .where(eq(items.userId, fresh.userId));

    expect(before).toHaveLength(3);
    expect(before.every((row) => row.topicId === null)).toBe(true);

    await createTopics(testDb(), fresh.userId, [
      { name: 'семья', isDefault: false },
      { name: 'здоровье', isDefault: false },
      { name: 'личное', isDefault: true },
    ]);

    const after = await testDb()
      .select({ text: items.text, topic: items.topic, topicId: items.topicId })
      .from(items)
      .where(eq(items.userId, fresh.userId));

    const byText = new Map(after.map((row) => [row.text, row]));

    expect(byText.get('позвонить в сад')?.topicId).not.toBeNull();

    // «Здоровье» и «здоровье» — одна тема: сравнение то же, что в
    // normalizeTopicName. Название приводится к тому, как тему назвал
    // человек: два источника истины обязаны совпадать.
    expect(byText.get('сдать анализы')?.topicId).not.toBeNull();
    expect(byText.get('сдать анализы')?.topic).toBe('здоровье');

    // Тему «покупки» человек не выбрал. Выдумывать её нельзя, но и терять
    // название незачем: запись останется без ссылки и будет видна.
    expect(byText.get('купить кофе')?.topicId).toBeNull();
    expect(byText.get('купить кофе')?.topic).toBe('покупки');
  });

  it('черновик остаётся черновиком: у него темы нет вовсе', async () => {
    // §17: неразобранная запись ждёт ручного разбора, и приписывать ей тему
    // по пустому названию — значит выдать догадку за разбор.
    const fresh = await userWithoutTopics();

    await testDb().insert(items).values({
      userId: fresh.userId,
      sourceBatchId: fresh.batchId,
      text: 'не в 9, а в 9 30',
      isDraft: true,
    });

    await createTopics(testDb(), fresh.userId, [{ name: 'семья', isDefault: true }]);

    const [draft] = await testDb()
      .select({ topic: items.topic, topicId: items.topicId })
      .from(items)
      .where(eq(items.userId, fresh.userId));

    expect(draft?.topic).toBeNull();
    expect(draft?.topicId).toBeNull();
  });
});
