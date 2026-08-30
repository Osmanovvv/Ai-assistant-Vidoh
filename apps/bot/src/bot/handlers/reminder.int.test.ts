import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { itemRevisions, items, projectSteps, type Item } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { defaultTexts } from '../../texts/index.js';
import { toShortId } from '../../modules/shared/short-id.js';
import { REMINDER_ACTION } from '../../modules/scheduler/reminder-actions.js';
import { registerReminderHandlers } from './reminder.js';

/**
 * Кнопки под напоминаниями (задачи 3.13 и 3.16).
 *
 * Проверяется не текст, а последствие: после «Сделано» запись закрыта,
 * после «Перенести» срок сдвинут, и у обоих есть ревизия — значит и
 * откат (инвариант 7).
 *
 * Кнопка, которая только закрывает сообщение, учит не нажимать кнопки
 * вообще, и следующее напоминание человек уже проигнорирует. Поэтому
 * последствие каждой проверяется в базе.
 */

const logger = createLogger({ level: 'silent' });
const TG_ID = 5555;

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

let userId = '';
let seq = 0;

function createTestBot(): { bot: Bot; calls: ApiCall[] } {
  const botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'ВЫДОХ',
    username: 'vydoh_test_bot',
  } as unknown as UserFromGetMe;

  const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', { botInfo });
  const calls: ApiCall[] = [];

  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });

    const result =
      method === 'answerCallbackQuery'
        ? true
        : { message_id: calls.length, date: 0, chat: { id: TG_ID, type: 'private' } };

    return Promise.resolve({ ok: true, result } as never);
  });

  registerReminderHandlers(bot, testDb(), logger);
  return { bot, calls };
}

function callbackUpdate(data: string): Update {
  seq += 1;

  return {
    update_id: 810_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      chat_instance: 'test',
      data,
      message: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
    },
  } as unknown as Update;
}

const edits = (calls: readonly ApiCall[]): string[] =>
  calls
    .filter((call) => call.method === 'editMessageText')
    .map((call) => String(call.payload['text']));

const keyboardOf = (calls: readonly ApiCall[]): string[] => {
  const last = calls.filter((call) => call.method === 'editMessageText').at(-1);
  const markup = last?.payload['reply_markup'] as
    { inline_keyboard?: { text: string }[][] } | undefined;

  return (markup?.inline_keyboard ?? []).flat().map((button) => button.text);
};

const DAY = 24 * 60 * 60_000;

async function sow(overrides: Partial<typeof items.$inferInsert> = {}): Promise<Item> {
  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: 'Оплатить квитанцию',
      type: 'TASK',
      priority: 'SOON',
      topic: 'деньги',
      deadlineAt: new Date(Date.now() + DAY),
      deadlineAccuracy: 'day',
      ...overrides,
    })
    .returning();

  if (!row) throw new Error('запись не создалась');
  return row;
}

async function reload(id: string): Promise<Item | undefined> {
  const [row] = await testDb().select().from(items).where(eq(items.id, id));
  return row;
}

async function revisionCount(itemId: string): Promise<number> {
  return (await testDb().select().from(itemRevisions).where(eq(itemRevisions.itemId, itemId)))
    .length;
}

beforeEach(async () => {
  userId = (await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' })).id;
  await testDb().delete(items).where(eq(items.userId, userId));
});

describe('«Сделано»', () => {
  it('закрывает запись', async () => {
    const item = await sow();
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${REMINDER_ACTION.done}${toShortId(item.id)}`));

    expect((await reload(item.id))?.status).toBe('done');
    expect(edits(calls).at(-1)).toBe(defaultTexts.reminders.done);
  });

  it('оставляет ревизию и кнопку отката', async () => {
    // Инвариант 7: у каждого автоматического изменения есть снимок «до».
    const item = await sow();
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${REMINDER_ACTION.done}${toShortId(item.id)}`));

    expect(await revisionCount(item.id)).toBe(1);
    expect(keyboardOf(calls)).toContain(defaultTexts.resolver.buttonUndo);
  });

  it('регулярное дело не закрывается, а переезжает вперёд', async () => {
    /**
     * Самое дорогое место здесь. Своя правка статуса вместо `complete`
     * закрыла бы «оплатить садик» навсегда после первого месяца, и
     * заметить это можно было бы только через месяц.
     *
     * Пропущенные две недели — тот самый случай из 3.8а: следующий срок
     * считается от сегодня, поэтому получается один ближайший день, а не
     * догоняющая очередь из трёх просроченных.
     */
    const missed = new Date(Date.now() - 14 * DAY);
    const item = await sow({
      deadlineAt: missed,
      recurrenceRule: {
        kind: 'weekly',
        interval: 1,
        anchor: missed.toISOString().slice(0, 10),
      },
      recurrenceText: 'каждую неделю',
      recurrenceSource: 'stated',
    });

    const { bot } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${REMINDER_ACTION.done}${toShortId(item.id)}`));

    const after = await reload(item.id);
    expect(after?.status).not.toBe('done');
    expect(after?.deadlineAt?.getTime()).toBeGreaterThan(Date.now());

    // Второй записи не появилось: пропуск не размножает дела.
    const all = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(all).toHaveLength(1);
  });

  it('чужую запись не трогает', async () => {
    const stranger = await upsertUser(testDb(), { tgId: TG_ID + 1, firstName: 'Оля' });
    const [alien] = await testDb()
      .insert(items)
      .values({ userId: stranger.id, text: 'Не моё', type: 'TASK', priority: 'SOON', topic: 'быт' })
      .returning();

    const { bot } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${REMINDER_ACTION.done}${toShortId(alien?.id ?? '')}`));

    expect((await reload(alien?.id ?? ''))?.status).not.toBe('done');
  });

  it('по вчерашней кнопке отвечает, а не падает', async () => {
    const item = await sow();
    await testDb().delete(items).where(eq(items.id, item.id));

    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${REMINDER_ACTION.done}${toShortId(item.id)}`));

    expect(edits(calls).at(-1)).toBe(defaultTexts.card.gone);
  });
});

describe('«Перенести»', () => {
  it('двигает срок на сутки вперёд', async () => {
    const item = await sow();
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${REMINDER_ACTION.postpone}${toShortId(item.id)}`));

    const after = await reload(item.id);
    const moved = (after?.deadlineAt?.getTime() ?? 0) - (item.deadlineAt?.getTime() ?? 0);

    expect(moved).toBeGreaterThan(0);
    expect(after?.status).not.toBe('done');
    expect(edits(calls).at(-1)).toMatch(/Перенесла/u);
  });

  it('просроченное считает от сегодня, а не от старого срока', async () => {
    // Иначе «перенести» вчерашнее дело оставило бы его в прошлом.
    const item = await sow({ deadlineAt: new Date(Date.now() - 5 * DAY) });
    const { bot } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${REMINDER_ACTION.postpone}${toShortId(item.id)}`));

    expect((await reload(item.id))?.deadlineAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('оставляет ревизию', async () => {
    const item = await sow();
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${REMINDER_ACTION.postpone}${toShortId(item.id)}`));

    expect(await revisionCount(item.id)).toBe(1);
    expect(keyboardOf(calls)).toContain(defaultTexts.resolver.buttonUndo);
  });
});

describe('вопрос про застрявший проект', () => {
  async function sowProject(): Promise<Item> {
    const item = await sow({
      text: 'День рождения сына',
      isProject: true,
      deadlineAt: null,
      deadlineAccuracy: null,
    });

    await testDb()
      .insert(projectSteps)
      .values({ itemId: item.id, userId, text: 'выбрать кафе', position: 0 });

    return item;
  }

  it('«Возьмусь» ставит проекту срок на сегодня', async () => {
    const item = await sowProject();
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${REMINDER_ACTION.projectTake}${toShortId(item.id)}`));

    expect((await reload(item.id))?.deadlineAt).not.toBeNull();
    expect(edits(calls).at(-1)).toBe(defaultTexts.reminders.projectTaken);
  });

  it('«Не сейчас» ничего не меняет', async () => {
    const item = await sowProject();
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${REMINDER_ACTION.projectLater}${toShortId(item.id)}`));

    expect((await reload(item.id))?.deadlineAt).toBeNull();
    expect(await revisionCount(item.id)).toBe(0);
    expect(edits(calls).at(-1)).toBe(defaultTexts.reminders.projectLater);
  });

  it('у законченного проекта отвечает, что всё сделано', async () => {
    const item = await sowProject();
    await testDb()
      .update(projectSteps)
      .set({ doneAt: new Date() })
      .where(eq(projectSteps.itemId, item.id));

    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${REMINDER_ACTION.projectTake}${toShortId(item.id)}`));

    expect(edits(calls).at(-1)).toBe(defaultTexts.project.finished);
  });
});
