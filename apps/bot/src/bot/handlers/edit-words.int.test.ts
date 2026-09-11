import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { itemRevisions, items, messagesRaw, userSettings } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import type { PipelineJob } from '../../infra/queue.js';
import { AWAITING_TTL_MS } from '../../modules/onboarding/awaiting.js';
import { toShortId } from '../../modules/shared/short-id.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { consumeAwaited } from './awaiting.js';
import { MENU_ACTION, registerMenuHandlers } from './menu.js';
import { registerCardHandlers } from './card.js';
import { incomingMiddleware } from './incoming.js';

/**
 * Правка записи словами из карточки (задача 3.61, пункт 5 заказчика).
 *
 * Кнопка «Изменить» была заглушкой: она говорила «пока меняю только
 * статус и срок — кнопками рядом», то есть обещала правку и не делала её.
 * Заказчик назвал это заглушкой прямо, и он прав — кнопка, которая ничего
 * не меняет, хуже отсутствующей.
 *
 * Здесь проверяется связка целиком: нажал, написал, запись переписана, и
 * у человека есть кнопка отмены.
 */

const logger = createLogger({ level: 'silent' });
const TG_ID = 8181;

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

const stubQueue = {
  getJob: () => Promise.resolve(undefined),
  add: () => Promise.resolve({}),
} as unknown as Queue<PipelineJob>;

let seq = 0;
let userId: string;

function createTestBot(): { bot: Bot; calls: ApiCall[] } {
  const botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'ВЫДОХ',
    username: 'vydoh_test_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
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

  bot.use(
    incomingMiddleware({
      db: testDb(),
      queue: stubQueue,
      consume: consumeAwaited({ db: testDb(), logger }),
    }),
  );
  registerCardHandlers(bot, { db: testDb(), logger }, MENU_ACTION.root);
  // Настройки — сосед ожидания: их переключатели правят ту же строку
  // `user_settings`, и окно ожидания обязано этого не замечать.
  registerMenuHandlers(bot, testDb(), logger);

  return { bot, calls };
}

function textUpdate(text: string): Update {
  seq++;
  return {
    update_id: 800_000 + seq,
    message: {
      message_id: seq,
      date: Math.floor(Date.UTC(2026, 8, 4) / 1000),
      chat: { id: TG_ID, type: 'private', first_name: 'Аня' },
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      text,
    },
  } as unknown as Update;
}

function callbackUpdate(data: string): Update {
  seq++;
  return {
    update_id: 800_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      chat_instance: 'test',
      data,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: TG_ID, type: 'private', first_name: 'Аня' },
      },
    },
  } as unknown as Update;
}

function textOf(call: ApiCall | undefined): string {
  const value = call?.payload['text'];
  return typeof value === 'string' ? value : '';
}

function keyboardOf(call: ApiCall | undefined): { text: string; callback_data?: string }[] {
  const markup = call?.payload['reply_markup'] as
    { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

async function addItem(text: string): Promise<string> {
  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text,
      type: 'TASK',
      priority: 'SOON',
      topic: 'личное',
      sourceOrder: 0,
    })
    .returning({ id: items.id });

  return row!.id;
}

async function textOfItem(id: string): Promise<string | undefined> {
  const [row] = await testDb().select({ text: items.text }).from(items).where(eq(items.id, id));
  return row?.text;
}

async function awaitingOfUser(): Promise<string | null> {
  const [row] = await testDb()
    .select({ awaiting: userSettings.awaitingInput })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));

  return row?.awaiting ?? null;
}

beforeEach(async () => {
  seq = 0;
  userId = (await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' })).id;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Ушла ли реплика в разбор: сообщение привязано к выгрузке. */
async function wentToDump(text: string): Promise<boolean> {
  const [row] = await testDb()
    .select({ batchId: messagesRaw.batchId })
    .from(messagesRaw)
    .where(eq(messagesRaw.text, text));

  return row?.batchId != null;
}

describe('правка записи словами', () => {
  it('нажал, написал — запись переписана, и есть чем отменить', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem('к врачу');

    await bot.handleUpdate(callbackUpdate(`i:edt:${toShortId(itemId)}`));
    expect(await awaitingOfUser()).toBe(`edit:${itemId}`);

    await bot.handleUpdate(textUpdate('Записаться к стоматологу на следующую неделю'));

    expect(await textOfItem(itemId)).toBe('Записаться к стоматологу на следующую неделю');
    expect(await awaitingOfUser()).toBeNull();

    // §7.3 требует двух вещей от применённого изменения: показать, что
    // изменилось, и дать кнопку отмены.
    const last = calls.filter((call) => call.method === 'sendMessage').at(-1);
    expect(textOf(last)).toContain('Записаться к стоматологу');
    expect(keyboardOf(last).map((button) => button.text)).toContain(
      defaultTexts.resolver.buttonUndo,
    );

    // И правка записана: без ревизии отменять было бы нечего.
    const revisions = await testDb()
      .select({ id: itemRevisions.id })
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, itemId));

    expect(revisions).toHaveLength(1);
  });

  it('тот же текст записи не меняет и лишней ревизии не заводит', async () => {
    /**
     * Запись сравнивается **с заглавной**: тексты дел начинаются с
     * большой буквы (задача 3.25), и присланное «к врачу» отличалось бы
     * от «К врачу» одним регистром — правка легла бы на пустом месте.
     * Поэтому здесь и запись, и присланное уже с заглавной.
     */
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem('К врачу');

    await bot.handleUpdate(callbackUpdate(`i:edt:${toShortId(itemId)}`));
    await bot.handleUpdate(textUpdate('К врачу'));

    expect(await textOfItem(itemId)).toBe('К врачу');
    expect(
      calls.filter((call) => call.method === 'sendMessage').map((call) => textOf(call)),
    ).toContain(defaultTexts.card.editNotApplied);

    const revisions = await testDb()
      .select({ id: itemRevisions.id })
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, itemId));

    expect(revisions).toEqual([]);
  });

  it('без нажатия «Изменить» текст уходит в разбор, а не в запись', async () => {
    /**
     * Ожидание включается **только** явным нажатием. Иначе любая реплика
     * человека переписывала бы последнюю открытую запись — и это ровно
     * то, чего опрос на кнопках избегал.
     */
    const { bot } = createTestBot();
    await bot.init();

    const itemId = await addItem('к врачу');
    await bot.handleUpdate(textUpdate('совсем другое дело'));

    expect(await textOfItem(itemId)).toBe('к врачу');
    expect(await awaitingOfUser()).toBeNull();
  });
});

/**
 * Окно в четверть часа (задача 3.61, вторая страховка).
 *
 * «Нажал и отвлёкся на день, а вернувшись сказал мысль — мысль уйдёт в
 * разбор, а не в имя». Обещание держится на моменте нажатия, и мерить
 * его надо от самого нажатия, а не от последней правки строки настроек:
 * ту же строку правят переключатели меню и шаги опроса, и каждая такая
 * правка продлевала бы окно (ревизия этапов 1–2, дефект 28).
 *
 * Часы подменяются только у `Date`: таймеры драйвера базы и очереди
 * остаются настоящими, иначе запрос к базе повис бы на подменённом
 * `setTimeout`.
 */
describe('окно ожидания', () => {
  const pressedAt = new Date('2026-09-04T10:00:00Z');

  it('нажал и вернулся через час — запись цела, мысль ушла в разбор', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: pressedAt });

    const { bot } = createTestBot();
    await bot.init();

    const itemId = await addItem('К врачу');
    await bot.handleUpdate(callbackUpdate(`i:edt:${toShortId(itemId)}`));

    vi.setSystemTime(new Date(pressedAt.getTime() + AWAITING_TTL_MS + 60_000));
    await bot.handleUpdate(textUpdate('Позвонить бабушке'));

    expect(await textOfItem(itemId)).toBe('К врачу');
    expect(await awaitingOfUser()).toBeNull();
    expect(await wentToDump('Позвонить бабушке')).toBe(true);
  });

  it('переключатель настроек в промежутке окно не продлевает', async () => {
    /**
     * Нажал «Изменить», через пятьдесят пять минут зашёл в настройки и
     * выключил напоминания, ещё через пять минут сказал мысль. По
     * `updated_at` строки настроек мысль сказана «через пять минут после
     * нажатия» — и переписала бы запись.
     */
    vi.useFakeTimers({ toFake: ['Date'], now: pressedAt });

    const { bot } = createTestBot();
    await bot.init();

    const itemId = await addItem('К врачу');
    await bot.handleUpdate(callbackUpdate(`i:edt:${toShortId(itemId)}`));
    expect(await awaitingOfUser()).toBe(`edit:${itemId}`);

    vi.setSystemTime(new Date(pressedAt.getTime() + 55 * 60_000));
    await bot.handleUpdate(callbackUpdate(MENU_ACTION.toggleReminders));

    vi.setSystemTime(new Date(pressedAt.getTime() + 60 * 60_000));
    await bot.handleUpdate(textUpdate('Позвонить бабушке'));

    expect(await textOfItem(itemId)).toBe('К врачу');
    expect(await awaitingOfUser()).toBeNull();
    expect(await wentToDump('Позвонить бабушке')).toBe(true);
  });
});
