import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { pickMain, rememberMentioned } from './pick.service.js';

/**
 * «Выбрать главное» (решение заказчицы 15.09.2026): список собирается в
 * момент нажатия той же очередью выдачи, что раньше шла под признанием.
 */
const NOW = new Date('2026-09-15T09:00:00.000Z');
const MOSCOW = 'Europe/Moscow';

let userId = '';

beforeEach(async () => {
  userId = (await upsertUser(testDb(), { tgId: 915_001, firstName: 'Аня' })).id;
});

async function batch(): Promise<string> {
  const [row] = await testDb()
    .insert(batches)
    .values({ userId, status: 'done' })
    .returning({ id: batches.id });
  return row!.id;
}

async function task(
  text: string,
  extra: { sourceBatchId?: string; priority?: 'NOW' | 'SOON' | 'LATER' } = {},
) {
  await testDb()
    .insert(items)
    .values({
      userId,
      text,
      type: 'TASK',
      priority: extra.priority ?? 'SOON',
      topic: 'личное',
      sourceBatchId: extra.sourceBatchId ?? null,
    });
}

describe('pickMain', () => {
  it('до трёх дел, сказанное в этой выгрузке — первым, остальное посчитано', async () => {
    const mine = await batch();
    await task('Старое срочное', { priority: 'NOW' });
    await task('Старое обычное');
    await task('Ещё старое');
    await task('Из выгрузки — первое', { sourceBatchId: mine });
    await task('Из выгрузки — второе', { sourceBatchId: mine });

    const picked = await pickMain(testDb(), { userId, batchId: mine, now: NOW, timeZone: MOSCOW });

    expect(picked.actions).toHaveLength(3);
    expect(picked.actions.slice(0, 2)).toEqual(['Из выгрузки — первое', 'Из выгрузки — второе']);
    expect(picked.actions[2]).toBe('Старое срочное');
    expect(picked.hidden).toBe(2);
    expect(picked.firstItemId).toBeDefined();
  });

  it('повтор дела: выгрузка запомнила упомянутое, и оно идёт первым', async () => {
    // Повтор записи не заводит (same-text.ts): по `sourceBatchId` её не
    // найти, а человек о ней сейчас говорил — конвейер запоминает
    // упомянутое в выгрузке (`rememberMentioned`).
    const first = await batch();
    await task('Срочное старое', { priority: 'NOW' });
    await task('Повторённое', { sourceBatchId: first });
    const repeat = await batch();
    const [repeated] = await testDb()
      .select({ id: items.id })
      .from(items)
      .where(eq(items.text, 'Повторённое'));
    await rememberMentioned(testDb(), repeat, [repeated!.id]);

    const picked = await pickMain(testDb(), {
      userId,
      batchId: repeat,
      now: NOW,
      timeZone: MOSCOW,
    });

    expect(picked.actions).toEqual(['Повторённое', 'Срочное старое']);
  });

  it('без кода выгрузки — обычная очередь: срочное впереди', async () => {
    const mine = await batch();
    await task('Из выгрузки', { sourceBatchId: mine });
    await task('Срочное', { priority: 'NOW' });

    const picked = await pickMain(testDb(), { userId, now: NOW, timeZone: MOSCOW });

    expect(picked.actions[0]).toBe('Срочное');
  });

  it('собирается по тому, что открыто сейчас, а не на момент разбора', async () => {
    // Между разбором и нажатием дело закрыли — в списке его нет.
    const mine = await batch();
    await task('Уже сделано', { sourceBatchId: mine });
    await task('Ещё открыто', { sourceBatchId: mine });
    await testDb().update(items).set({ status: 'done' });
    await task('Открыто позже');

    const picked = await pickMain(testDb(), { userId, batchId: mine, now: NOW, timeZone: MOSCOW });

    expect(picked.actions).toEqual(['Открыто позже']);
    expect(picked.hidden).toBe(0);
  });

  it('пусто — нет ни дел, ни скрытых', async () => {
    const picked = await pickMain(testDb(), { userId, now: NOW, timeZone: MOSCOW });

    expect(picked).toEqual({ actions: [], hidden: 0, firstItemId: undefined });
  });
});
