import { beforeEach, describe, expect, it } from 'vitest';

import { eq } from 'drizzle-orm';

import { items, type Item } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { setItemEmbedding } from '../embedder/embedder.service.js';
import { upsertUser } from '../users/users.repo.js';
import { suggestRecurrence } from './suggest.service.js';
import type { Rhythm } from './detector.js';
import {
  canOffer,
  recordOffer,
  resolveOffer,
  SUGGESTION_COOLDOWN_DAYS,
} from './suggestions.repo.js';

/**
 * Память о предложениях (задача 3.8в).
 *
 * План называет здесь две проверки: запоминание отказа и недельный
 * предел. Обе про одно — **функция, которая переспрашивает, становится
 * ненавистной за месяц**, и раздражение копится быстрее доверия.
 */

const NOW = new Date('2026-09-01T09:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const MONTHLY: Rhythm = { kind: 'monthly', interval: 1, medianDays: 30 };

let userId = '';
let seq = 0;

async function sow(text: string): Promise<string> {
  const [row] = await testDb()
    .insert(items)
    .values({ userId, text, type: 'TASK', priority: 'SOON', topic: 'деньги' })
    .returning({ id: items.id });

  return row?.id ?? '';
}

beforeEach(async () => {
  seq++;
  userId = (await upsertUser(testDb(), { tgId: 6300 + seq, firstName: 'Аня' })).id;
});

describe('когда предлагать можно', () => {
  it('в первый раз — можно', async () => {
    const ids = [await sow('Оплатить садик')];

    expect(await canOffer(testDb(), { userId, itemIds: ids, now: NOW })).toBe(true);
  });

  it('чужие предложения не мешают', async () => {
    const stranger = await upsertUser(testDb(), { tgId: 6400 + seq, firstName: 'Чужая' });
    const ids = [await sow('Оплатить садик')];

    await recordOffer(testDb(), { userId, itemId: ids[0] ?? '', itemIds: ids, rhythm: MONTHLY });

    expect(await canOffer(testDb(), { userId: stranger.id, itemIds: ids, now: NOW })).toBe(true);
  });
});

describe('отказ помнится навсегда', () => {
  it('отклонённая связка не предлагается больше никогда', async () => {
    const ids = [await sow('Оплатить садик'), await sow('Садик оплатить')];
    const offer = await recordOffer(testDb(), {
      userId,
      itemId: ids[0] ?? '',
      itemIds: ids,
      rhythm: MONTHLY,
    });

    await resolveOffer(testDb(), { suggestionId: offer.id, userId, outcome: 'declined' });

    // Ни через неделю, ни через год.
    const later = new Date(NOW.getTime() + 400 * DAY);
    expect(await canOffer(testDb(), { userId, itemIds: ids, now: later })).toBe(false);
  });

  it('достаточно одной общей записи, чтобы узнать ту же связку', async () => {
    // «Оплатить садик» и «заплатить за садик» — одно дело. Связка
    // подросла на одну запись, но это не повод спросить заново.
    const first = await sow('Оплатить садик');
    const second = await sow('Садик оплатить');

    const offer = await recordOffer(testDb(), {
      userId,
      itemId: first,
      itemIds: [first, second],
      rhythm: MONTHLY,
    });
    await resolveOffer(testDb(), { suggestionId: offer.id, userId, outcome: 'declined' });

    const third = await sow('Заплатить за садик');
    const later = new Date(NOW.getTime() + 100 * DAY);

    expect(await canOffer(testDb(), { userId, itemIds: [second, third], now: later })).toBe(false);
  });

  it('согласие тоже закрывает вопрос: правило уже есть', async () => {
    const ids = [await sow('Оплатить садик')];
    const offer = await recordOffer(testDb(), {
      userId,
      itemId: ids[0] ?? '',
      itemIds: ids,
      rhythm: MONTHLY,
    });

    await resolveOffer(testDb(), { suggestionId: offer.id, userId, outcome: 'accepted' });

    const later = new Date(NOW.getTime() + 100 * DAY);
    expect(await canOffer(testDb(), { userId, itemIds: ids, now: later })).toBe(false);
  });
});

describe('не чаще раза в неделю', () => {
  it('второе предложение в ту же неделю не проходит, даже про другое дело', async () => {
    const first = [await sow('Оплатить садик')];
    await recordOffer(testDb(), {
      userId,
      itemId: first[0] ?? '',
      itemIds: first,
      rhythm: MONTHLY,
    });

    const other = [await sow('Пропить курс витаминов')];
    const soon = new Date(NOW.getTime() + 2 * DAY);

    expect(await canOffer(testDb(), { userId, itemIds: other, now: soon })).toBe(false);
  });

  it('через неделю — можно', async () => {
    const first = [await sow('Оплатить садик')];
    await recordOffer(testDb(), {
      userId,
      itemId: first[0] ?? '',
      itemIds: first,
      rhythm: MONTHLY,
    });

    const other = [await sow('Пропить курс витаминов')];
    const later = new Date(NOW.getTime() + (SUGGESTION_COOLDOWN_DAYS + 1) * DAY);

    expect(await canOffer(testDb(), { userId, itemIds: other, now: later })).toBe(true);
  });
});

describe('предложение целиком: от похожих записей до вопроса', () => {
  /**
   * План требует проверить бюджет вопроса и то, что функция выключена по
   * умолчанию. Оба свойства защищают человека от лишнего вопроса, и оба
   * легко потерять при следующей правке конвейера.
   */
  const DAY_MS = 24 * 60 * 60_000;

  /** Единичный вектор: близость к себе — единица. */
  const axis = (index: number): number[] =>
    Array.from({ length: 256 }, (_unused, position) => (position === index ? 1 : 0));

  async function family(dates: readonly string[]): Promise<Item> {
    let last: Item | undefined;

    for (const date of dates) {
      const [row] = await testDb()
        .insert(items)
        .values({
          userId,
          text: 'Оплатить садик',
          type: 'TASK',
          priority: 'SOON',
          topic: 'деньги',
          createdAt: new Date(`${date}T09:00:00.000Z`),
        })
        .returning();

      if (!row) throw new Error('запись не создалась');
      await setItemEmbedding(testDb(), row.id, axis(0));

      const [withVector] = await testDb().select().from(items).where(eq(items.id, row.id));
      last = withVector;
    }

    if (!last) throw new Error('связка пуста');
    return last;
  }

  it('четвёртая близкая запись даёт предложение с датами', async () => {
    // «Готово, когда» задачи 3.8в: перечисление дат обязательно.
    const newest = await family(['2026-08-05', '2026-08-12', '2026-08-19', '2026-08-26']);

    const suggestion = await suggestRecurrence(
      { db: testDb() },
      { userId, item: newest, now: new Date('2026-08-26T12:00:00.000Z') },
    );

    expect(suggestion?.rhythm.kind).toBe('weekly');
    expect(suggestion?.dates).toHaveLength(4);
  });

  it('трёх записей без ритма недостаточно', async () => {
    const newest = await family(['2026-01-05', '2026-02-05', '2026-02-08']);

    expect(
      await suggestRecurrence(
        { db: testDb() },
        { userId, item: newest, now: new Date('2026-02-08T12:00:00.000Z') },
      ),
    ).toBeUndefined();
  });

  it('уже регулярному делу ничего не предлагается', async () => {
    const newest = await family(['2026-08-05', '2026-08-12', '2026-08-19']);
    await testDb()
      .update(items)
      .set({
        recurrenceRule: { kind: 'weekly', interval: 1, anchor: '2026-08-05' },
        // Проверка в базе требует источник рядом с правилом: регулярность
        // обязана знать, откуда взялась.
        recurrenceText: 'каждую неделю',
        recurrenceSource: 'stated',
      })
      .where(eq(items.id, newest.id));

    const [ruled] = await testDb().select().from(items).where(eq(items.id, newest.id));

    expect(
      await suggestRecurrence(
        { db: testDb() },
        { userId, item: ruled as Item, now: new Date('2026-08-19T12:00:00.000Z') },
      ),
    ).toBeUndefined();
  });

  it('второе предложение подряд не проходит: не чаще раза в неделю', async () => {
    const newest = await family(['2026-08-05', '2026-08-12', '2026-08-19']);
    const now = new Date('2026-08-19T12:00:00.000Z');

    expect(await suggestRecurrence({ db: testDb() }, { userId, item: newest, now })).toBeDefined();
    expect(
      await suggestRecurrence(
        { db: testDb() },
        { userId, item: newest, now: new Date(now.getTime() + DAY_MS) },
      ),
    ).toBeUndefined();
  });
});
