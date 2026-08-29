import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, type Item } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { applyDecision } from '../../modules/resolver/patch.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { defaultTexts } from '../../texts/index.js';
import { toShortId } from '../short-id.js';
import { registerUndoHandlers, undoKeyboard, UNDO_PREFIX } from './undo.js';

/**
 * Откат через настоящий обработчик (§7.3 ТЗ, задача 3.4).
 *
 * Хранилище ревизий проверено отдельно. Здесь проверяется то, что живёт
 * только в боте: кнопка под сообщением, один тап, и что нажатие по
 * вчерашней кнопке отвечает человеку, а не роняет обработчик.
 *
 * Разрыв между «служба работает» и «в боте не вызывается» этот проект
 * уже ловил на статусном сообщении. Поэтому связка проверяется всегда.
 */

const logger = createLogger({ level: 'silent' });
const TG_ID = 5151;
const NOW = new Date('2026-08-29T12:00:00.000Z');
const MOSCOW = 'Europe/Moscow';

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

  registerUndoHandlers(bot, testDb(), logger);
  return { bot, calls };
}

function callbackUpdate(data: string): Update {
  seq++;

  return {
    update_id: 700_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      chat_instance: 'test',
      data,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: TG_ID, type: 'private' },
      },
    },
  } as unknown as Update;
}

function edits(calls: readonly ApiCall[]): string[] {
  return calls
    .filter((call) => call.method === 'editMessageText')
    .map((call) => String(call.payload['text']));
}

async function sow(): Promise<Item> {
  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: 'Записать сына к врачу в четверг',
      type: 'TASK',
      priority: 'SOON',
      topic: 'здоровье',
    })
    .returning();

  if (!row) throw new Error('запись не создалась');
  return row;
}

async function completeIt(item: Item): Promise<string> {
  const applied = await applyDecision(testDb(), {
    userId,
    itemId: item.id,
    action: 'complete',
    changes: { text: '', deadline: '', deadlineAccuracy: 'none' },
    timeZone: MOSCOW,
    now: NOW,
  });

  return applied?.revisionId ?? '';
}

beforeEach(async () => {
  seq++;
  userId = (await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' })).id;
});

describe('кнопка отмены', () => {
  it('ведёт на ту ревизию, которую создало изменение', () => {
    const keyboard = undoKeyboard('11111111-1111-4111-8111-111111111111', defaultTexts);
    const button = keyboard.inline_keyboard[0]?.[0];

    expect(button?.text).toBe(defaultTexts.resolver.buttonUndo);
    expect(button && 'callback_data' in button ? button.callback_data : '').toBe(
      `${UNDO_PREFIX}${toShortId('11111111-1111-4111-8111-111111111111')}`,
    );
  });
});

describe('нажатие', () => {
  it('возвращает запись и говорит об этом', async () => {
    const item = await sow();
    const revisionId = await completeIt(item);

    const { bot, calls } = createTestBot();
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${UNDO_PREFIX}${toShortId(revisionId)}`));

    expect(edits(calls)).toEqual([defaultTexts.resolver.undone]);

    const [after] = await testDb().select().from(items).where(eq(items.id, item.id));
    expect(after?.status).toBe('new');
  });

  it('второе нажатие отвечает «уже отменено» и ничего не меняет', async () => {
    const item = await sow();
    const revisionId = await completeIt(item);
    const data = `${UNDO_PREFIX}${toShortId(revisionId)}`;

    const { bot, calls } = createTestBot();
    await bot.init();
    await bot.handleUpdate(callbackUpdate(data));
    await bot.handleUpdate(callbackUpdate(data));

    expect(edits(calls)).toEqual([
      defaultTexts.resolver.undone,
      defaultTexts.resolver.alreadyUndone,
    ]);

    const [after] = await testDb().select().from(items).where(eq(items.id, item.id));
    expect(after?.status).toBe('new');
  });

  it('кнопка исчезает вместе с сообщением об изменении', async () => {
    // Оставить кнопку — значит пообещать, что нажатие ещё что-то делает.
    const item = await sow();
    const revisionId = await completeIt(item);

    const { bot, calls } = createTestBot();
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${UNDO_PREFIX}${toShortId(revisionId)}`));

    const edit = calls.find((call) => call.method === 'editMessageText');
    expect(edit?.payload['reply_markup']).toBeUndefined();
  });

  it('подобранный код чужой ревизии ничего не откатывает', async () => {
    const stranger = await upsertUser(testDb(), { tgId: TG_ID + 1, firstName: 'Чужая' });
    const [foreign] = await testDb()
      .insert(items)
      .values({
        userId: stranger.id,
        text: 'Чужое дело',
        type: 'TASK',
        priority: 'SOON',
        topic: 'личное',
      })
      .returning();

    const applied = await applyDecision(testDb(), {
      userId: stranger.id,
      itemId: foreign?.id ?? '',
      action: 'complete',
      changes: { text: '', deadline: '', deadlineAccuracy: 'none' },
      timeZone: MOSCOW,
      now: NOW,
    });

    const { bot, calls } = createTestBot();
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${UNDO_PREFIX}${toShortId(applied?.revisionId ?? '')}`));

    expect(edits(calls)).toEqual([defaultTexts.resolver.undoGone]);

    const [after] = await testDb()
      .select()
      .from(items)
      .where(eq(items.id, foreign?.id ?? ''));
    expect(after?.status).toBe('done');
  });

  it('нажатие по несуществующей ревизии отвечает, а не падает', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();
    await bot.handleUpdate(
      callbackUpdate(`${UNDO_PREFIX}${toShortId('99999999-9999-4999-8999-999999999999')}`),
    );

    expect(edits(calls)).toEqual([defaultTexts.resolver.undoGone]);
  });
});
