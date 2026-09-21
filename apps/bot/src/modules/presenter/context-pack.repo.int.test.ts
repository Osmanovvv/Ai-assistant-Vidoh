import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, userSettings } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { loadContextFacts } from './context-pack.repo.js';

/**
 * Факты для живой строки из базы (22.09.2026): как женщину зовут, когда
 * была прошлая выгрузка, что она недавно закрыла. Открытые дела читает
 * конвейер сам — они у него уже есть до вставки.
 */
let userId = '';
let seq = 0;
const now = new Date('2026-09-22T16:30:00.000Z');
const daysAgo = (days: number): Date => new Date(now.getTime() - days * 24 * 60 * 60_000);

async function batch(openedAt: Date): Promise<string> {
  const [row] = await testDb()
    .insert(batches)
    .values({ userId, status: 'done', openedAt })
    .returning({ id: batches.id });
  return row?.id ?? '';
}

beforeEach(async () => {
  seq++;
  const user = await upsertUser(testDb(), { tgId: 8800 + seq, firstName: 'Ольга' });
  userId = user.id;
});

describe('факты из базы', () => {
  it('имя — как просила называть, иначе из Telegram', async () => {
    const current = await batch(now);

    expect((await loadContextFacts(testDb(), { userId, batchId: current, now })).name).toBe(
      'Ольга',
    );

    await testDb()
      .update(userSettings)
      .set({ preferredName: 'Оля' })
      .where(eq(userSettings.userId, userId));

    expect((await loadContextFacts(testDb(), { userId, batchId: current, now })).name).toBe('Оля');
  });

  it('прошлая выгрузка — последняя из прежних, не эта; первая — нет', async () => {
    const current = await batch(now);
    expect(
      (await loadContextFacts(testDb(), { userId, batchId: current, now })).previousBatchAt,
    ).toBeUndefined();

    await batch(daysAgo(5));
    await batch(daysAgo(2));

    expect(
      (await loadContextFacts(testDb(), { userId, batchId: current, now })).previousBatchAt,
    ).toEqual(daysAgo(2));
  });

  it('недавно закрытое — сделанные за три дня, свежие первыми, не больше трёх', async () => {
    const current = await batch(now);
    const rows = [
      { text: 'найти няню', completedAt: daysAgo(1) },
      { text: 'купить обои', completedAt: daysAgo(2) },
      { text: 'сдать отчёт', completedAt: daysAgo(0.5) },
      { text: 'позвонить маме', completedAt: daysAgo(3) },
      { text: 'давнее', completedAt: daysAgo(10) },
    ];
    // Страж базы: не черновик — значит с типом и важностью.
    const classified = { type: 'TASK', priority: 'SOON', topic: 'дом' } as const;
    for (const row of rows) {
      await testDb()
        .insert(items)
        .values({
          userId,
          ...classified,
          text: row.text,
          status: 'done',
          completedAt: row.completedAt,
        });
    }
    // Открытое и отменённое — не «закрыла».
    await testDb()
      .insert(items)
      .values({ userId, ...classified, text: 'открытое', status: 'new' });
    await testDb()
      .insert(items)
      .values({
        userId,
        ...classified,
        text: 'отменённое',
        status: 'cancelled',
        completedAt: daysAgo(1),
      });

    const facts = await loadContextFacts(testDb(), { userId, batchId: current, now });

    expect(facts.doneItems.map((item) => item.text)).toEqual([
      'сдать отчёт',
      'найти няню',
      'купить обои',
    ]);
  });

  it('чужие записи и выгрузки не видны', async () => {
    const other = await upsertUser(testDb(), { tgId: 9900 + seq, firstName: 'Другая' });
    await testDb()
      .insert(batches)
      .values({ userId: other.id, status: 'done', openedAt: daysAgo(1) });
    await testDb()
      .insert(items)
      .values({
        userId: other.id,
        type: 'TASK',
        priority: 'SOON',
        topic: 'дом',
        text: 'чужое',
        status: 'done',
        completedAt: daysAgo(1),
      });
    const current = await batch(now);

    const facts = await loadContextFacts(testDb(), { userId, batchId: current, now });

    expect(facts.previousBatchAt).toBeUndefined();
    expect(facts.doneItems).toEqual([]);
  });
});
