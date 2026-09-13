import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, type Item } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import {
  autoDeferReviewed,
  markOffered,
  markReviewed,
  offerFromLater,
  OFFER_AGAIN_AFTER_DAYS,
  REVIEW_LIMIT,
  reviewDue,
} from './review.service.js';

/**
 * Запрос на изменение №4 (решение заказчицы 13.09.2026): разбор
 * вчерашнего вместо хвоста просроченного, «Позже» с возвращением.
 */

const MOSCOW = 'Europe/Moscow';
// Воскресенье 13.09.2026, 08:00 по Москве.
const NOW = new Date('2026-09-13T05:00:00.000Z');
const DAY = 24 * 60 * 60_000;
/** Начало местного дня по Москве для даты. */
const day = (date: string): Date => new Date(`${date}T21:00:00.000Z`);

let userId = '';
let seq = 0;

async function sow(overrides: Partial<Item> = {}): Promise<Item> {
  seq += 1;
  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: `Дело ${String(seq)}`,
      type: 'TASK',
      priority: 'SOON',
      topic: 'быт',
      ...overrides,
    })
    .returning();
  if (row === undefined) throw new Error('не посеялось');
  return row;
}

async function reread(id: string): Promise<Item> {
  const [row] = await testDb().select().from(items).where(eq(items.id, id));
  if (row === undefined) throw new Error('пропало');
  return row;
}

beforeEach(async () => {
  userId = (await upsertUser(testDb(), { tgId: 9300 + seq, firstName: 'Аня' })).id;
});

describe('reviewDue — что показать в разборе', () => {
  it('просроченные, ещё не показанные, по сроку; сегодняшние и будущие не входят', async () => {
    const older = await sow({
      text: 'Позвонить стоматологу',
      deadlineAt: day('2026-09-10'),
      deadlineAccuracy: 'day',
    });
    const yesterday = await sow({
      text: 'Оплатить садик',
      deadlineAt: day('2026-09-11'),
      deadlineAccuracy: 'day',
    });
    await sow({ text: 'Сегодня', deadlineAt: day('2026-09-12'), deadlineAccuracy: 'day' });
    await sow({ text: 'Завтра', deadlineAt: day('2026-09-13'), deadlineAccuracy: 'day' });
    await sow({ text: 'Без срока' });

    const review = await reviewDue(testDb(), { userId, now: NOW, timeZone: MOSCOW });

    expect(review?.items.map((one) => one.id)).toEqual([older.id, yesterday.id]);
  });

  it('«вчера» — когда всё из вчерашнего дня; иначе шапка без «вчера»', async () => {
    await sow({ deadlineAt: day('2026-09-11'), deadlineAccuracy: 'day' });
    expect((await reviewDue(testDb(), { userId, now: NOW, timeZone: MOSCOW }))?.since).toBe(
      'yesterday',
    );

    await sow({ deadlineAt: day('2026-09-05'), deadlineAccuracy: 'day' });
    expect((await reviewDue(testDb(), { userId, now: NOW, timeZone: MOSCOW }))?.since).toBe(
      'earlier',
    );
  });

  it('уже показанное не показывается снова; закрытое, в фоне и неточные сроки — тоже нет', async () => {
    const shown = await sow({
      deadlineAt: day('2026-09-11'),
      deadlineAccuracy: 'day',
      reviewedAt: NOW,
    });
    await sow({ deadlineAt: day('2026-09-11'), deadlineAccuracy: 'day', status: 'done' });
    await sow({ deadlineAt: day('2026-09-11'), deadlineAccuracy: 'day', backgroundedAt: NOW });
    await sow({ deadlineAt: day('2026-09-11'), deadlineAccuracy: 'week' });

    const review = await reviewDue(testDb(), { userId, now: NOW, timeZone: MOSCOW });

    expect(review).toBeUndefined();
    expect((await reread(shown.id)).reviewedAt).not.toBeNull();
  });

  it(`не больше ${String(REVIEW_LIMIT)} за раз — остальное подождёт следующего утра`, async () => {
    for (let back = 1; back <= REVIEW_LIMIT + 2; back += 1) {
      await sow({
        deadlineAt: new Date(day('2026-09-12').getTime() - back * DAY),
        deadlineAccuracy: 'day',
      });
    }

    const review = await reviewDue(testDb(), { userId, now: NOW, timeZone: MOSCOW });

    expect(review?.items).toHaveLength(REVIEW_LIMIT);
  });

  it('markReviewed ставит отметку показанным', async () => {
    const one = await sow({ deadlineAt: day('2026-09-11'), deadlineAccuracy: 'day' });

    await markReviewed(testDb(), [one.id], NOW);

    expect((await reread(one.id)).reviewedAt?.toISOString()).toBe(NOW.toISOString());
    expect(await reviewDue(testDb(), { userId, now: NOW, timeZone: MOSCOW })).toBeUndefined();
  });
});

describe('autoDeferReviewed — нетронутое к следующему утру уходит в «Позже»', () => {
  it('показанное вчера и всё ещё просроченное — в «Позже» без реплики', async () => {
    /**
     * Ответ 1.2: «если ничего не нажали — автоматически в «Позже».
     * Повторно требовать решения не нужно: ВЫДОХ помнит, пользователь
     * не обязан всё разбирать».
     */
    const untouched = await sow({
      deadlineAt: day('2026-09-10'),
      deadlineAccuracy: 'day',
      reviewedAt: new Date(NOW.getTime() - DAY),
    });

    const moved = await autoDeferReviewed(testDb(), { userId, now: NOW, timeZone: MOSCOW });

    expect(moved).toBe(1);
    const after = await reread(untouched.id);
    expect(after.deadlineAt).toBeNull();
    expect(after.priority).toBe('LATER');
    expect(after.deferredAt?.toISOString()).toBe(NOW.toISOString());
    expect(after.status).toBe('new');
  });

  it('показанное сегодня утром не трогает: у человека ещё день на решение', async () => {
    const fresh = await sow({
      deadlineAt: day('2026-09-10'),
      deadlineAccuracy: 'day',
      reviewedAt: new Date(NOW.getTime() - 60_000),
    });

    expect(await autoDeferReviewed(testDb(), { userId, now: NOW, timeZone: MOSCOW })).toBe(0);
    expect((await reread(fresh.id)).deadlineAt).not.toBeNull();
  });

  it('нажатое «На сегодня» не трогает: срок уже не в прошлом', async () => {
    const decided = await sow({
      deadlineAt: day('2026-09-12'),
      deadlineAccuracy: 'day',
      reviewedAt: new Date(NOW.getTime() - DAY),
    });

    expect(await autoDeferReviewed(testDb(), { userId, now: NOW, timeZone: MOSCOW })).toBe(0);
    expect((await reread(decided.id)).deferredAt).toBeNull();
  });
});

describe('offerFromLater — одно из отложенного, когда утром мало дел', () => {
  it('самое давно не предлагавшееся; предложенное на этой неделе — нет', async () => {
    const never = await sow({ deferredAt: new Date('2026-09-01T10:00:00.000Z'), deadlineAt: null });
    await sow({
      deferredAt: new Date('2026-08-01T10:00:00.000Z'),
      offeredAt: new Date(NOW.getTime() - 2 * DAY),
    });
    await sow({ text: 'Не отложенное' });

    const offered = await offerFromLater(testDb(), { userId, now: NOW });

    expect(offered?.id).toBe(never.id);
  });

  it(`предложенное больше ${String(OFFER_AGAIN_AFTER_DAYS)} дней назад — снова можно`, async () => {
    const old = await sow({
      deferredAt: new Date('2026-08-01T10:00:00.000Z'),
      offeredAt: new Date(NOW.getTime() - (OFFER_AGAIN_AFTER_DAYS + 1) * DAY),
    });

    expect((await offerFromLater(testDb(), { userId, now: NOW }))?.id).toBe(old.id);
  });

  it('по кругу: из двух годных — то, что предлагали раньше', async () => {
    const recent = await sow({
      deferredAt: new Date('2026-08-01T10:00:00.000Z'),
      offeredAt: new Date(NOW.getTime() - 10 * DAY),
    });
    const older = await sow({
      deferredAt: new Date('2026-08-01T10:00:00.000Z'),
      offeredAt: new Date(NOW.getTime() - 20 * DAY),
    });

    expect((await offerFromLater(testDb(), { userId, now: NOW }))?.id).toBe(older.id);
    expect(recent.id).not.toBe(older.id);
  });

  it('только что отложенное тем же утром не предлагается: это было бы навязчиво', async () => {
    // Нетронутое ушло в «Позже» этим утром — и тут же вернулось строкой
    // «если захочется»? Нет: предлагается отложенное хотя бы сутки назад.
    await sow({ deferredAt: new Date(NOW.getTime() - 60_000) });

    expect(await offerFromLater(testDb(), { userId, now: NOW })).toBeUndefined();
  });

  it('закрытое и убранное в фон не предлагается; нечего — undefined', async () => {
    await sow({ deferredAt: NOW, status: 'done' });
    await sow({ deferredAt: NOW, backgroundedAt: NOW });

    expect(await offerFromLater(testDb(), { userId, now: NOW })).toBeUndefined();
  });

  it('markOffered ставит отметку', async () => {
    const one = await sow({ deferredAt: new Date('2026-09-01T10:00:00.000Z') });

    await markOffered(testDb(), one.id, NOW);

    expect((await reread(one.id)).offeredAt?.toISOString()).toBe(NOW.toISOString());
    expect(await offerFromLater(testDb(), { userId, now: NOW })).toBeUndefined();
  });
});
