import { readFile } from 'node:fs/promises';

import type { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  batches,
  billingSubscriptions,
  items,
  messagesRaw,
  pendingQuestions,
  users,
} from '../../db/schema.js';
import { askQuestion } from '../../modules/resolver/questions.repo.js';
import { CLARIFY_REASON, CLARIFY_TIME_WAITING } from '../../modules/resolver/clarify.js';
import { BILLING_ACTION, registerBillingHandlers, registerPaySupportCommands } from './billing.js';
import type { Rail } from '../../modules/billing/tariffs.js';
import { createLogger } from '../../infra/logger.js';
import type { Context } from 'grammy';
import type { StatusSender } from '../../modules/presenter/status.service.js';
import { SettingsRegistry, putSetting } from '../../modules/settings/settings.repo.js';
import type { PipelineJob } from '../../infra/queue.js';
import { DEFAULT_LIMITS, closeBatchOnSilence } from '../../modules/buffer/buffer.service.js';
import { confirmConsent, upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { incomingMiddleware } from './incoming.js';

/**
 * Потолок выгрузок за сутки через настоящий обработчик (задача 1.12).
 *
 * Условие готовности задачи звучит так: «31-я выгрузка за сутки **вежливо**
 * отклоняется». Проверено было только слово «отклоняется» — тесты на
 * `isOverDumpLimit` считают выгрузки и возвращают да/нет. А «вежливо» —
 * то есть человек получает ответ, а не тишину, и его сообщение при этом
 * не пропадает — не проверял никто.
 *
 * Разрыв ровно того же вида, на котором уже попадалось статусное
 * сообщение: модуль есть, тест на модуль зелёный, а в боте связка не
 * работает.
 */

const TG_ID = 7373;
const POLICY_URL = 'https://vydoh-app.ru/privacy';
const CONSENT_URL = 'https://vydoh-app.ru/consent';

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

/**
 * Записывающий статусный отправитель.
 *
 * Нужен там, где проверяется **отсутствие** реплики: без него приём
 * молчит всегда (`deps.sender` не задан, incoming.ts:179), и проверка
 * «бот ничего не ответил» проходила бы и на сломанном коде. Именно так
 * и случилось при первом заходе — диверсия её не свалила.
 */
function recordingStatus(): { sender: StatusSender; said: string[]; deleted: number[] } {
  const said: string[] = [];
  const deleted: number[] = [];

  return {
    said,
    deleted,
    sender: {
      send: ({ text }) => {
        said.push(text);
        return Promise.resolve(said.length);
      },
      edit: ({ text }) => {
        said.push(text);
        return Promise.resolve('edited' as const);
      },
      delete: ({ messageId }) => {
        deleted.push(messageId);
        return Promise.resolve(true);
      },
    },
  };
}

interface BotOptions {
  readonly sender?: StatusSender | undefined;
  /** Реестр значений: без него гейт пробного периода не работает (4.3). */
  readonly settings?: SettingsRegistry | undefined;
  /** Приём ответа словами — он стоит выше гейта (задача 3.61). */
  readonly consume?: ((ctx: Context, userId: string) => Promise<boolean>) | undefined;
  /**
   * Включённые рельсы оплаты (задача 4.2).
   *
   * Без них конец пробного периода не приглашает платить — и это
   * правильно: приглашение без единого тарифа отправляет человека искать
   * кнопку, которой нет. Проверки ниже мерят **обе** стороны этого «и».
   */
  readonly payRails?: readonly Rail[] | undefined;
  /** Часы: приветствие зависит от времени суток (29.09.2026). */
  readonly now?: (() => Date) | undefined;
}

function createTestBot(options: BotOptions = {}): { bot: Bot; calls: ApiCall[] } {
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

    return Promise.resolve({
      ok: true,
      result: { message_id: calls.length, date: 0, chat: { id: TG_ID, type: 'private' } },
    } as never);
  });

  bot.use(
    incomingMiddleware({
      db: testDb(),
      queue: stubQueue,
      privacyPolicyUrl: POLICY_URL,
      consentUrl: CONSENT_URL,
      ...(options.sender === undefined ? {} : { sender: options.sender }),
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.consume === undefined ? {} : { consume: options.consume }),
      ...(options.payRails === undefined ? {} : { payRails: options.payRails }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );

  return { bot, calls };
}

function textUpdate(text: string): Update {
  seq++;

  return {
    update_id: 700_000 + seq,
    message: {
      message_id: seq,
      date: Math.floor(Date.UTC(2026, 7, 27) / 1000),
      chat: { id: TG_ID, type: 'private', first_name: 'Аня' },
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      text,
    },
  } as unknown as Update;
}

/**
 * Команда — то же сообщение, но с разметкой сущности.
 *
 * Без `entities` grammY считает это обычным текстом, и проверка «команды
 * потолок пропускает» проверяла бы не то.
 */
function commandUpdate(command: string): Update {
  const update = textUpdate(command) as Update & {
    message: { entities?: unknown[] };
  };

  update.message.entities = [{ type: 'bot_command', offset: 0, length: command.length }];

  return update;
}

/**
 * Нажатие кнопки. Через приём сообщений оно не идёт — но проверить это
 * надо на настоящем апдейте, а не на предположении: гейт стоит в общем
 * мидлваре, через который проходит любой апдейт.
 */
function callbackUpdate(data: string): Update {
  seq++;

  return {
    update_id: 700_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      chat_instance: 'test',
      data,
      message: { message_id: seq, date: 0, chat: { id: TG_ID, type: 'private' } },
    },
  } as unknown as Update;
}

/** Уже состоявшиеся выгрузки этих суток. */
async function seedDumps(count: number): Promise<void> {
  if (count === 0) return;

  await testDb()
    .insert(batches)
    .values(
      Array.from({ length: count }, () => ({
        userId,
        status: 'done' as const,
        closedAt: new Date(),
        processedAt: new Date(),
      })),
    );
}

async function dumpCount(): Promise<number> {
  const rows = await testDb()
    .select({ id: batches.id })
    .from(batches)
    .where(eq(batches.userId, userId));
  return rows.length;
}

beforeEach(async () => {
  seq = 0;
  const user = await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' });
  userId = user.id;
  // Согласие нажато: без него ни одна выгрузка не разбирается (§16,
  // решение заказчицы 12.09.2026) — а здесь проверяется путь после него.
  await confirmConsent(testDb(), userId, { edition: '2026-10-01' });
});

describe('согласие кнопкой «Согласна» (§16, решение заказчицы 12.09.2026)', () => {
  async function withoutConsent(): Promise<void> {
    await testDb()
      .update(users)
      .set({ consentConfirmedAt: null, consentEdition: null, consentAt: null })
      .where(eq(users.id, userId));
  }

  it('до нажатия сообщение сохраняется, но выгрузка не заводится, и человеку это сказано с кнопкой', async () => {
    /**
     * Раньше согласием считалось первое сообщение. Теперь — только
     * кнопка: слова до неё сохраняются (§16 — ничего не теряется), а
     * разбор ждёт нажатия. Реплика ведёт к политике и даёт кнопку.
     */
    await withoutConsent();
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate('записать сына к врачу'));

    expect(await dumpCount()).toBe(0);

    const saved = await testDb().select().from(messagesRaw).where(eq(messagesRaw.userId, userId));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.batchId).toBeNull();

    const replies = calls.filter((call) => call.method === 'sendMessage');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload['text']).toBe(
      defaultTexts.consent.required(POLICY_URL, CONSENT_URL),
    );
    expect(replies[0]?.payload['text']).toContain(`](${CONSENT_URL})`);

    const markup = replies[0]?.payload['reply_markup'] as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(markup.inline_keyboard.flat().map((one) => [one.text, one.callback_data])).toEqual([
      [defaultTexts.consent.button, 'consent:accept'],
    ]);

    // Согласием сообщение больше не считается.
    const [row] = await testDb().select().from(users).where(eq(users.id, userId));
    expect(row?.consentAt).toBeNull();
  });

  it('команды до согласия проходят: записи на чтение открыты', async () => {
    await withoutConsent();
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(commandUpdate('/menu'));

    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(0);
  });

  it('после нажатия та же мысль становится выгрузкой', async () => {
    const { bot } = createTestBot();

    await bot.handleUpdate(textUpdate('записать сына к врачу'));

    expect(await dumpCount()).toBe(1);
  });
});

describe('потолок выгрузок за сутки', () => {
  it('31-я выгрузка отклоняется, и человеку это сказано словами', async () => {
    await seedDumps(30);

    const { bot, calls } = createTestBot();
    await bot.handleUpdate(textUpdate('купить продукты'));

    const replies = calls.filter((call) => call.method === 'sendMessage');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload['text']).toBe(defaultTexts.limits.tooManyDumps);
  });

  it('отклонённое сообщение не теряется: сначала сохраняем, потом думаем', async () => {
    // §9.1 ТЗ. Потолок — причина не заводить разбор, а не причина
    // выбросить слова человека.
    await seedDumps(30);

    const { bot } = createTestBot();
    await bot.handleUpdate(textUpdate('записать сына к врачу'));

    const saved = await testDb().select().from(messagesRaw).where(eq(messagesRaw.userId, userId));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.text).toBe('записать сына к врачу');
    // И помечено, почему без выгрузки: иначе через час это «сирота» в
    // журнале, каждую минуту, — как было с ответами на опрос.
    expect(saved[0]?.refusedReason).toBe('dumpLimit');
  });

  it('новая выгрузка при этом не заводится', async () => {
    await seedDumps(30);

    const { bot } = createTestBot();
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(30);
  });

  it('команды потолок пропускает — путь к записям не закрыт', async () => {
    /**
     * Реплика о потолке говорит человеку: «посмотреть можно через
     * /menu». Если бы потолок глушил и команды, эта фраза была бы
     * ложью, а человек — заперт от собственных записей до утра.
     *
     * Найдено живым прогоном 03.09.2026: на вопрос «что у меня на
     * сегодня?» бот ответил про потолок. Вопрос действительно упирается
     * в потолок — проверка стоит до разбора, — но записи при этом
     * доступны, и реплика обязана на них указать.
     */
    await seedDumps(30);

    const { bot, calls } = createTestBot();
    await bot.handleUpdate(commandUpdate('/menu'));

    const refusals = calls.filter(
      (call) => call.payload['text'] === defaultTexts.limits.tooManyDumps,
    );
    expect(refusals).toHaveLength(0);
  });

  it('реплика о потолке называет путь к записям', () => {
    // Иначе она тупик: человек не знает, что его дела на месте и видны.
    expect(defaultTexts.limits.tooManyDumps).toContain('/menu');
  });

  it('тридцатая ещё принимается: граница там, где написано', async () => {
    // Проверка самой границы, а не только того, что она где-то есть.
    // Ошибка на единицу здесь означала бы отказ человеку, у которого
    // право ещё было.
    await seedDumps(29);

    const { bot, calls } = createTestBot();
    await bot.handleUpdate(textUpdate('купить продукты'));

    const refusals = calls.filter(
      (call) => call.payload['text'] === defaultTexts.limits.tooManyDumps,
    );
    expect(refusals).toHaveLength(0);
    expect(await dumpCount()).toBe(30);
  });

  /**
   * Потолок — про число **выгрузок**, а не сообщений внутри одной.
   *
   * Ревизия этапов 1–2: при 29 выгрузках за сутки первое голосовое
   * открывало тридцатую, а второе упиралось в потолок — счёт уже
   * включал только что открытую — и оставалось без выгрузки навсегда.
   * Серия из трёх голосовых разбиралась по первому; человек читал «всё
   * сохранено, посмотри через /menu», а в /menu хвоста не было. Это
   * против §9.1 правила 2: серия сообщений — одна мысль, и §10.5
   * ограничивает частоту выгрузок, а не длину начатой.
   */
  it('тридцатая выгрузка принимает всю серию, а не только первое сообщение', async () => {
    await seedDumps(29);

    const { bot, calls } = createTestBot();
    await bot.handleUpdate(textUpdate('записать сына к врачу'));
    await bot.handleUpdate(textUpdate('и купить продукты'));
    await bot.handleUpdate(textUpdate('а ещё позвонить маме'));

    const refusals = calls.filter(
      (call) => call.payload['text'] === defaultTexts.limits.tooManyDumps,
    );
    expect(refusals).toHaveLength(0);

    const saved = await testDb()
      .select({ batchId: messagesRaw.batchId })
      .from(messagesRaw)
      .where(eq(messagesRaw.userId, userId));
    expect(saved).toHaveLength(3);
    // Все три — в одной выгрузке, и ни одно не осталось без неё.
    const batchIds = new Set(saved.map((row) => row.batchId));
    expect(batchIds.size).toBe(1);
    expect(batchIds.has(null)).toBe(false);

    const [open] = await testDb()
      .select({ messageCount: batches.messageCount })
      .from(batches)
      .where(and(eq(batches.userId, userId), eq(batches.status, 'open')));
    expect(open?.messageCount).toBe(3);
    expect(await dumpCount()).toBe(30);
  });

  it('но когда тридцатая закрылась, следующая мысль упирается в потолок', async () => {
    // Обратная сторона: послабление касается продолжения начатой
    // выгрузки, а не новой. Закрытие — настоящее, по тишине.
    await seedDumps(29);

    const { bot, calls } = createTestBot();
    await bot.handleUpdate(textUpdate('записать сына к врачу'));

    const [open] = await testDb()
      .select({ id: batches.id })
      .from(batches)
      .where(and(eq(batches.userId, userId), eq(batches.status, 'open')));
    if (open === undefined) throw new Error('тридцатая выгрузка не открылась');
    const closed = await closeBatchOnSilence(testDb(), open.id, {
      now: new Date(Date.now() + DEFAULT_LIMITS.silenceWindowMs + 1_000),
    });
    expect(closed.closed).toBe(true);

    await bot.handleUpdate(textUpdate('и купить продукты'));

    const refusals = calls.filter(
      (call) => call.payload['text'] === defaultTexts.limits.tooManyDumps,
    );
    expect(refusals).toHaveLength(1);
    expect(await dumpCount()).toBe(30);
  });
});

/**
 * Служебное сообщение об оплате: обычный `message` без текста, только с
 * полем `successful_payment`. Ровно то, что Telegram пришлёт после
 * платежа.
 */
function paymentUpdate(): Update {
  const update = textUpdate('') as Update & {
    message: { text?: string | undefined; successful_payment?: unknown };
  };

  delete update.message.text;
  update.message.successful_payment = {
    currency: 'XTR',
    total_amount: 1,
    invoice_payload: 'подписка:месяц',
    telegram_payment_charge_id: 'charge-1',
    provider_payment_charge_id: '',
  };

  return update;
}

describe('служебное сообщение об оплате не становится выгрузкой (задача 4.1)', () => {
  /**
   * **Тихий дефект, который сработал бы в первый же день оплаты.**
   * У служебного сообщения нет ни текста, ни подписи, поэтому приём
   * относит его к `kind: 'other'` и прицепляет к выгрузке как всякое
   * сообщение. Говорить в такой выгрузке нечего — и человек, только
   * что заплативший, получает «Я тебя не слышу» вместо доступа.
   *
   * Модель здесь не нужна: всё решается до буфера.
   */
  it('выгрузка по нему не открывается', async () => {
    const { bot } = createTestBot();

    await bot.handleUpdate(paymentUpdate());

    expect(await dumpCount()).toBe(0);
  });

  it('но сохранено оно всё равно — §9.1 «сначала сохраняем»', async () => {
    const { bot } = createTestBot();

    await bot.handleUpdate(paymentUpdate());

    const saved = await testDb().select().from(messagesRaw).where(eq(messagesRaw.userId, userId));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.batchId).toBeNull();
  });

  it('и «Слушаю» под ним не появляется', async () => {
    /**
     * «Слушаю» под служебным сообщением — тот же обман, что «я тебя не
     * слышу»: человек не говорил, отвечать нечего.
     *
     * Со **своим** отправителем, а не с общим харнесом: без него приём
     * молчит всегда, и первая версия этой проверки прошла под
     * диверсией — то есть не мерила ничего.
     */
    const { sender, said } = recordingStatus();
    const { bot } = createTestBot({ sender });

    await bot.handleUpdate(paymentUpdate());
    expect(said).toEqual([]);

    // А на словах человека «Слушаю» быть обязано: иначе проверка
    // прошла бы и на боте, который молчит всегда.
    await bot.handleUpdate(textUpdate('купить продукты'));
    expect(said).toHaveLength(1);
  });

  it('серия из трёх сообщений: «Слушаю» переезжает под каждое новое, в чате оно одно (Никита, 17.09.2026)', async () => {
    const { sender, said, deleted } = recordingStatus();
    const { bot } = createTestBot({ sender });

    await bot.handleUpdate(textUpdate('Надо отдать пальто в химчистку.'));
    await bot.handleUpdate(textUpdate('И записаться к парикмахеру.'));
    await bot.handleUpdate(textUpdate('И купить батарейки.'));

    // Три отправки, два удаления: в чате в каждый момент одно «Слушаю»,
    // и оно под последним сообщением — итог разбора ляжет туда же.
    expect(said).toEqual([
      defaultTexts.listening.acknowledged,
      defaultTexts.listening.acknowledged,
      defaultTexts.listening.acknowledged,
    ]);
    expect(deleted).toEqual([1, 2]);

    const [open] = await testDb()
      .select({ statusMessageId: batches.statusMessageId })
      .from(batches)
      .where(and(eq(batches.userId, userId), eq(batches.status, 'open')));
    expect(open?.statusMessageId).toBe(3);
  });

  it('обычное сообщение по-прежнему становится выгрузкой', async () => {
    // Обратная сторона: проверка не должна отсечь слова человека.
    const { bot } = createTestBot();

    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(1);
  });
});

/** Выгрузки, потратившие пробный период. */
async function seedTrialSpent(count: number): Promise<void> {
  if (count === 0) return;

  await testDb()
    .insert(batches)
    .values(
      Array.from({ length: count }, () => ({
        userId,
        status: 'done' as const,
        closedAt: new Date(),
        processedAt: new Date(),
        trialCountedAt: new Date(),
      })),
    );
}

/** Реестр значений с заданным размером пробного периода. */
async function trialOf(limit: number): Promise<SettingsRegistry> {
  await putSetting(testDb(), { name: 'trialDumps', value: String(limit) });

  return new SettingsRegistry({ db: testDb(), ttlMs: 0 });
}

describe('пробный период и деградация (§14, задача 4.3)', () => {
  /**
   * §14 ТЗ: «Пробный период ограничен количеством выгрузок, а не днями.
   * После окончания доступа бэклог остаётся доступен на чтение, новые
   * выгрузки блокируются. Данные не удаляются.»
   *
   * Проверяется каждая из трёх частей — и обратная сторона каждой:
   * блокировка не должна запирать чтение, а слова человека не должны
   * теряться на границе.
   */

  it('пока пробный период есть — выгрузка заводится', async () => {
    await seedTrialSpent(2);
    const settings = await trialOf(10);

    const { bot } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(3);
  });

  it('граница там, где написано: последняя бесплатная проходит', async () => {
    /**
     * Ошибка на единицу здесь означала бы отказ человеку, у которого
     * право ещё было, — и наоборот, лишний бесплатный разбор за наши
     * деньги. Поэтому проверяется сама граница, а не «где-то рядом».
     */
    await seedTrialSpent(2);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(3);
    expect(calls.map((call) => call.payload['text'])).not.toContain(defaultTexts.limits.trialOver);
  });

  it('следующая за границей — блокируется', async () => {
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    // Новой выгрузки нет: посеянные три остались тремя.
    expect(await dumpCount()).toBe(3);
    expect(calls.map((call) => call.payload['text'])).toContain(defaultTexts.limits.trialOver);
  });

  it('и слова человека при этом сохранены — §9.1 и §14 «данные не удаляются»', async () => {
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    const { bot } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    const saved = await testDb().select().from(messagesRaw).where(eq(messagesRaw.userId, userId));

    expect(saved).toHaveLength(1);
    expect(saved[0]?.text).toBe('купить продукты');
    // Сохранено, но к выгрузке не привязано: разбор по нему не заводим.
    expect(saved[0]?.batchId).toBeNull();
    // Причина записана — счётчику сирот и панели.
    expect(saved[0]?.refusedReason).toBe('trial');
  });

  it('реплика про пробный период, а не «приходи завтра»', async () => {
    /**
     * Человеку, у которого кончился пробный период, «на сегодня
     * достаточно, разберу завтра» говорит неправду: завтра ничего не
     * изменится. Поэтому гейт стоит раньше ограничения частоты.
     */
    await seedTrialSpent(3);
    await seedDumps(30);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    const said = calls.map((call) => call.payload['text']);

    expect(said).toContain(defaultTexts.limits.trialOver);
    expect(said).not.toContain(defaultTexts.limits.tooManyDumps);
  });

  /**
   * Реплика на границе — четыре проверки, названные ревизией этапа.
   *
   * До ревизии здесь мерилась одна реплика из четырёх: `limits.trialOver`
   * («пробные разборы закончились»). Три остальные — приглашение к
   * тарифу, «оплаченный период кончился» и «продление не прошло» —
   * появились с задачей 4.2 и остались без единой проверки, хотя
   * различить их важнее всего именно платившему: он читал «пробные
   * разборы закончились» и решал, что бот забыл его оплату.
   *
   * Обстановка у всех четырёх одна: пробный исчерпан. Разница — в том,
   * что есть **кроме** него: тариф и история подписок.
   */
  describe('какими словами гейт отказывает (§14, задача 4.2; ревизия этапа)', () => {
    /** Тариф за рубли на рельсе Робокассы: приглашению нужны оба. */
    async function withPrice(limit: number): Promise<SettingsRegistry> {
      await putSetting(testDb(), { name: 'trialDumps', value: String(limit) });
      await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });

      return new SettingsRegistry({ db: testDb(), ttlMs: 0 });
    }

    /** Строка подписки, срок которой уже вышел. */
    async function seedPastSubscription(status: 'canceled' | 'past_due'): Promise<void> {
      await testDb()
        .insert(billingSubscriptions)
        .values({
          provider: 'robokassa',
          userId,
          plan: 'monthly',
          status,
          currentPeriodEnd: new Date(Date.now() - 24 * 3_600_000),
        });
    }

    /** Что уехало человеку: текст и кнопки под ним. */
    function replyOf(calls: readonly ApiCall[]): {
      readonly text: unknown;
      readonly buttons: string;
    } {
      const reply = calls.find((call) => call.method === 'sendMessage');

      return {
        text: reply?.payload['text'],
        buttons: JSON.stringify(reply?.payload['reply_markup'] ?? {}),
      };
    }

    it('пробный кончился, а тариф есть — приглашение с кнопкой подписки', async () => {
      await seedTrialSpent(3);
      const settings = await withPrice(3);

      const { bot, calls } = createTestBot({ settings, payRails: ['robokassa:smz'] });
      await bot.handleUpdate(textUpdate('купить продукты'));

      const said = replyOf(calls);

      expect(said.text).toBe(defaultTexts.billing.trialOverWithOffer);
      expect(said.buttons).toContain(BILLING_ACTION.open);
      expect(said.buttons).toContain(defaultTexts.menu.buttonSubscription);

      // И выгрузка при этом всё равно не заводится: приглашение платить
      // не значит «пропустим разок».
      expect(await dumpCount()).toBe(3);
    });

    it('рельс включён, а цена не задана — приглашения нет вовсе', async () => {
      /**
       * Обратная сторона того же «и»: рельс без цены продавать нечем.
       * «Выберите тариф» здесь было бы обещанием без товара — ровно то
       * состояние, в котором бот и живёт до назначения цен в панели.
       */
      await seedTrialSpent(3);
      const settings = await trialOf(3);

      const { bot, calls } = createTestBot({ settings, payRails: ['robokassa:smz'] });
      await bot.handleUpdate(textUpdate('купить продукты'));

      const said = replyOf(calls);

      expect(said.text).toBe(defaultTexts.limits.trialOver);
      expect(said.buttons).not.toContain(BILLING_ACTION.open);
    });

    it('кончился оплаченный период — реплика про оплату, а не про пробный', async () => {
      /**
       * Платившему «пробные разборы закончились» читается как «бот забыл
       * мою оплату». Причина берётся из истории подписок, а не
       * угадывается: строка остаётся и после конца периода.
       */
      await seedTrialSpent(3);
      await seedPastSubscription('canceled');
      const settings = await withPrice(3);

      const { bot, calls } = createTestBot({ settings, payRails: ['robokassa:smz'] });
      await bot.handleUpdate(textUpdate('купить продукты'));

      const said = replyOf(calls);

      expect(said.text).toBe(defaultTexts.billing.paidOver);
      expect(said.text).not.toBe(defaultTexts.billing.trialOverWithOffer);
      expect(said.buttons).toContain(BILLING_ACTION.open);
    });

    it('продление не прошло — сказано именно это', async () => {
      /**
       * `past_due` отличается от истёкшей подписки тем, что человек
       * продлеваться **хотел**: списание сорвалось. Предложить ему
       * «оплаченный период кончился» значило бы умолчать о том, что
       * чинится с его стороны — картой, а не выбором тарифа.
       */
      await seedTrialSpent(3);
      await seedPastSubscription('past_due');
      const settings = await withPrice(3);

      const { bot, calls } = createTestBot({ settings, payRails: ['robokassa:smz'] });
      await bot.handleUpdate(textUpdate('купить продукты'));

      expect(replyOf(calls).text).toBe(defaultTexts.billing.renewalOver);
    });
  });

  it('ноль в настройке означает «пробного периода нет вовсе»', async () => {
    const settings = await trialOf(0);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(0);
    expect(calls.map((call) => call.payload['text'])).toContain(defaultTexts.limits.trialOver);
  });

  it('без реестра значений поведение прежнее — гейта нет', async () => {
    /**
     * Зависимость необязательна нарочно: так бот жил до этой задачи, и
     * так же он работает в тех тестах, которые про пробный период
     * ничего не проверяют. Молча запирать человека при забытой
     * зависимости было бы худшим из поведений.
     */
    /**
     * Двенадцать, а не сто: умолчание пробного периода — десять, то есть
     * с реестром двенадцатая трата уже заперла бы человека, а суточный
     * потолок §10.5 (тридцать) до этого числа не дотягивается. Первая
     * версия проверки посеяла девяносто девять и упёрлась в суточный
     * потолок — то есть мерила не гейт, а соседа.
     */
    await seedTrialSpent(12);

    const { bot } = createTestBot();
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await dumpCount()).toBe(13);
  });

  it('нажатие кнопки проходит: деградация — это чтение без записи', async () => {
    /**
     * §14 требует, чтобы бэклог остался доступен на чтение. Меню,
     * карточки и откаты живут на нажатиях кнопок, а они через приём
     * сообщений не идут вовсе — но это надо доказать, а не предположить:
     * гейт стоит в общем мидлваре, через который проходит **любой**
     * апдейт.
     */
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(callbackUpdate('i:done:AAAAAAAAAAAAAAAAAAAAAA'));

    // Ни отказа, ни новой выгрузки: апдейт ушёл дальше, к обработчикам.
    expect(calls.map((call) => call.payload['text'])).not.toContain(defaultTexts.limits.trialOver);
    expect(await dumpCount()).toBe(3);
  });

  it('вопрос словами тоже глушится — и реплика называет путь к записям', async () => {
    /**
     * Осознанная цена, а не пропуск. «Что там на сегодня» отличается от
     * новой мысли только намерением, а намерение определяет модель —
     * значит деньги. Платить за того, кто не платит, нельзя.
     *
     * Ровно та же цена принята у потолка §10.5, и решается тем же:
     * реплика называет `/menu`, а команды и кнопки гейт пропускает.
     * Тест держит и цену, и её оправдание — иначе однажды кто-то
     * «починит» это, добавив вызов маршрутизатора без доступа.
     */
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('что там на сегодня'));

    expect(calls.map((call) => call.payload['text'])).toContain(defaultTexts.limits.trialOver);
    // Тупика нет: путь к записям назван прямо в реплике.
    expect(defaultTexts.limits.trialOver).toContain('/menu');
  });

  it('команда проходит: путь к записям остаётся открыт', async () => {
    // Иначе реплика «посмотреть можно через /menu» — обман: сама
    // команда упёрлась бы в тот же гейт.
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(commandUpdate('/menu'));

    expect(calls.map((call) => call.payload['text'])).not.toContain(defaultTexts.limits.trialOver);
  });

  it('ответ словами на вопрос бота проходит', async () => {
    /**
     * Человек, у которого кончился пробный период, всё равно вправе
     * назвать своё имя или время напоминания: `consume` стоит выше
     * гейта. Иначе открытый вопрос бота стал бы тупиком.
     */
    await seedTrialSpent(3);
    const settings = await trialOf(3);

    let consumed = 0;
    const { bot, calls } = createTestBot({
      settings,
      consume: () => {
        consumed++;
        return Promise.resolve(true);
      },
    });

    await bot.handleUpdate(textUpdate('в девять утра'));

    expect(consumed).toBe(1);
    expect(calls.map((call) => call.payload['text'])).not.toContain(defaultTexts.limits.trialOver);
  });

  it('съеденный ответ помечен: сиротой без выгрузки он не станет (найдено на бою 12.09.2026)', async () => {
    const { bot } = createTestBot({ consume: () => Promise.resolve(true) });

    await bot.handleUpdate(textUpdate('в девять утра'));

    const [row] = await testDb()
      .select({ consumedAt: messagesRaw.consumedAt, batchId: messagesRaw.batchId })
      .from(messagesRaw)
      .where(eq(messagesRaw.text, 'в девять утра'));

    expect(row?.batchId).toBeNull();
    expect(row?.consumedAt).not.toBeNull();
  });

  it('несъеденное не помечается', async () => {
    const { bot } = createTestBot({ consume: () => Promise.resolve(false) });

    await bot.handleUpdate(textUpdate('купить хлеб'));

    const [row] = await testDb()
      .select({ consumedAt: messagesRaw.consumedAt })
      .from(messagesRaw)
      .where(eq(messagesRaw.text, 'купить хлеб'));

    expect(row?.consumedAt).toBeNull();
  });
});

describe('настройка применяется на лету — условие готовности 4.9', () => {
  /**
   * §15: числа продукта меняются «без выкладки новой версии». Условие
   * готовности задачи 4.9 названо про окно тишины именно потому, что
   * оно читается на **горячем пути**: если бы его запомнили при подъёме
   * процесса, правка требовала бы перезапуска — то есть выкладки.
   *
   * Проверяется наблюдаемое последствие: задание на закрытие выгрузки
   * ставится с новой задержкой, и **без перезапуска чего бы то ни было**.
   */

  /** Задержки, с которыми ставились задания на закрытие выгрузки. */
  function recordingQueue(): { queue: Queue<PipelineJob>; delays: number[] } {
    const delays: number[] = [];

    return {
      delays,
      queue: {
        getJob: () => Promise.resolve(undefined),
        add: (_name: string, _data: unknown, options?: { delay?: number }) => {
          if (options?.delay !== undefined) delays.push(options.delay);
          return Promise.resolve({});
        },
      } as unknown as Queue<PipelineJob>,
    };
  }

  it('окно тишины из настроек доходит до задания, а не берётся из кода', async () => {
    const settings = new SettingsRegistry({ db: testDb(), ttlMs: 60_000 });
    const { queue, delays } = recordingQueue();

    const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: 'ВЫДОХ',
        username: 'vydoh_test_bot',
      } as unknown as UserFromGetMe,
    });

    bot.api.config.use(() =>
      Promise.resolve({
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
      } as never),
    );

    bot.use(
      incomingMiddleware({
        db: testDb(),
        queue,
        settings,
        privacyPolicyUrl: POLICY_URL,
        consentUrl: CONSENT_URL,
      }),
    );

    // Умолчание из кода: тридцать секунд.
    await bot.handleUpdate(textUpdate('первая мысль'));
    expect(delays.at(-1)).toBe(30_000);

    /**
     * Правка — и **никакого перезапуска**: ни процесса, ни мидлвара, ни
     * бота. Сброс кэша делает панель после записи; здесь он вызван
     * напрямую, потому что панель тут не участвует.
     */
    await putSetting(testDb(), { name: 'silenceWindowMs', value: '5000' });
    settings.forget();

    await bot.handleUpdate(textUpdate('вторая мысль'));

    expect(delays.at(-1)).toBe(5_000);
  });

  it('суточный потолок из настроек тоже действует сразу', async () => {
    await putSetting(testDb(), { name: 'dumpsPerDay', value: '1' });

    const settings = new SettingsRegistry({ db: testDb(), ttlMs: 0 });
    await seedDumps(1);

    const { bot, calls } = createTestBot({ settings });
    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(calls.map((call) => call.payload['text'])).toContain(defaultTexts.limits.tooManyDumps);
  });
});

describe('обращение по /paysupport попадает в базу (ревизия четвёртого этапа)', () => {
  /**
   * **Порядок регистрации стоил обращения человека.** Команды платёжной
   * платформы жили вместе с оплатой, а оплата регистрируется **до**
   * приёма сообщений: служебное сообщение о платеже иначе уехало бы в
   * буфер выгрузки. Из-за этого `/paysupport` отвечал, а сообщения не
   * оставалось — ни в выгрузке, ни в `messages_raw`.
   *
   * Цена: реплика `/paysupport` обещает «напишите сюда же словами,
   * разберёмся и вернём деньги, если списалось лишнее», а обращение,
   * которым человек воспользовался этим приглашением, не сохранялось.
   */
  it('сообщение с командой сохраняется, а ответ уходит', async () => {
    const { bot, calls } = createTestBot();

    registerPaySupportCommands(bot, {
      db: testDb(),
      offerUrl: 'https://vydoh.test/oferta',
      settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
      logger: createLogger({ level: 'silent' }),
      providers: {},
    });

    await bot.init();
    // Через `commandUpdate`: без разметки сущности grammY считает это
    // обычным текстом, и `bot.command` до обработчика не доходит.
    await bot.handleUpdate(commandUpdate('/paysupport'));

    // Ответ ушёл: правила Telegram требуют отвечать.
    const said = calls
      .filter((one) => one.method === 'sendMessage')
      .map((one) => String(one.payload['text']));

    expect(said.join('\n')).toContain('оплат');

    // И само обращение — в базе: инвариант «сначала сохраняем».
    const saved = await testDb().select().from(messagesRaw);

    expect(saved.map((one) => one.text)).toContain('/paysupport');
  });

  it('в сборке бота команды платёжной платформы стоят после приёма', async () => {
    /**
     * **Страж порядка, а не поведения.** Проверка выше подключает приём
     * сама и потому пройдёт при любом порядке в `index.ts` — а дефект
     * был именно там: команды регистрировались внутри оплаты, то есть до
     * приёма. Здесь читается сборка.
     */
    const source = await readFile('src/index.ts', 'utf8');

    const intake = source.indexOf('incomingMiddleware(');
    const commands = source.indexOf('registerPaySupportCommands(');

    expect(intake, 'приём не найден в сборке').toBeGreaterThan(0);
    expect(commands, 'команды платёжной платформы не найдены в сборке').toBeGreaterThan(0);

    expect(
      commands,
      [
        'Команды /paysupport, /terms и /support зарегистрированы ДО приёма сообщений.',
        'Тогда обращение человека не попадёт в базу: ответ уйдёт, а сообщения не останется.',
        'Реплика при этом обещает «напишите сюда же словами, разберёмся и вернём деньги».',
      ].join('\n'),
    ).toBeGreaterThan(intake);
  });
});

describe('порядок регистрации: служебное сообщение об оплате не доезжает до буфера', () => {
  /**
   * **Ревизия четвёртого этапа: страж мерил сборку, которой в бою нет.**
   *
   * Ветка «служебное сообщение — не выгрузка» в приёме существует, и
   * четыре проверки её измеряют. Но в боевом порядке она не срабатывает
   * вовсе: обработчик оплаты регистрируется **до** приёма, значит
   * служебное сообщение забирает он. Комментарий при этом утверждал
   * обратное.
   *
   * Ветка остаётся — она страхует обратный порядок, — а вот сам порядок
   * не был закреплён ничем: перестановка двух строк в `index.ts` тихо
   * отправила бы сообщение о платеже в буфер выгрузки, и модель
   * разобрала бы его как мысль человека.
   */
  it('в боевом порядке оплата забирается до приёма: выгрузки не появляется', async () => {
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

      return Promise.resolve({
        ok: true,
        result: { message_id: calls.length, date: 0, chat: { id: TG_ID, type: 'private' } },
      } as never);
    });

    // **Тот же порядок, что в сборке**: сперва оплата, потом приём.
    registerBillingHandlers(bot, {
      db: testDb(),
      offerUrl: 'https://vydoh.test/oferta',
      settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
      logger: createLogger({ level: 'silent' }),
      providers: {},
    });

    bot.use(
      incomingMiddleware({
        db: testDb(),
        queue: stubQueue,
        privacyPolicyUrl: POLICY_URL,
        consentUrl: CONSENT_URL,
      }),
    );

    await bot.init();
    await bot.handleUpdate(paymentUpdate());

    // Выгрузки нет: сообщение о платеже до буфера не доехало.
    expect(await testDb().select().from(batches)).toEqual([]);

    /**
     * И в `messages_raw` его тоже нет — так и должно быть.
     *
     * §9.1 «сначала сохраняем» про **слова человека**, а служебное
     * сообщение об оплате написал Telegram: человек нажал кнопку. Сам
     * платёж записан там, где ему место, — в событиях оплаты, вымаранных
     * от личного (§16).
     */
    expect(await testDb().select().from(messagesRaw)).toEqual([]);
  });

  it('страж порядка читает сборку: оплата объявлена раньше приёма', async () => {
    /**
     * Проверка выше собирает бот сама и потому пройдёт при любом порядке
     * в `index.ts` — а дефект был бы именно там. Здесь читается сборка.
     */
    const source = await readFile('src/index.ts', 'utf8');

    const billing = source.indexOf('registerBillingHandlers(');
    const intake = source.indexOf('incomingMiddleware(');

    expect(billing, 'оплата не найдена в сборке').toBeGreaterThan(0);
    expect(intake, 'приём не найден в сборке').toBeGreaterThan(0);

    expect(
      billing,
      [
        'Обработчик оплаты объявлен ПОСЛЕ приёма сообщений.',
        'Тогда служебное сообщение о платеже уедет в буфер выгрузки,',
        'и модель разберёт его как мысль человека.',
      ].join('\n'),
    ).toBeLessThan(intake);
  });
});

describe('осиротевшее закрытие снимается вместе с выгрузкой', () => {
  /**
   * Потолок сообщений закрывает выгрузку прямо в приёме, а отложенное
   * закрытие от предыдущего сообщения остаётся висеть до конца окна.
   *
   * Вреда от него больше нет — заход над закрытой выгрузкой себя не
   * переставляет (ревизия этапов 1–2), — но обещание `closeJobId` «одно
   * задание на выгрузку» без снятия неправда: задание живёт дольше самой
   * выгрузки, просыпается над чужим и ходит в базу зря. А главное: пока
   * оно висит, у следующей выгрузки того же человека закрытие идёт уже
   * не своим путём.
   */

  it('закрытая потолком выгрузка снимает своё отложенное задание', async () => {
    // Потолок сообщений настройкой не объявлен (§15 его не просит) и живёт
    // умолчанием в коде — поэтому он приходит сюда параметром.
    const limits = { ...DEFAULT_LIMITS, maxMessagesPerBatch: 2 };

    const removed: string[] = [];
    const jobs = new Map<string, { remove: () => Promise<void> }>();

    const queue = {
      getJob: (id: string) => Promise.resolve(jobs.get(id)),
      add: (_name: string, _data: unknown, options?: { jobId?: string }) => {
        const id = options?.jobId;

        if (id !== undefined) {
          jobs.set(id, {
            remove: () => {
              removed.push(id);
              jobs.delete(id);
              return Promise.resolve();
            },
          });
        }

        return Promise.resolve({});
      },
    } as unknown as Queue<PipelineJob>;

    const settings = new SettingsRegistry({ db: testDb(), ttlMs: 0 });
    const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: 'ВЫДОХ',
        username: 'vydoh_test_bot',
      } as unknown as UserFromGetMe,
    });

    bot.api.config.use(() =>
      Promise.resolve({
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
      } as never),
    );

    bot.use(
      incomingMiddleware({
        db: testDb(),
        queue,
        settings,
        limits,
        privacyPolicyUrl: POLICY_URL,
        consentUrl: CONSENT_URL,
      }),
    );

    // Первое сообщение ставит закрытие по тишине.
    await bot.handleUpdate(textUpdate('первая мысль'));
    expect(jobs.size, 'закрытие по тишине не поставлено').toBe(1);

    // Второе упирается в потолок: выгрузка уходит в разбор сразу.
    await bot.handleUpdate(textUpdate('вторая мысль'));

    expect(removed, 'задание закрытия осталось висеть над закрытой выгрузкой').toHaveLength(1);
    expect(jobs.size).toBe(0);
  });

  it('сообщение из другой ветки: прежняя выгрузка — в разбор сразу, её ожидание тишины снято (живая проверка 24.09.2026)', async () => {
    const removed: string[] = [];
    const processed: string[] = [];
    const jobs = new Map<string, { remove: () => Promise<void> }>();

    const queue = {
      getJob: (id: string) => Promise.resolve(jobs.get(id)),
      add: (name: string, _data: unknown, options?: { jobId?: string }) => {
        if (name === 'process-user') processed.push(name);
        const id = options?.jobId;
        if (id !== undefined) {
          jobs.set(id, {
            remove: () => {
              removed.push(id);
              jobs.delete(id);
              return Promise.resolve();
            },
          });
        }
        return Promise.resolve({});
      },
    } as unknown as Queue<PipelineJob>;

    const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: 'ВЫДОХ',
        username: 'vydoh_test_bot',
      } as unknown as UserFromGetMe,
    });
    bot.api.config.use(() =>
      Promise.resolve({
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
      } as never),
    );
    bot.use(
      incomingMiddleware({
        db: testDb(),
        queue,
        settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
        limits: DEFAULT_LIMITS,
        privacyPolicyUrl: POLICY_URL,
        consentUrl: CONSENT_URL,
      }),
    );

    // Голос в главном чате — ждёт тишины.
    await bot.handleUpdate(textUpdate('Надо будет поехать за ребенком в 4 часа'));
    expect(processed).toEqual([]);
    const firstClose = [...jobs.keys()];
    expect(firstClose).toHaveLength(1);

    // Следом — мысль в ветке «покупки». (На бою там было «Какие еще 6», но
    // его с 24.09 бот разбирает сразу, как вопрос, — см. «вопрос
    // разбирается сразу»; здесь проверяется ожидание у новой выгрузки.)
    const inThread = textUpdate('Купить батон и молоко') as Update & {
      message: { message_thread_id?: number; is_topic_message?: boolean };
    };
    inThread.message.message_thread_id = 336049;
    inThread.message.is_topic_message = true;
    await bot.handleUpdate(inThread);

    // Прежняя — в разбор сразу, её ожидание снято; у новой — своё.
    expect(processed).toEqual(['process-user']);
    expect(removed).toEqual(firstClose);
    expect(jobs.size).toBe(1);
    expect([...jobs.keys()]).not.toEqual(firstClose);
  });
});

describe('вопрос разбирается сразу, не дожидаясь тишины (прогон 17.09.2026, находка 20)', () => {
  /**
   * Окно тишины склеивает серию мыслей в одну выгрузку — и на вопрос оно
   * действовало так же: «Что у меня на сегодня?» → «Слушаю.» → полминуты
   * → ответ. На скринах заказчицы 16.09 видно, что она дважды повторяла
   * один и тот же вопрос, не дождавшись. Одиночное сообщение, кончающееся
   * на «?», — вопрос: выгрузка закрывается сразу, разбор ставится в
   * очередь без задержки.
   */
  function watchingQueue(): { queue: Queue<PipelineJob>; adds: { delay: number | undefined }[] } {
    const adds: { delay: number | undefined }[] = [];

    return {
      adds,
      queue: {
        getJob: () => Promise.resolve(undefined),
        add: (_name: string, _data: unknown, options?: { delay?: number }) => {
          adds.push({ delay: options?.delay });
          return Promise.resolve({});
        },
      } as unknown as Queue<PipelineJob>,
    };
  }

  function botWith(queue: Queue<PipelineJob>, sender?: StatusSender): Bot {
    const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: 'ВЫДОХ',
        username: 'vydoh_test_bot',
      } as unknown as UserFromGetMe,
    });

    bot.api.config.use(() =>
      Promise.resolve({
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
      } as never),
    );

    bot.use(
      incomingMiddleware({
        db: testDb(),
        queue,
        privacyPolicyUrl: POLICY_URL,
        consentUrl: CONSENT_URL,
        ...(sender === undefined ? {} : { sender }),
      }),
    );

    return bot;
  }

  /**
   * Очередь, которая в миг постановки разбора смотрит, записано ли уже
   * «Слушаю» у выгрузки («с нуля» Никиты 25.09.2026, 17:11: «Вечером» →
   * «Слушаю.» и отдельно «Напомню…»). Разбор ответа о часе идёт без
   * модели и успевал раньше «Слушаю» — ответ не находил, что заменить.
   */
  function statusCheckingQueue(): { queue: Queue<PipelineJob>; seen: (number | null)[] } {
    const seen: (number | null)[] = [];
    return {
      seen,
      queue: {
        getJob: () => Promise.resolve(undefined),
        add: async (_name: string, _data: unknown, options?: { delay?: number }) => {
          if ((options?.delay ?? 0) === 0) {
            const [row] = await testDb()
              .select({ status: batches.statusMessageId })
              .from(batches)
              .where(eq(batches.userId, userId))
              .orderBy(desc(batches.openedAt))
              .limit(1);
            seen.push(row?.status ?? null);
          }
          return {};
        },
      } as unknown as Queue<PipelineJob>,
    };
  }

  async function lastBatchStatus(): Promise<string | undefined> {
    const [row] = await testDb()
      .select({ status: batches.status })
      .from(batches)
      .where(eq(batches.userId, userId))
      .orderBy(desc(batches.openedAt))
      .limit(1);

    return row?.status;
  }

  it('«Что у меня на сегодня?» — выгрузка закрыта сразу, разбор без задержки', async () => {
    const { queue, adds } = watchingQueue();
    const bot = botWith(queue);

    await bot.handleUpdate(textUpdate('Что у меня на сегодня?'));

    expect(await lastBatchStatus()).toBe('queued');
    // Задание на разбор — без задержки; закрытия по тишине нет.
    expect(adds.some((add) => add.delay === undefined || add.delay === 0)).toBe(true);
    expect(adds.some((add) => (add.delay ?? 0) >= 1_000)).toBe(false);
  });

  it('обычная мысль по-прежнему ждёт тишины', async () => {
    const { queue, adds } = watchingQueue();
    const bot = botWith(queue);

    await bot.handleUpdate(textUpdate('купить продукты'));

    expect(await lastBatchStatus()).toBe('open');
    expect(adds.some((add) => (add.delay ?? 0) >= 1_000)).toBe(true);
  });

  it('вопросительный знак внутри, а не в конце — не вопрос: «надо ли? купить хлеб» ждёт тишины', async () => {
    const { queue } = watchingQueue();
    const bot = botWith(queue);

    await bot.handleUpdate(textUpdate('надо ли? купить хлеб и молоко'));

    expect(await lastBatchStatus()).toBe('open');
  });

  /**
   * Ответ на вопрос бота (проверка Никиты 24.09.2026, 20:21): «Вечером» на
   * «Во сколько … 09:00 или 21:00?» ждало полминуты тишины. Решают те же
   * правила, что потом узнают ответ; не похоже на ответ — ждём, как прежде.
   */
  async function botAskedHour(): Promise<void> {
    await testDb().insert(items).values({
      userId,
      text: 'Перенеси «Позвонить маме» в 9',
      isDraft: true,
      draftReason: CLARIFY_REASON.time,
    });
  }

  function voiceUpdate(durationSec: number): Update {
    seq++;
    return {
      update_id: 700_000 + seq,
      message: {
        message_id: seq,
        date: Math.floor(Date.UTC(2026, 7, 27) / 1000),
        chat: { id: TG_ID, type: 'private', first_name: 'Аня' },
        from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
        voice: { file_id: `voice-${String(seq)}`, file_unique_id: 'u', duration: durationSec },
      },
    } as unknown as Update;
  }

  it('бот спросил «утро или вечер?» — «Вечером» разбирается сразу', async () => {
    await botAskedHour();
    const { queue, adds } = watchingQueue();
    const bot = botWith(queue);

    await bot.handleUpdate(textUpdate('Вечером'));

    expect(await lastBatchStatus()).toBe('queued');
    expect(adds.some((add) => (add.delay ?? 0) >= 1_000)).toBe(false);
  });

  it('ответ на вопрос бота: «Слушаю» записано до начала разбора — ответ встанет на его место («с нуля» 25.09.2026, 17:11)', async () => {
    await botAskedHour();
    const { queue, seen } = statusCheckingQueue();
    const { sender, said } = recordingStatus();

    await botWith(queue, sender).handleUpdate(textUpdate('Вечером'));

    expect(said).toContain(defaultTexts.listening.acknowledged);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((status) => status !== null)).toBe(true);
  });

  it('одиночный вопрос — так же: «Слушаю» на месте к началу разбора', async () => {
    const { queue, seen } = statusCheckingQueue();
    const { sender } = recordingStatus();

    await botWith(queue, sender).handleUpdate(textUpdate('Что у меня на завтра?'));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((status) => status !== null)).toBe(true);
  });

  it('«Слушаю» не отправилось — разбор всё равно поставлен: ответ важнее реплики приёма', async () => {
    await botAskedHour();
    const { queue, adds } = watchingQueue();
    const failing: StatusSender = {
      send: () => Promise.reject(new Error('Telegram недоступен')),
      edit: () => Promise.reject(new Error('Telegram недоступен')),
      delete: () => Promise.resolve(false),
    };

    // Сбой не проглатывается — уходит дальше, в журнал бота.
    await expect(botWith(queue, failing).handleUpdate(textUpdate('Вечером'))).rejects.toThrow(
      /Telegram недоступен/u,
    );

    expect(await lastBatchStatus()).toBe('queued');
    expect(adds.some((add) => (add.delay ?? 0) === 0)).toBe(true);
  });

  it('бот спросил — но пришла другая мысль: ждём тишины, как прежде', async () => {
    await botAskedHour();
    const { queue, adds } = watchingQueue();
    const bot = botWith(queue);

    await bot.handleUpdate(textUpdate('Надо купить хлеб и молоко'));

    expect(await lastBatchStatus()).toBe('open');
    expect(adds.some((add) => (add.delay ?? 0) >= 1_000)).toBe(true);
  });

  it('бот спросил — короткое голосовое сразу, длинное ждёт тишины', async () => {
    await botAskedHour();
    const short = watchingQueue();
    await botWith(short.queue).handleUpdate(voiceUpdate(3));
    expect(await lastBatchStatus()).toBe('queued');

    await botAskedHour();
    const long = watchingQueue();
    await botWith(long.queue).handleUpdate(voiceUpdate(12));
    expect(await lastBatchStatus()).toBe('open');
  });

  it('вопрос о часе пережил чужую реплику — короткое голосовое ждёт тишины, «Вечером» текстом сразу (28.09.2026)', async () => {
    await testDb().insert(items).values({
      userId,
      text: 'Перенеси «Позвонить маме» в 9',
      isDraft: true,
      draftReason: CLARIFY_TIME_WAITING,
    });
    await botWith(watchingQueue().queue).handleUpdate(textUpdate('Вечером'));
    expect(await lastBatchStatus()).toBe('queued');

    // Следующая выгрузка: короткое голосовое первым — ждёт тишины.
    await botWith(watchingQueue().queue).handleUpdate(voiceUpdate(2));
    expect(await lastBatchStatus()).toBe('open');
  });

  it('бот ничего не спрашивал — короткое голосовое ждёт тишины, как прежде', async () => {
    const { queue } = watchingQueue();

    await botWith(queue).handleUpdate(voiceUpdate(2));

    expect(await lastBatchStatus()).toBe('open');
  });

  describe('голосовое — сразу «Минуточку, слушаю запись…» (правка заказчицы 30.09.2026)', () => {
    /**
     * Было два слова подряд: «Слушаю…», потом разбор правил его в
     * «Секунду, слушаю запись…». Теперь на голосовое реплика одна и та
     * же с первой секунды — разбор ставит ту же, ничего не прыгает.
     */
    it('одно голосовое — одна реплика про запись', async () => {
      const { sender, said } = recordingStatus();

      await botWith(watchingQueue().queue, sender).handleUpdate(voiceUpdate(7));

      expect(said).toEqual([defaultTexts.listening.working]);
    });

    it('текст — по-прежнему «Слушаю…»', async () => {
      const { sender, said } = recordingStatus();

      await botWith(watchingQueue().queue, sender).handleUpdate(textUpdate('купить хлеб'));

      expect(said).toEqual([defaultTexts.listening.acknowledged]);
    });

    it('в серии есть голосовое — про запись, и после текста следом тоже', async () => {
      const { sender, said } = recordingStatus();
      const bot = botWith(watchingQueue().queue, sender);

      await bot.handleUpdate(textUpdate('купить хлеб'));
      await bot.handleUpdate(voiceUpdate(7));
      await bot.handleUpdate(textUpdate('и молоко'));

      expect(said).toEqual([
        defaultTexts.listening.acknowledged,
        defaultTexts.listening.working,
        defaultTexts.listening.working,
      ]);
    });
  });

  async function botAskedMove(
    hoursAgo: number,
    segment = 'перенеси ребенка на вечер',
  ): Promise<void> {
    const [item] = await testDb()
      .insert(items)
      .values({ userId, text: 'Забрать ребенка', type: 'TASK', priority: 'SOON', topic: 'семья' })
      .returning({ id: items.id });
    const [batch] = await testDb()
      .insert(batches)
      .values({ userId, status: 'done', openedAt: new Date(), closedAt: new Date() })
      .returning({ id: batches.id });
    await askQuestion(testDb(), {
      userId,
      itemId: item!.id,
      batchId: batch!.id,
      segment,
      action: 'update',
      changes: {
        note: '',
        text: '',
        deadline: '',
        deadlineAccuracy: 'none',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
      },
      now: new Date(Date.now() - hoursAgo * 60 * 60_000),
    });
  }

  it('бот спросил «Перенести «X»?» — «да» разбирается сразу', async () => {
    await botAskedMove(0);
    const { queue } = watchingQueue();

    await botWith(queue).handleUpdate(textUpdate('да'));

    expect(await lastBatchStatus()).toBe('queued');
  });

  it('«давай» после «Перенести «X»?» — сразу; после «Это про X или отдельная?» — ждёт', async () => {
    await botAskedMove(0, 'перенеси ребенка на 8 вечера');
    await botWith(watchingQueue().queue).handleUpdate(textUpdate('давай'));
    expect(await lastBatchStatus()).toBe('queued');

    await botAskedMove(0, 'нет, в пятницу');
    await botWith(watchingQueue().queue).handleUpdate(textUpdate('давай'));
    expect(await lastBatchStatus()).toBe('open');
  });

  it('протухший вопрос приём не закрывает: его закроет уборка и сохранит слова', async () => {
    await botAskedMove(24 * 30);
    const { queue } = watchingQueue();

    await botWith(queue).handleUpdate(textUpdate('да'));

    // Вопроса уже нет — ждём тишины, как с обычной репликой…
    expect(await lastBatchStatus()).toBe('open');
    // …а строка вопроса открыта: уборка найдёт её и положит слова черновиком.
    const open = await testDb()
      .select({ resolvedAt: pendingQuestions.resolvedAt })
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));
    expect(open.map((row) => row.resolvedAt)).toEqual([null]);
  });

  it('«Какие еще» и «Напомнишь» без знака вопроса — сразу, как вопрос', async () => {
    const first = watchingQueue();
    await botWith(first.queue).handleUpdate(textUpdate('Какие еще'));
    expect(await lastBatchStatus()).toBe('queued');

    const second = watchingQueue();
    await botWith(second.queue).handleUpdate(textUpdate('Напомнишь'));
    expect(await lastBatchStatus()).toBe('queued');
  });
});

describe('чистая благодарность — ответ сразу (Никита, 27.09.2026)', () => {
  /**
   * «Спасибо» шло общим путём: полминуты тишины — вдруг допишет — и
   * вызов модели. Благодарность — не мысль для разбора: бот отвечает
   * сразу, без «Слушаю», без выгрузки и без модели. Только когда
   * отвечать больше нечего: выгрузка не собирается и бот не ждёт ответа
   * на свой вопрос — иначе как раньше.
   */
  const thanksSent = (calls: readonly ApiCall[]): number =>
    calls.filter(
      (call) =>
        call.method === 'sendMessage' && call.payload['text'] === defaultTexts.answer.thanks,
    ).length;

  it.each([
    'Спасибо',
    'Спасибо тебе большое!',
    'Спасибо, поняла',
    'Хорошо, спасибо',
    'Супер, спасибо',
    'Спасибо, всё понятно',
    'Спасибо, пойду сделаю',
  ])('«%s» — «Пожалуйста 🤍 Я всё помню.» сразу, без выгрузки и без «Слушаю»', async (text) => {
    const { sender, said } = recordingStatus();
    const { bot, calls } = createTestBot({ sender });

    await bot.handleUpdate(textUpdate(text));

    expect(thanksSent(calls)).toBe(1);
    expect(said).toEqual([]);
    expect(await dumpCount()).toBe(0);
    // Съедено — не сирота в панели.
    const [row] = await testDb()
      .select({ consumedAt: messagesRaw.consumedAt })
      .from(messagesRaw)
      .where(eq(messagesRaw.userId, userId));
    expect(row?.consumedAt).not.toBeNull();
  });

  describe('как раньше', () => {
    it('благодарность с делом — в разбор', async () => {
      const { sender } = recordingStatus();
      const { bot, calls } = createTestBot({ sender });

      await bot.handleUpdate(textUpdate('Спасибо, и купи хлеб'));

      expect(thanksSent(calls)).toBe(0);
      expect(await dumpCount()).toBe(1);
    });

    it('выгрузка ещё собирается — «спасибо» идёт в неё, а не обгоняет итог', async () => {
      const { sender } = recordingStatus();
      const { bot, calls } = createTestBot({ sender });

      await bot.handleUpdate(textUpdate('купить продукты'));
      await bot.handleUpdate(textUpdate('Спасибо'));

      expect(thanksSent(calls)).toBe(0);
      expect(await dumpCount()).toBe(1);
      const rows = await testDb()
        .select({ batchId: messagesRaw.batchId })
        .from(messagesRaw)
        .where(eq(messagesRaw.userId, userId));
      expect(rows.every((row) => row.batchId !== null)).toBe(true);
    });

    it('бот ждёт ответа на свой вопрос — «спасибо» разбирается как раньше', async () => {
      const [item] = await testDb()
        .insert(items)
        .values({ userId, text: 'Забрать ребенка', type: 'TASK', priority: 'SOON', topic: 'семья' })
        .returning({ id: items.id });
      const [batch] = await testDb()
        .insert(batches)
        .values({ userId, status: 'done', openedAt: new Date(), closedAt: new Date() })
        .returning({ id: batches.id });
      await askQuestion(testDb(), {
        userId,
        itemId: item!.id,
        batchId: batch!.id,
        segment: 'перенеси ребенка на вечер',
        action: 'update',
        changes: {
          note: '',
          text: '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
      });
      const { bot, calls } = createTestBot({ sender: recordingStatus().sender });

      await bot.handleUpdate(textUpdate('Спасибо'));

      expect(thanksSent(calls)).toBe(0);
      expect(await dumpCount()).toBe(2);
    });

    it('без согласия — экран согласия, а не благодарность', async () => {
      await testDb()
        .update(users)
        .set({ consentConfirmedAt: null, consentEdition: null, consentAt: null })
        .where(eq(users.id, userId));
      const { bot, calls } = createTestBot();

      await bot.handleUpdate(textUpdate('Спасибо'));

      expect(thanksSent(calls)).toBe(0);
      expect(calls.some((call) => call.method === 'sendMessage')).toBe(true);
    });
  });
});

describe('приветствие и «ок» — ответ сразу, из словаря (ТЗ §7.1, Никита 29.09.2026)', () => {
  /**
   * ТЗ §7.1: «Приветствие, благодарность, реплика без содержания —
   * короткий ответ, без обращения к тяжёлым моделям»; §18 — первый отклик
   * практически мгновенный. «Привет» шёл общим путём: полминуты тишины и
   * три этапа модели — 33 секунды и 3,5–5 ₽ на бою. Теперь как «спасибо»:
   * сразу и без модели. Приветствие — по часам человека: днём не бывает
   * «Доброе утро».
   */
  const DAY = new Date('2026-09-29T11:00:00Z'); // 14:00 по Москве
  const dayGreeting = `${defaultTexts.answer.greetingDay} ${defaultTexts.answer.greetingInvite}`;
  const sent = (calls: readonly ApiCall[]): unknown[] =>
    calls.filter((call) => call.method === 'sendMessage').map((call) => call.payload['text']);

  async function consumed(): Promise<boolean> {
    const rows = await testDb()
      .select({ consumedAt: messagesRaw.consumedAt })
      .from(messagesRaw)
      .where(eq(messagesRaw.userId, userId));
    return rows.length > 0 && rows.every((row) => row.consumedAt !== null);
  }

  it.each(['Привет', 'Добрый день!', 'Привет 👋', 'Здравствуйте'])(
    '«%s» днём — «Добрый день 🙂 Расскажешь, что в голове?» сразу, без выгрузки и без «Слушаю»',
    async (text) => {
      const { sender, said } = recordingStatus();
      const { bot, calls } = createTestBot({ sender, now: () => DAY });

      await bot.handleUpdate(textUpdate(text));

      expect(sent(calls)).toEqual([dayGreeting]);
      expect(said).toEqual([]);
      expect(await dumpCount()).toBe(0);
      expect(await consumed()).toBe(true);
    },
  );

  it('днём не бывает «Доброе утро» — даже если человек сам так поздоровался', async () => {
    const { bot, calls } = createTestBot({ sender: recordingStatus().sender, now: () => DAY });

    await bot.handleUpdate(textUpdate('Доброе утро'));

    expect(sent(calls)).toEqual([dayGreeting]);
    expect(String(sent(calls)[0])).not.toMatch(/утро/iu);
  });

  it('по часам человека, а не сервера: 05:00 UTC во Владивостоке — день, в Москве было бы утро', async () => {
    await testDb().update(users).set({ timezone: 'Asia/Vladivostok' }).where(eq(users.id, userId));
    const { bot, calls } = createTestBot({
      sender: recordingStatus().sender,
      now: () => new Date('2026-09-29T05:00:00Z'),
    });

    await bot.handleUpdate(textUpdate('Привет'));

    expect(sent(calls)).toEqual([dayGreeting]);
  });

  it('ночью — просто «Привет 🙂», без «доброй ночи»', async () => {
    const { bot, calls } = createTestBot({
      sender: recordingStatus().sender,
      now: () => new Date('2026-09-29T22:30:00Z'), // 01:30 по Москве
    });

    await bot.handleUpdate(textUpdate('Привет'));

    expect(sent(calls)).toEqual([
      `${defaultTexts.answer.greetingNight} ${defaultTexts.answer.greetingInvite}`,
    ]);
  });

  it.each([
    'Ок',
    'понятно',
    '👍',
    'Супер. Пошла делать',
    'Да, поняла',
    'Ага, понятно',
    'Всё поняла',
    'Хорошо, договорились',
    'Супер',
    'Отлично',
    'Пойду сделаю',
    'Приступаю',
    'Начинаю',
    'Сейчас займусь',
    'Берусь за дело',
    'Займусь этим',
  ])('«%s» — 🙂 сразу, без выгрузки и без модели', async (text) => {
    const { sender, said } = recordingStatus();
    const { bot, calls } = createTestBot({ sender, now: () => DAY });

    await bot.handleUpdate(textUpdate(text));

    expect(sent(calls)).toEqual([defaultTexts.answer.ack]);
    expect(said).toEqual([]);
    expect(await dumpCount()).toBe(0);
    expect(await consumed()).toBe(true);
  });

  it('«ок» после конца пробного — 🙂, как «спасибо»: ответ ничего не стоит', async () => {
    await seedTrialSpent(3);
    const settings = await trialOf(3);
    const { bot, calls } = createTestBot({ settings, now: () => DAY });

    await bot.handleUpdate(textUpdate('Ок'));

    expect(sent(calls)).toEqual([defaultTexts.answer.ack]);
  });

  describe('как раньше', () => {
    it.each([
      'Привет, купи хлеб',
      'Привет, как дела?',
      'Ок, и купи хлеб',
      'Супер. Пошла делать отчёт',
      'Пошла делать. Ещё купить хлеб',
      'Спасибо, поняла, ещё надо позвонить маме',
      'Приступаю к отчёту',
      'Начинаю новый курс',
      'Займусь этим завтра',
    ])('«%s» — сверх приветствия есть слова: в разбор', async (text) => {
      const { bot, calls } = createTestBot({ sender: recordingStatus().sender, now: () => DAY });

      await bot.handleUpdate(textUpdate(text));

      expect(sent(calls)).toEqual([]);
      expect(await dumpCount()).toBe(1);
    });

    it('выгрузка ещё собирается — «привет» и «ок» идут в неё, а не обгоняют итог', async () => {
      const { bot, calls } = createTestBot({ sender: recordingStatus().sender, now: () => DAY });

      await bot.handleUpdate(textUpdate('купить продукты'));
      await bot.handleUpdate(textUpdate('Привет'));
      await bot.handleUpdate(textUpdate('Ок'));

      expect(sent(calls)).toEqual([]);
      expect(await dumpCount()).toBe(1);
    });

    it.each(['Ок', 'Да, поняла', 'Приступаю', 'Спасибо, поняла'])(
      'бот ждёт ответа на свой вопрос — «%s» разбирается как раньше',
      async (text) => {
        const [item] = await testDb()
          .insert(items)
          .values({
            userId,
            text: 'Забрать ребенка',
            type: 'TASK',
            priority: 'SOON',
            topic: 'семья',
          })
          .returning({ id: items.id });
        const [batch] = await testDb()
          .insert(batches)
          .values({ userId, status: 'done', openedAt: new Date(), closedAt: new Date() })
          .returning({ id: batches.id });
        await askQuestion(testDb(), {
          userId,
          itemId: item!.id,
          batchId: batch!.id,
          segment: 'перенеси ребенка на вечер',
          action: 'update',
          changes: {
            note: '',
            text: '',
            deadline: '',
            deadlineAccuracy: 'none',
            recurrenceKind: 'none',
            recurrenceInterval: 0,
            recurrenceText: '',
          },
        });
        const { bot, calls } = createTestBot({ sender: recordingStatus().sender, now: () => DAY });

        await bot.handleUpdate(textUpdate(text));

        expect(sent(calls)).not.toContain(defaultTexts.answer.ack);
        expect(sent(calls)).not.toContain(defaultTexts.answer.thanks);
        expect(await dumpCount()).toBe(2);
      },
    );

    it('переспрос о часе открыт — «ок» остаётся ответом на него', async () => {
      await testDb().insert(items).values({
        userId,
        text: 'Перенеси «Заказать такси» в 8',
        type: 'TASK',
        priority: 'SOON',
        topic: 'личное',
        isDraft: true,
        draftReason: CLARIFY_REASON.time,
      });
      const { bot, calls } = createTestBot({ sender: recordingStatus().sender });

      await bot.handleUpdate(textUpdate('Ок'));

      expect(sent(calls)).not.toContain(defaultTexts.answer.ack);
      expect(await dumpCount()).toBe(1);
    });

    it('переспрос о часе открыт — «привет» тоже идёт прежним путём, приветствие не встревает', async () => {
      await testDb().insert(items).values({
        userId,
        text: 'Перенеси «Заказать такси» в 8',
        type: 'TASK',
        priority: 'SOON',
        topic: 'личное',
        isDraft: true,
        draftReason: CLARIFY_REASON.time,
      });
      const { bot, calls } = createTestBot({ sender: recordingStatus().sender, now: () => DAY });

      await bot.handleUpdate(textUpdate('Привет'));

      expect(sent(calls)).toEqual([]);
      expect(await dumpCount()).toBe(1);
    });

    it('пробный период кончился — на «привет» не зовём рассказывать, а говорим про пробный', async () => {
      await seedTrialSpent(3);
      const settings = await trialOf(3);
      const { bot, calls } = createTestBot({ settings, now: () => DAY });

      await bot.handleUpdate(textUpdate('Привет'));

      expect(sent(calls)).not.toContain(dayGreeting);
      expect(sent(calls)).toContain(defaultTexts.limits.trialOver);
    });

    it('потолок выгрузок за сутки — на «привет» тоже честный отказ', async () => {
      await seedDumps(30);
      const { bot, calls } = createTestBot({ now: () => DAY });

      await bot.handleUpdate(textUpdate('Привет'));

      expect(sent(calls)).toEqual([defaultTexts.limits.tooManyDumps]);
    });

    it('вернулась после двух недель тишины — «привет» идёт к экрану «С возвращением»', async () => {
      const longAgo = new Date(DAY.getTime() - 15 * 24 * 60 * 60_000);
      await testDb()
        .insert(batches)
        .values({ userId, status: 'done', openedAt: longAgo, closedAt: longAgo });
      const { bot, calls } = createTestBot({ sender: recordingStatus().sender, now: () => DAY });

      await bot.handleUpdate(textUpdate('Привет'));

      expect(sent(calls)).toEqual([]);
      expect(await dumpCount()).toBe(2);
    });

    it('без согласия — экран согласия, а не приветствие', async () => {
      await testDb()
        .update(users)
        .set({ consentConfirmedAt: null, consentEdition: null, consentAt: null })
        .where(eq(users.id, userId));
      const { bot, calls } = createTestBot({ now: () => DAY });

      await bot.handleUpdate(textUpdate('Привет'));

      expect(sent(calls)).toEqual([defaultTexts.consent.required(POLICY_URL, CONSENT_URL)]);
    });
  });
});
