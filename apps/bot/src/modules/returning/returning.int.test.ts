import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { openItemsFor } from '../items/items.repo.js';
import { itemsOfTopic } from '../topics/summary.service.js';
import { upsertUser } from '../users/users.repo.js';
import { moveToBackground, RETURN_AFTER_DAYS, returningAfterPause } from './returning.service.js';

/**
 * Возвращение после паузы (§13.6 ТЗ).
 *
 * Два свойства, и второе важнее первого: «Начать с чистого листа»
 * **ничего не удаляет**. Человек нажимает кнопку с пугающим названием, и
 * продукт обязан оставить ему всё — §13.6 говорит это прямо.
 */

const DAY = 24 * 60 * 60_000;
const NOW = new Date('2026-09-01T09:00:00.000Z');

let userId = '';
let seq = 0;

async function batchAt(at: Date): Promise<string> {
  const [row] = await testDb()
    .insert(batches)
    .values({ userId, status: 'done', openedAt: at, lastMessageAt: at })
    .returning({ id: batches.id });

  return row?.id ?? '';
}

async function sow(text: string): Promise<string> {
  const [row] = await testDb()
    .insert(items)
    .values({ userId, text, type: 'TASK', priority: 'SOON', topic: 'быт' })
    .returning({ id: items.id });

  return row?.id ?? '';
}

beforeEach(async () => {
  seq += 1;
  userId = (await upsertUser(testDb(), { tgId: 9100 + seq, firstName: 'Аня' })).id;
});

describe('когда считается возвращением', () => {
  it('после двух недель молчания — да', async () => {
    await batchAt(new Date(NOW.getTime() - (RETURN_AFTER_DAYS + 1) * DAY));
    const current = await batchAt(NOW);

    expect(await returningAfterPause(testDb(), { userId, batchId: current, now: NOW })).toBe(true);
  });

  it('на день раньше срока — ещё нет', async () => {
    await batchAt(new Date(NOW.getTime() - (RETURN_AFTER_DAYS - 1) * DAY));
    const current = await batchAt(NOW);

    expect(await returningAfterPause(testDb(), { userId, batchId: current, now: NOW })).toBe(false);
  });

  it('первая выгрузка в жизни — это знакомство, а не возвращение', async () => {
    const current = await batchAt(NOW);

    expect(await returningAfterPause(testDb(), { userId, batchId: current, now: NOW })).toBe(false);
  });

  it('вторая выгрузка подряд экрана не повторяет', async () => {
    /**
     * Показывается один раз само собой: признак — время прошлой выгрузки,
     * а после возвращения прошлой станет уже она.
     */
    await batchAt(new Date(NOW.getTime() - (RETURN_AFTER_DAYS + 1) * DAY));
    const returned = await batchAt(NOW);
    expect(await returningAfterPause(testDb(), { userId, batchId: returned, now: NOW })).toBe(true);

    const next = await batchAt(new Date(NOW.getTime() + 60_000));
    expect(
      await returningAfterPause(testDb(), {
        userId,
        batchId: next,
        now: new Date(NOW.getTime() + 60_000),
      }),
    ).toBe(false);
  });

  it('чужие выгрузки не считаются', async () => {
    const stranger = await upsertUser(testDb(), { tgId: 9100 + seq + 500, firstName: 'Оля' });
    const mine = userId;

    userId = stranger.id;
    await batchAt(new Date(NOW.getTime() - 60_000));
    userId = mine;

    await batchAt(new Date(NOW.getTime() - (RETURN_AFTER_DAYS + 1) * DAY));
    const current = await batchAt(NOW);

    expect(await returningAfterPause(testDb(), { userId, batchId: current, now: NOW })).toBe(true);
  });
});

describe('«начать с чистого листа» ничего не удаляет', () => {
  it('записи остаются в базе, но уходят из выдачи', async () => {
    await sow('Оплатить садик');
    await sow('Записаться к врачу');

    expect(await moveToBackground(testDb(), { userId, now: NOW })).toBe(2);

    const all = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(all).toHaveLength(2);
    expect(await openItemsFor(testDb(), userId)).toEqual([]);
  });

  it('и остаются доступны через бэклог — §13.6 требует этого прямо', async () => {
    await sow('Оплатить садик');
    await moveToBackground(testDb(), { userId, now: NOW });

    const inTopic = await itemsOfTopic(testDb(), userId, 'быт');

    expect(inTopic.map((one) => one.text)).toContain('Оплатить садик');
  });

  it('статус не меняется: человек не отменял эти дела', async () => {
    const id = await sow('Оплатить садик');
    await moveToBackground(testDb(), { userId, now: NOW });

    const [after] = await testDb().select().from(items).where(eq(items.id, id));

    expect(after?.status).not.toBe('cancelled');
    expect(after?.backgroundedAt).not.toBeNull();
  });

  it('повторное нажатие уносить уже нечего', async () => {
    await sow('Оплатить садик');
    await moveToBackground(testDb(), { userId, now: NOW });

    expect(await moveToBackground(testDb(), { userId, now: NOW })).toBe(0);
  });

  it('закрытые дела не трогает', async () => {
    const id = await sow('Уже сделано');
    await testDb().update(items).set({ status: 'done' }).where(eq(items.id, id));

    expect(await moveToBackground(testDb(), { userId, now: NOW })).toBe(0);
  });

  it('чужие записи не трогает', async () => {
    const stranger = await upsertUser(testDb(), { tgId: 9100 + seq + 700, firstName: 'Оля' });
    const mine = userId;

    userId = stranger.id;
    const alien = await sow('Не моё');
    userId = mine;

    await sow('Моё');
    await moveToBackground(testDb(), { userId, now: NOW });

    const [untouched] = await testDb()
      .select()
      .from(items)
      .where(and(eq(items.id, alien), eq(items.userId, stranger.id)));

    expect(untouched?.backgroundedAt).toBeNull();
  });
});
