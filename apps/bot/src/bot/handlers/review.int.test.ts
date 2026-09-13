import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { itemRevisions, items, type Item } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { REVIEW_ACTION } from '../../modules/scheduler/digest.js';
import { toShortId } from '../../modules/shared/short-id.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { defaultTexts } from '../../texts/index.js';
import { registerReviewHandlers } from './review.js';

/**
 * Кнопки разбора вчерашнего (запрос на изменение №4): «На сегодня»,
 * «Позже», «Убрать». Каждая — решение с ревизией и откатом, ответ —
 * отдельной репликой: разбор общий на несколько дел, и переписывать его
 * одним нажатием нельзя.
 */

const logger = createLogger({ level: 'silent' });
const TG_ID = 5656;
const DAY = 24 * 60 * 60_000;

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

  registerReviewHandlers(bot, testDb(), logger);
  return { bot, calls };
}

function callbackUpdate(data: string): Update {
  seq += 1;
  return {
    update_id: 820_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      chat_instance: 'test',
      data,
      message: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
    },
  } as unknown as Update;
}

const replies = (calls: readonly ApiCall[]): string[] =>
  calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.payload['text']));

const edits = (calls: readonly ApiCall[]): number =>
  calls.filter((call) => call.method === 'editMessageText').length;

async function sow(overrides: Partial<typeof items.$inferInsert> = {}): Promise<Item> {
  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: 'Оплатить садик',
      type: 'TASK',
      priority: 'SOON',
      topic: 'дети',
      deadlineAt: new Date(Date.now() - 2 * DAY),
      deadlineAccuracy: 'day',
      reviewedAt: new Date(),
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

beforeEach(async () => {
  userId = (await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' })).id;
  await testDb().delete(items).where(eq(items.userId, userId));
});

describe('«На сегодня»', () => {
  it('ставит срок на сегодня, отвечает отдельной репликой с откатом, разбор не переписывает', async () => {
    const item = await sow();
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(callbackUpdate(`${REVIEW_ACTION.today}:${toShortId(item.id)}`));

    const after = await reload(item.id);
    expect(after?.deadlineAt?.getTime()).toBeGreaterThan(Date.now() - DAY);
    expect(after?.deadlineAccuracy).toBe('day');
    expect(edits(calls)).toBe(0);
    expect(replies(calls)).toHaveLength(1);

    const revisions = await testDb()
      .select()
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, item.id));
    expect(revisions).toHaveLength(1);
  });
});

describe('«Позже»', () => {
  it('снимает срок, ставит отметку, говорит «убрала с сегодняшнего»', async () => {
    const item = await sow();
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(callbackUpdate(`${REVIEW_ACTION.later}:${toShortId(item.id)}`));

    const after = await reload(item.id);
    expect(after?.deadlineAt).toBeNull();
    expect(after?.deferredAt).not.toBeNull();
    expect(after?.status).toBe('new');
    expect(replies(calls)).toEqual([defaultTexts.card.deferred]);
  });
});

describe('«Убрать»', () => {
  it('отменяет дело', async () => {
    const item = await sow();
    const { bot } = createTestBot();

    await bot.handleUpdate(callbackUpdate(`${REVIEW_ACTION.drop}:${toShortId(item.id)}`));

    expect((await reload(item.id))?.status).toBe('cancelled');
  });
});

describe('края', () => {
  it('чужую запись не трогает', async () => {
    const stranger = await upsertUser(testDb(), { tgId: TG_ID + 1, firstName: 'Оля' });
    const [alien] = await testDb()
      .insert(items)
      .values({ userId: stranger.id, text: 'Не моё', type: 'TASK', priority: 'SOON', topic: 'быт' })
      .returning();
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(callbackUpdate(`${REVIEW_ACTION.later}:${toShortId(alien!.id)}`));

    expect((await reload(alien!.id))?.deferredAt).toBeNull();
    expect(replies(calls)).toEqual([defaultTexts.card.gone]);
  });

  it('на уже закрытом деле говорит, что оно закрыто', async () => {
    const item = await sow({ status: 'done' });
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(callbackUpdate(`${REVIEW_ACTION.today}:${toShortId(item.id)}`));

    expect(replies(calls)).toEqual([
      defaultTexts.card.closed(defaultTexts.card.statusName('done')),
    ]);
  });
});
