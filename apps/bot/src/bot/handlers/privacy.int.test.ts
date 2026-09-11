import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, messagesRaw, topics, users } from '../../db/schema.js';
import type { PipelineJob } from '../../infra/queue.js';
import { createLogger } from '../../infra/logger.js';
import { FakeTopicGateway } from '../../modules/topics/fake-gateway.js';
import type { PaymentProvider } from '../../modules/billing/provider.js';
import { billingSubscriptions } from '../../db/schema.js';
import { defaultTexts } from '../../texts/index.js';
import { createInvoice, nextInvId } from '../../modules/billing/billing.repo.js';
import { applyPaymentEvent } from '../../modules/billing/subscription.service.js';
import { findByTgId } from '../../modules/users/users.repo.js';
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

function createTestBot(
  options: {
    withIncoming?: boolean;
    gateway?: FakeTopicGateway;
    /** Провайдеры оплаты: отмена продления идёт до удаления (§16, §14). */
    providers?: Partial<Record<'telegram:stars' | 'robokassa:smz', PaymentProvider>>;
  } = {},
): {
  bot: Bot;
  calls: ApiCall[];
  gateway: FakeTopicGateway;
} {
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
  registerStartHandlers(bot, { db: testDb(), logger, privacyPolicyUrl: POLICY_URL });

  const gateway = options.gateway ?? new FakeTopicGateway();
  registerPrivacyHandlers(bot, {
    db: testDb(),
    logger,
    topics: gateway,
    ...(options.providers === undefined ? {} : { providers: options.providers }),
  });

  return { bot, calls, gateway };
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

  it('ветки тем удаляются вместе с данными', async () => {
    /**
     * **Раньше удаление чата не касалось.** База чистилась начисто, а в
     * Telegram оставались ветки тем, и в каждой — закреплённая сводка со
     * списком дел. Человек нажимал «удалить мои данные» и продолжал
     * видеть свои дела. Найдено ручной проверкой 29.08.2026.
     *
     * И вторая половина беды: следующее сообщение запускает онбординг
     * заново, темы создаются с нуля, ветки тоже — в чате оказывается по
     * две «семьи». Сценарий приёмки №13 обещает «бот начинает диалог с
     * нуля», а получалось наоборот.
     */
    const userId = await seedUser();
    await testDb()
      .insert(topics)
      .values([
        { userId, name: 'семья', sortOrder: 0, tgThreadId: 101 },
        { userId, name: 'здоровье', sortOrder: 1, tgThreadId: 102 },
        // Тема без ветки: удалять нечего, и падать не на чем.
        { userId, name: 'личное', sortOrder: 2, isDefault: true },
      ]);

    const { bot, gateway } = createTestBot();
    await bot.handleUpdate(callbackUpdate(DELETE_STEP_TWO));

    expect(gateway.deletedThreads.map((one) => one.threadId).sort()).toEqual([101, 102]);
    expect(gateway.deletedThreads.every((one) => one.chatId === TG_ID)).toBe(true);
  });

  it('отказ Telegram по ветке не отменяет удаление данных', async () => {
    // §16 важнее опрятности чата: человек, попросивший себя стереть,
    // обязан быть стёртым, даже если ветку до этого снесли руками или у
    // бота нет прав её удалить.
    const userId = await seedUser();
    await testDb().insert(topics).values({ userId, name: 'семья', sortOrder: 0, tgThreadId: 101 });

    const gateway = new FakeTopicGateway({ goneThreads: new Set([101]) });
    const { bot, calls } = createTestBot({ gateway });

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

describe('удаление и подписка (§16 и §14, ревизия четвёртого этапа)', () => {
  /**
   * **«Готово. Всё удалено.» при продолжающихся списаниях — самая
   * дорогая неправда, какую может сказать этот бот.** Ключ отмены
   * звёздной подписки уходит каскадом вместе с человеком, и прежде бот
   * отвечал так же, как при полном успехе: человек узнавал о списаниях
   * из своего счёта.
   */

  function provider(fails: boolean): PaymentProvider {
    return {
      name: 'telegram:stars',
      createCheckout: () => Promise.reject(new Error('не нужно')),
      readEvent: () => Promise.resolve(undefined),
      stopRenewal: () => (fails ? Promise.reject(new Error('Telegram молчит')) : Promise.resolve()),
      statusOf: () => Promise.resolve(undefined),
    };
  }

  async function liveStars(userId: string): Promise<void> {
    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'telegram:stars',
        userId,
        plan: 'monthly',
        autoRenew: true,
        subscriptionRef: 'charge-первый',
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 3_600_000),
      });
  }

  it('подписка отменена — бот говорит «всё удалено»', async () => {
    const { bot, calls } = createTestBot({ providers: { 'telegram:stars': provider(false) } });
    await bot.init();

    const person = await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' });
    await liveStars(person.id);

    await bot.handleUpdate(callbackUpdate(DELETE_STEP_ONE));
    await bot.handleUpdate(callbackUpdate(DELETE_STEP_TWO));

    const said = calls
      .filter((call) => call.method === 'editMessageText')
      .map((call) => String(call.payload['text']));

    expect(said.at(-1)).toBe(defaultTexts.privacy.deleteDone);
  });

  it('подписку отменить не удалось — бот говорит, где отменить самому', async () => {
    /**
     * Право на удаление при этом исполнено: §16 заложником чужого сбоя
     * быть не может. Но и молчать нельзя — списания продолжатся.
     */
    const { bot, calls } = createTestBot({ providers: { 'telegram:stars': provider(true) } });
    await bot.init();

    const person = await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' });
    await liveStars(person.id);

    await bot.handleUpdate(callbackUpdate(DELETE_STEP_ONE));
    await bot.handleUpdate(callbackUpdate(DELETE_STEP_TWO));

    const said = calls
      .filter((call) => call.method === 'editMessageText')
      .map((call) => String(call.payload['text']));

    expect(said.at(-1)).toBe(defaultTexts.privacy.deleteDoneSubscriptionLeft);
    expect(said.at(-1)).toContain('Подписки');

    // И данные всё равно удалены: право исполнено.
    expect(await findByTgId(testDb(), TG_ID)).toBeUndefined();
  });

  it('робокассному подписчику не рассказывают про звёзды', async () => {
    /**
     * Дефект №20 ревизии. У Робокассы ключа отмены нет и не бывает:
     * дочернее списание уходит от нас по строке подписки, и после
     * удаления списывать нечем. Прежде пустой ключ считался отказом, и
     * человек с рублёвой подпиской читал «подписку за звёзды отменяет
     * Telegram… иначе списания продолжатся» — обе половины ложь.
     *
     * Подписка — настоящим путём (счёт и событие оплаты), а рядом —
     * живые звёзды с ответившим провайдером: удаление у человека с двумя
     * рельсами должно закончиться одним «Готово».
     */
    const { bot, calls } = createTestBot({
      providers: {
        'telegram:stars': provider(false),
        'robokassa:smz': { ...provider(false), name: 'robokassa:smz' },
      },
    });
    await bot.init();

    const person = await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' });
    await liveStars(person.id);

    await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId: person.id,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 39_900,
      currency: 'RUB',
      ref: 'рк-удаление',
      invId: await nextInvId(testDb()),
      autoRenew: true,
    });
    await applyPaymentEvent(testDb(), {
      provider: 'robokassa:smz',
      event: {
        kind: 'paid',
        externalId: '9103',
        ref: 'рк-удаление',
        amount: 39_900,
        currency: 'RUB',
        renewal: false,
      },
    });

    await bot.handleUpdate(callbackUpdate(DELETE_STEP_ONE));
    await bot.handleUpdate(callbackUpdate(DELETE_STEP_TWO));

    const said = calls
      .filter((call) => call.method === 'editMessageText')
      .map((call) => String(call.payload['text']));

    expect(said.at(-1)).toBe(defaultTexts.privacy.deleteDone);
    expect(said.at(-1)).not.toContain('звёзд');
    expect(await findByTgId(testDb(), TG_ID)).toBeUndefined();
  });
});
