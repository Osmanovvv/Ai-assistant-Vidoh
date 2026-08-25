import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, messagesRaw, users } from '../../db/schema.js';
import type { PipelineJob } from '../../infra/queue.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { incomingMiddleware } from './incoming.js';
import {
  DELETE_CANCEL,
  DELETE_STEP_ONE,
  DELETE_STEP_TWO,
  registerPrivacyHandlers,
} from './privacy.js';
import { registerStartHandlers } from './start.js';

/**
 * Экспорт и удаление данных через настоящие обработчики бота (задача 1.20).
 *
 * Сервис приватности был покрыт тестами и до этого, но его подключение к
 * боту — нет. Ровно на таком разрыве попалось статусное сообщение: модуль
 * есть, тесты зелёные, а в боте он не вызывается. Здесь проверяется именно
 * связка: команда пришла — данные исчезли.
 *
 * Telegram подменён обработчиком запросов grammY: сеть не нужна, а список
 * вызовов виден целиком.
 */

const logger = createLogger({ level: 'silent' });
const POLICY_URL = 'https://vydoh.test/privacy';
const TG_ID = 4242;

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

/** Очередь боту нужна, но в этом тесте она ничего не решает. */
const stubQueue = {
  getJob: () => Promise.resolve(undefined),
  add: () => Promise.resolve({}),
} as unknown as Queue<PipelineJob>;

function createTestBot(options: { withIncoming?: boolean } = {}): { bot: Bot; calls: ApiCall[] } {
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

    // Правдоподобный минимум: обработчикам важен только сам факт ответа.
    const result =
      method === 'answerCallbackQuery'
        ? true
        : { message_id: calls.length, date: 0, chat: { id: TG_ID, type: 'private' } };

    return Promise.resolve({ ok: true, result } as never);
  });

  if (options.withIncoming !== false) {
    bot.use(incomingMiddleware({ db: testDb(), queue: stubQueue }));
  }
  registerStartHandlers(bot, POLICY_URL);
  registerPrivacyHandlers(bot, testDb(), logger);

  return { bot, calls };
}

/** Так Telegram решает, команда это или обычный текст. */
const COMMAND_RE = /^\/[A-Za-z0-9_]{1,64}(?:@[A-Za-z0-9_]+)?(?:$|\s)/u;

let seq = 0;

function textUpdate(text: string): Update {
  seq++;

  // Команду Telegram помечает служебной разметкой bot_command, и grammY
  // ищет именно её. Разметку он ставит не на всё, что начинается со
  // слэша: «/ надо бы разобраться» — это текст, а не команда.
  const isCommand = COMMAND_RE.test(text);
  const entities = isCommand
    ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? text.length }]
    : undefined;

  return {
    update_id: 500_000 + seq,
    message: {
      message_id: seq,
      date: Math.floor(Date.UTC(2026, 7, 25) / 1000),
      chat: { id: TG_ID, type: 'private', first_name: 'Аня' },
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      text,
      ...(entities === undefined ? {} : { entities }),
    },
  } as unknown as Update;
}

function callbackUpdate(data: string): Update {
  seq++;
  return {
    update_id: 500_000 + seq,
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

/** Человек с профилем, сообщением и выгрузкой. */
async function seedUser(): Promise<string> {
  const user = await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' });

  const [message] = await testDb()
    .insert(messagesRaw)
    .values({
      userId: user.id,
      updateId: 9001,
      tgChatId: TG_ID,
      tgMessageId: 9001,
      kind: 'text',
      text: 'надо записаться к врачу',
    })
    .returning({ id: messagesRaw.id });

  const [batch] = await testDb()
    .insert(batches)
    .values({ userId: user.id, status: 'done', combinedText: 'надо записаться к врачу' })
    .returning({ id: batches.id });

  await testDb()
    .update(messagesRaw)
    .set({ batchId: batch!.id })
    .where(eq(messagesRaw.id, message!.id));

  return user.id;
}

async function rowsFor(
  tgId: number,
): Promise<{ users: number; messages: number; batches: number }> {
  const found = await testDb().select().from(users).where(eq(users.tgId, tgId));
  const userId = found[0]?.id;

  if (userId === undefined) return { users: 0, messages: 0, batches: 0 };

  const messages = await testDb().select().from(messagesRaw).where(eq(messagesRaw.userId, userId));
  const dumps = await testDb().select().from(batches).where(eq(batches.userId, userId));

  return { users: found.length, messages: messages.length, batches: dumps.length };
}

beforeEach(() => {
  seq = 0;
});

describe('/start', () => {
  it('показывает согласие со ссылкой на политику (§16 ТЗ)', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate('/start'));

    const reply = calls.find((call) => call.method === 'sendMessage');
    expect(reply).toBeDefined();
    expect(String(reply?.payload['text'])).toContain(POLICY_URL);
  });
});

describe('/export_my_data', () => {
  it('отдаёт данные файлом', async () => {
    await seedUser();
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate('/export_my_data'));

    expect(calls.some((call) => call.method === 'sendDocument')).toBe(true);
  });

  it('человеку, который только что написал впервые, тоже отдаёт файл', async () => {
    // Профиль появляется раньше команды: §9.1 ТЗ требует сохранять
    // входящее до любой другой работы, поэтому выгружать всегда есть что.
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate('/export_my_data'));

    expect(calls.some((call) => call.method === 'sendDocument')).toBe(true);
  });

  it('без профиля честно отвечает, что выгружать нечего', async () => {
    // Через бот такого не случится, но обработчик не должен молча
    // проглатывать команду, если профиля почему-то нет.
    const { bot, calls } = createTestBot({ withIncoming: false });

    await bot.handleUpdate(textUpdate('/export_my_data'));

    const reply = calls.find((call) => call.method === 'sendMessage');
    expect(String(reply?.payload['text'])).toContain('нечего');
    expect(calls.some((call) => call.method === 'sendDocument')).toBe(false);
  });
});

describe('/delete_my_data', () => {
  it('первый шаг только предупреждает и ничего не удаляет', async () => {
    // Кнопка живёт в меню рядом с обычными, а операция необратима.
    await seedUser();
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate('/delete_my_data'));

    expect(calls.some((call) => call.method === 'sendMessage')).toBe(true);

    const rows = await rowsFor(TG_ID);
    expect(rows.users).toBe(1);
    expect(rows.messages).toBeGreaterThan(0);
    expect(rows.batches).toBeGreaterThan(0);
  });

  it('второй шаг предупреждает ещё раз и по-прежнему ничего не удаляет', async () => {
    await seedUser();
    const { bot } = createTestBot();

    await bot.handleUpdate(callbackUpdate(DELETE_STEP_ONE));

    const rows = await rowsFor(TG_ID);
    expect(rows.users).toBe(1);
    expect(rows.messages).toBeGreaterThan(0);
  });

  it('отмена оставляет всё на месте', async () => {
    await seedUser();
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(callbackUpdate(DELETE_CANCEL));

    const edit = calls.find((call) => call.method === 'editMessageText');
    expect(String(edit?.payload['text'])).toContain('Отменила');

    const rows = await rowsFor(TG_ID);
    expect(rows.users).toBe(1);
    expect(rows.messages).toBeGreaterThan(0);
    expect(rows.batches).toBeGreaterThan(0);
  });

  it('подтверждение удаляет всё до последней строки', async () => {
    // §16 ТЗ: после удаления в базе не должно остаться ни одной строки
    // по этому идентификатору.
    await seedUser();
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(callbackUpdate(DELETE_STEP_TWO));

    const edit = calls.find((call) => call.method === 'editMessageText');
    expect(String(edit?.payload['text'])).toContain('удалено');
    expect(await rowsFor(TG_ID)).toEqual({ users: 0, messages: 0, batches: 0 });
  });

  it('удалять нечего — так и говорит, а не молчит', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(callbackUpdate(DELETE_STEP_TWO));

    const edit = calls.find((call) => call.method === 'editMessageText');
    expect(String(edit?.payload['text'])).toContain('нечего');
  });
});

describe('после удаления бот начинает с нуля', () => {
  it('следующее сообщение заводит нового человека с новым согласием', async () => {
    await seedUser();
    const { bot } = createTestBot();

    await bot.handleUpdate(callbackUpdate(DELETE_STEP_TWO));
    expect(await rowsFor(TG_ID)).toEqual({ users: 0, messages: 0, batches: 0 });

    // Человек вернулся и написал снова.
    await bot.handleUpdate(textUpdate('снова здравствуйте'));

    const [restored] = await testDb().select().from(users).where(eq(users.tgId, TG_ID));
    expect(restored).toBeDefined();
    // Согласие получено заново, а не досталось в наследство от прошлой жизни.
    expect(restored?.consentAt).not.toBeNull();
    expect(await rowsFor(TG_ID)).toMatchObject({ users: 1, messages: 1 });
    // Записи прошлой жизни не вернулись.
    expect((await rowsFor(TG_ID)).batches).toBe(1);
  });
});

describe('команды не попадают в выгрузку', () => {
  it('команда не открывает выгрузку и не получает «Слушаю»', async () => {
    // В чате это выглядело так: на /delete_my_data бот отвечал «Слушаю.»,
    // а потом зачитывал эту команду обратно как расшифровку.
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate('/export_my_data'));

    const dumps = await testDb().select().from(batches);
    expect(dumps).toHaveLength(0);
    expect(calls.map((call) => call.payload['text'])).not.toContain('Слушаю.');
  });

  it('команда не считается согласием на обработку', async () => {
    // §16 ТЗ: согласие — это первое сообщение после экрана с политикой,
    // а не нажатие кнопки меню.
    const { bot } = createTestBot();

    await bot.handleUpdate(textUpdate('/start'));

    const [user] = await testDb().select().from(users).where(eq(users.tgId, TG_ID));
    expect(user?.consentAt).toBeNull();
  });

  it('обычное сообщение после команды работает как обычно', async () => {
    const { bot } = createTestBot();

    await bot.handleUpdate(textUpdate('/start'));
    await bot.handleUpdate(textUpdate('надо записаться к врачу'));

    const dumps = await testDb().select().from(batches);
    expect(dumps).toHaveLength(1);

    const [user] = await testDb().select().from(users).where(eq(users.tgId, TG_ID));
    expect(user?.consentAt).not.toBeNull();
  });

  it('мысль, начатая со слэша, остаётся мыслью', async () => {
    // Признак команды берётся из разметки Telegram, а не из первого
    // символа: человек может начать фразу со слэша.
    const { bot } = createTestBot();

    await bot.handleUpdate(textUpdate('/ надо бы разобраться с этим'));

    expect(await testDb().select().from(batches)).toHaveLength(1);
  });
});
