import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
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
  extra: {
    sourceBatchId?: string;
    priority?: 'NOW' | 'SOON' | 'LATER';
    due?: { at: string; accuracy: 'day' | 'week' | 'month' };
  } = {},
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
      deadlineAt: extra.due === undefined ? null : new Date(extra.due.at),
      deadlineAccuracy: extra.due?.accuracy ?? null,
    });
}

describe('pickMain', () => {
  it('только из этой выгрузки: до трёх её дел, остальные её дела посчитаны, старых нет (правка заказчицы 30.09.2026)', async () => {
    /**
     * Её скрин: сказала про день рождения сына, нажала «Выбрать главное» —
     * а бот «бац и выкатил» подгузники и химчистку из памяти. Выбор —
     * из того, что она только что надиктовала.
     */
    const mine = await batch();
    await task('Старое срочное', { priority: 'NOW' });
    await task('Старое обычное');
    await task('Из выгрузки — первое', { sourceBatchId: mine });
    await task('Из выгрузки — второе', { sourceBatchId: mine });
    await task('Из выгрузки — третье', { sourceBatchId: mine });
    await task('Из выгрузки — четвёртое', { sourceBatchId: mine });

    const picked = await pickMain(testDb(), { userId, batchId: mine, now: NOW, timeZone: MOSCOW });

    expect(picked.actions).toHaveLength(3);
    expect(picked.actions.every((text) => text.startsWith('Из выгрузки'))).toBe(true);
    expect(picked.hidden).toBe(1);
    expect(picked.scoped).toBe(true);
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

    // Только упомянутое в этой выгрузке — старое срочное не добирается.
    expect(picked.actions).toEqual(['Повторённое']);
  });

  it('без кода выгрузки — обычная очередь: срочное впереди', async () => {
    const mine = await batch();
    await task('Из выгрузки', { sourceBatchId: mine });
    await task('Срочное', { priority: 'NOW' });

    const picked = await pickMain(testDb(), { userId, now: NOW, timeZone: MOSCOW });

    expect(picked.actions[0]).toBe('Срочное');
  });

  it('собирается по тому, что открыто сейчас: закрытое из выгрузки не показывается, чужое не добирается', async () => {
    // Между разбором и нажатием дела выгрузки закрыли — выбирать из неё не из чего.
    const mine = await batch();
    await task('Уже сделано', { sourceBatchId: mine });
    await task('Ещё открыто', { sourceBatchId: mine });
    await testDb().update(items).set({ status: 'done' });
    await task('Открыто позже');

    const picked = await pickMain(testDb(), { userId, batchId: mine, now: NOW, timeZone: MOSCOW });

    expect(picked.actions).toEqual([]);
    expect(picked.hidden).toBe(0);
  });

  it('выгрузка без упомянутых дел (старая) — обычная очередь, как без кода', async () => {
    const empty = await batch();
    await task('Срочное', { priority: 'NOW' });

    const picked = await pickMain(testDb(), { userId, batchId: empty, now: NOW, timeZone: MOSCOW });

    expect(picked.actions).toEqual(['Срочное']);
    expect(picked.scoped).toBeUndefined();
  });

  it('пусто — нет ни дел, ни скрытых', async () => {
    const picked = await pickMain(testDb(), { userId, now: NOW, timeZone: MOSCOW });

    expect(picked).toEqual({ actions: [], hidden: 0, firstItemId: undefined });
  });

  it('срок — после дела, словами карточки (Никита, 17.09.2026)', async () => {
    /**
     * Бой 17.09: «На сегодня я бы взяла: — В пятницу надо забрать
     * справку» — день был виден только потому, что модель оставила его в
     * заголовке. С чистыми заголовками список читался бы как «сделай
     * сегодня», а справка — в пятницу. Срок дописывается после дела, как
     * в списке ветки; «сегодня» не пишется — заголовок уже про сегодня.
     */
    // NOW — 15.09.2026, вторник, 12:00 по Москве.
    await task('Забрать справку', {
      priority: 'NOW',
      due: { at: '2026-09-15T21:00:00.000Z', accuracy: 'day' },
    });
    await task('Записаться к стоматологу', {
      due: { at: '2026-09-20T21:00:00.000Z', accuracy: 'week' },
    });
    await task('Пройти диспансеризацию', {
      due: { at: '2026-09-30T21:00:00.000Z', accuracy: 'month' },
    });

    const picked = await pickMain(testDb(), {
      userId,
      now: NOW,
      timeZone: MOSCOW,
      texts: defaultTexts,
    });

    expect(picked.actions).toEqual([
      'Забрать справку · завтра',
      'Записаться к стоматологу · на неделе с 21.09',
      'Пройти диспансеризацию · в октябре',
    ]);
  });

  it('сегодня и без срока — без хвоста; послезавтра — числом', async () => {
    await task('Позвонить в банк', {
      priority: 'NOW',
      due: { at: '2026-09-14T21:00:00.000Z', accuracy: 'day' },
    });
    await task('Отвести дочку на танцы', {
      priority: 'NOW',
      due: { at: '2026-09-16T21:00:00.000Z', accuracy: 'day' },
    });
    await task('Попросить мужа забрать посылку', { priority: 'NOW' });

    const picked = await pickMain(testDb(), {
      userId,
      now: NOW,
      timeZone: MOSCOW,
      texts: defaultTexts,
    });

    expect(picked.actions).toEqual([
      'Позвонить в банк',
      'Отвести дочку на танцы · 17.09',
      'Попросить мужа забрать посылку',
    ]);
  });
});
