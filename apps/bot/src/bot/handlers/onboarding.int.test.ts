import { Writable } from 'node:stream';

import type { Queue } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import { Bot, GrammyError, HttpError } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, messagesRaw, topics, users, userSettings } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { localDateParts, startOfDayInZone } from '../../modules/classifier/dates.js';
import type { PipelineJob } from '../../infra/queue.js';
import type { PaymentProvider } from '../../modules/billing/provider.js';
import {
  ACTION,
  onboardingStateOf,
  STEP,
  type Button,
} from '../../modules/onboarding/onboarding.service.js';
import { AWAITING, setAwaiting } from '../../modules/onboarding/awaiting.js';
import { SettingsRegistry } from '../../modules/settings/settings.repo.js';
import { FakeTopicGateway } from '../../modules/topics/fake-gateway.js';
import { confirmConsent, upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { quietCallbackAnswer } from '../callback-answer.js';
import { consumeAwaited, type AwaitingDeps } from './awaiting.js';
import type { CardSender } from '../../modules/cards/cards.js';
import { createPromoConsumer } from './billing.js';
import { CONSENT_ACTION, incomingMiddleware, releaseHeldMessages } from './incoming.js';
import { registerOnboardingHandlers } from './onboarding.js';
import { registerStartHandlers } from './start.js';
import type { QuestionSender } from '../../modules/presenter/telegram-sender.js';

/**
 * Онбординг через настоящие обработчики бота (задача 2.13).
 *
 * Проверяется связка целиком: нажатие пришло — состояние изменилось,
 * следующий вопрос показан. Именно на разрыве «модуль есть, а в боте не
 * вызывается» уже попадалось статусное сообщение на первом этапе.
 *
 * Главный критерий задачи проверяется здесь же: до первой выгрузки бот
 * не задаёт ни одного вопроса (§12.2, §13.1).
 */

const logger = createLogger({ level: 'silent' });
const POLICY_URL = 'https://vydoh.test/privacy';
const CONSENT_URL = 'https://vydoh.test/consent';
const TG_ID = 5151;

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
 * Отправитель вопросов опроса: без него `/start` опрос не начинает.
 *
 * Записывает заданное, чтобы проверять и текст, и кнопки: рамка опроса
 * должна появиться ровно один раз, у первого вопроса.
 */
function recordingQuestions(): {
  sender: QuestionSender;
  asked: { text: string; rows: string[][] }[];
} {
  const asked: { text: string; rows: string[][] }[] = [];

  return {
    asked,
    sender: {
      ask: ({ text, rows }) => {
        asked.push({ text, rows: rows.map((row) => row.map((one) => one.label)) });
        return Promise.resolve(asked.length);
      },
    },
  };
}

function createTestBot(
  questions?: QuestionSender,
  gateway?: FakeTopicGateway,
  /** Журнал приёма ответа: там, где проверяется, что отказ назван. */
  log: Logger = logger,
  /** Приём промокода словами — как в бою, обратным вызовом (§14). */
  promo?: AwaitingDeps['promo'],
  /** Бренд-карточки (ТЗ по визуалам 18.09.2026): карточка старта после опроса. */
  cards?: CardSender,
  /** Часы: приветствие зависит от времени суток (29.09.2026). */
  now?: () => Date,
): { bot: Bot; calls: ApiCall[] } {
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

  const incoming = {
    db: testDb(),
    queue: stubQueue,
    privacyPolicyUrl: POLICY_URL,
    consentUrl: CONSENT_URL,
    // Ответ словами (задача 3.61): без этого текстовая реплика
    // уходит в буфер выгрузки, как было до задачи.
    consume: consumeAwaited({ db: testDb(), logger: log, promo, cards, now }),
    now,
  };
  bot.use(incomingMiddleware(incoming));
  registerStartHandlers(bot, {
    db: testDb(),
    logger,
    privacyPolicyUrl: POLICY_URL,
    consentUrl: CONSENT_URL,
    privacyPolicyEdition: EDITION,
    release: (id, chatId) => releaseHeldMessages(incoming, { userId: id, chatId }),
    ...(questions === undefined ? {} : { onboarding: questions }),
  });
  registerOnboardingHandlers(bot, testDb(), logger, { cards });

  return { bot, calls };
}

/** Считает показанные карточки. */
function recordingCards(): { cards: CardSender; shown: { card: string; caption: string }[] } {
  const shown: { card: string; caption: string }[] = [];
  return {
    shown,
    cards: {
      send: ({ card, caption }) => {
        shown.push({ card, caption });
        return Promise.resolve(7000 + shown.length);
      },
    },
  };
}

/** Так Telegram помечает команду. */
const COMMAND_RE = /^\/[A-Za-z0-9_]{1,64}(?:@[A-Za-z0-9_]+)?(?:$|\s)/u;

function textUpdate(text: string): Update {
  seq++;
  const entities = COMMAND_RE.test(text)
    ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? text.length }]
    : undefined;

  return {
    update_id: 600_000 + seq,
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

/**
 * Нажатие кнопки. Клавиатура текущей реплики передаётся вместе с ним:
 * состояние выбора сфер живёт именно там, и без неё обработчик не увидит
 * уже отмеченного.
 */
function callbackUpdate(data: string, keyboard?: readonly (readonly Button[])[]): Update {
  seq++;

  return {
    update_id: 600_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      chat_instance: 'test',
      data,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: TG_ID, type: 'private', first_name: 'Аня' },
        ...(keyboard === undefined
          ? {}
          : {
              reply_markup: {
                inline_keyboard: keyboard.map((row) =>
                  row.map((button) => ({ text: button.label, callback_data: button.action })),
                ),
              },
            }),
      },
    },
  } as unknown as Update;
}

/** Текст реплики из записанного вызова. */
function textOf(call: ApiCall | undefined): string {
  const value = call?.payload['text'];
  return typeof value === 'string' ? value : '';
}

/** Подписи кнопок реплики: нужны там, где важно, чьи это кнопки. */
function keyboardOf(call: ApiCall | undefined): { text: string; callback_data?: string }[] {
  const markup = call?.payload['reply_markup'] as
    { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

async function settingsOf(): Promise<typeof userSettings.$inferSelect | undefined> {
  const [row] = await testDb().select().from(userSettings).where(eq(userSettings.userId, userId));
  return row;
}

async function timezoneOf(): Promise<{ zone: string; confirmed: boolean } | undefined> {
  const [row] = await testDb()
    .select({ zone: users.timezone, confirmed: users.timezoneConfirmed })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

async function topicNames(): Promise<string[]> {
  const rows = await testDb().select().from(topics).where(eq(topics.userId, userId));
  return rows.map((row) => row.name).sort();
}

/** Ставит человека на шаг, как это сделал бы конвейер после разбора. */
async function startedAt(step: number): Promise<void> {
  await testDb()
    .update(userSettings)
    .set({ onboardingStep: step })
    .where(eq(userSettings.userId, userId));
}

const EDITION = '2026-10-01';

beforeEach(async () => {
  seq = 0;
  const user = await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' });
  userId = user.id;
  // Согласие нажато: первый экран и опрос ниже — путь после него.
  await confirmConsent(testDb(), userId, { edition: EDITION });
});

describe('согласие кнопкой «Согласна» (§16, решение заказчицы 12.09.2026)', () => {
  async function withoutConsent(): Promise<void> {
    await testDb()
      .update(users)
      .set({ consentConfirmedAt: null, consentEdition: null, consentAt: null })
      .where(eq(users.id, userId));
  }

  it('первый экран без согласия — приветствие, политика, 18+ и одна кнопка; вопроса нет', async () => {
    /**
     * Отступление от §13.1 ТЗ («никаких опросов до первой выгрузки») по
     * слову его автора: заказчица 12.09.2026 попросила отдельное явное
     * действие перед первой выгрузкой. Опрос при этом остаётся за
     * кнопкой — один призыв к действию в одном обмене (§13.9).
     */
    await withoutConsent();
    const questions = recordingQuestions();
    const { bot, calls } = createTestBot(questions.sender);

    await bot.handleUpdate(textUpdate('/start'));

    const sent = calls.filter((call) => call.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(textOf(sent[0])).toBe(defaultTexts.consent.screen(POLICY_URL, CONSENT_URL));
    // Две ссылки — на Политику и на само Согласие (правка 14.09.2026,
    // п. 2.2): документы обещают обе.
    expect(textOf(sent[0])).toContain(`](${POLICY_URL})`);
    expect(textOf(sent[0])).toContain(`](${CONSENT_URL})`);
    expect(textOf(sent[0])).toContain('18');
    expect(keyboardOf(sent[0]).map((button) => [button.text, button.callback_data])).toEqual([
      [defaultTexts.consent.button, CONSENT_ACTION.accept],
    ]);
    expect(questions.asked).toEqual([]);
    expect((await settingsOf())?.onboardingStep).toBe(0);
  });

  it('нажатие записывает согласие с редакцией и открывает опрос первым вопросом', async () => {
    await withoutConsent();
    const questions = recordingQuestions();
    const { bot, calls } = createTestBot(questions.sender);
    await bot.handleUpdate(textUpdate('/start'));

    await bot.handleUpdate(callbackUpdate(CONSENT_ACTION.accept));

    const [row] = await testDb().select().from(users).where(eq(users.id, userId));
    expect(row?.consentConfirmedAt).not.toBeNull();
    expect(row?.consentEdition).toBe(EDITION);
    expect(row?.consentAt).not.toBeNull();

    const sent = calls.filter((call) => call.method === 'sendMessage');
    expect(sent).toHaveLength(2);
    expect(textOf(sent[1])).toContain(defaultTexts.onboarding.nameConfirm('Аня'));
    expect(keyboardOf(sent[1]).map((button) => button.text)).toContain(
      defaultTexts.onboarding.buttonNameYes,
    );
    expect((await settingsOf())?.onboardingStep).not.toBe(0);
  });

  it('нажатие после пройденного опроса — короткое «можно говорить»', async () => {
    await withoutConsent();
    await testDb()
      .update(userSettings)
      .set({ onboardingStep: STEP.done })
      .where(eq(userSettings.userId, userId));
    const questions = recordingQuestions();
    const { bot, calls } = createTestBot(questions.sender);

    await bot.handleUpdate(callbackUpdate(CONSENT_ACTION.accept));

    const sent = calls.filter((call) => call.method === 'sendMessage');
    expect(sent.map(textOf)).toEqual([defaultTexts.consent.accepted]);
  });

  it('кнопка «Согласна» снимается после нажатия, повторное нажатие молчит (проджект, 20.09.2026)', async () => {
    /**
     * Скриншот проджекта: кнопка оставалась под сообщением, и каждое
     * нажатие приносило новое «Спасибо. Теперь можно говорить…» — три
     * подряд. Согласие — один раз: кнопка убирается правкой разметки,
     * повторное нажатие только подтверждается Telegram'у, без реплик.
     */
    await withoutConsent();
    await testDb()
      .update(userSettings)
      .set({ onboardingStep: STEP.done })
      .where(eq(userSettings.userId, userId));
    const { bot, calls } = createTestBot(recordingQuestions().sender);

    await bot.handleUpdate(callbackUpdate(CONSENT_ACTION.accept));
    await bot.handleUpdate(callbackUpdate(CONSENT_ACTION.accept));
    await bot.handleUpdate(callbackUpdate(CONSENT_ACTION.accept));

    const sent = calls.filter((call) => call.method === 'sendMessage');
    expect(sent.map(textOf)).toEqual([defaultTexts.consent.accepted]);
    // Разметка снята с сообщения согласия — при первом же нажатии; на
    // повторных правка идёт снова (кнопки уже нет — Telegram откажет, это
    // не страшно), а реплики нет.
    expect(
      calls.filter((call) => call.method === 'editMessageReplyMarkup').length,
    ).toBeGreaterThanOrEqual(1);
    // Каждое нажатие подтверждено Telegram'у, чтобы часики не крутились.
    expect(calls.filter((call) => call.method === 'answerCallbackQuery')).toHaveLength(3);
  });

  it('сказанное до нажатия ждёт и после нажатия уходит в выгрузку', async () => {
    /**
     * §16 — ничего не теряется: слова до кнопки сохранены, но не
     * разбираются; после кнопки они подхватываются в выгрузку, как если
     * бы пришли только что. Человеку не приходится повторять.
     */
    await withoutConsent();
    const questions = recordingQuestions();
    const { bot } = createTestBot(questions.sender);

    await bot.handleUpdate(textUpdate('записать сына к врачу'));

    const held = await testDb().select().from(messagesRaw).where(eq(messagesRaw.userId, userId));
    expect(held).toHaveLength(1);
    expect(held[0]?.batchId).toBeNull();

    await bot.handleUpdate(callbackUpdate(CONSENT_ACTION.accept));

    const [after] = await testDb().select().from(messagesRaw).where(eq(messagesRaw.userId, userId));
    expect(after?.batchId).not.toBeNull();
  });

  describe('первое нажатие оборвалось (боевой журнал 27.09.2026, 14:48)', () => {
    /**
     * Согласие записалось, а ответ Telegram «нажатие принято» оборвался
     * (`ECONNRESET`): обработчик упал и не прислал первый вопрос. Второе
     * нажатие сняло кнопку и промолчало — согласие уже было. Человек
     * остался без кнопки и без вопроса.
     */
    function connectionReset(): HttpError {
      const inner = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      return new HttpError(`Network request for 'answerCallbackQuery' failed!`, inner);
    }

    it('сбой ответа на нажатие не мешает прислать первый вопрос', async () => {
      await withoutConsent();
      const questions = recordingQuestions();
      const { bot, calls } = createTestBot(questions.sender);
      // Обрыв — ближе к Telegram, защита — снаружи, как в `createBot`.
      bot.api.config.use((prev, method, payload, signal) =>
        method === 'answerCallbackQuery'
          ? Promise.reject(connectionReset())
          : prev(method, payload, signal),
      );
      bot.api.config.use(quietCallbackAnswer());
      await bot.handleUpdate(textUpdate('/start'));

      await bot.handleUpdate(callbackUpdate(CONSENT_ACTION.accept));

      const [row] = await testDb().select().from(users).where(eq(users.id, userId));
      expect(row?.consentConfirmedAt).not.toBeNull();
      const sent = calls.filter((call) => call.method === 'sendMessage');
      expect(sent).toHaveLength(2);
      expect(textOf(sent[1])).toContain(defaultTexts.onboarding.nameConfirm('Аня'));
    });

    it('повторное нажатие присылает первый вопрос, если опрос так и не начался — один раз', async () => {
      // Состояние после оборванного нажатия: согласие есть, опрос на нуле.
      expect((await settingsOf())?.onboardingStep).toBe(0);
      const questions = recordingQuestions();
      const { bot, calls } = createTestBot(questions.sender);

      await bot.handleUpdate(callbackUpdate(CONSENT_ACTION.accept));
      await bot.handleUpdate(callbackUpdate(CONSENT_ACTION.accept));
      await bot.handleUpdate(callbackUpdate(CONSENT_ACTION.accept));

      const sent = calls.filter((call) => call.method === 'sendMessage').map(textOf);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(defaultTexts.onboarding.nameConfirm('Аня'));
      // «Спасибо» второй раз не приходит: согласие было дано раньше.
      expect(sent).not.toContain(defaultTexts.consent.accepted);
      expect((await settingsOf())?.onboardingStep).not.toBe(0);
    });

    it('повторное нажатие выпускает слова, ждавшие согласия', async () => {
      await withoutConsent();
      const { bot } = createTestBot(recordingQuestions().sender);
      await bot.handleUpdate(textUpdate('записать сына к врачу'));
      // Оборванное нажатие: согласие записано, а до выпуска дело не дошло.
      await confirmConsent(testDb(), userId, { edition: EDITION });

      await bot.handleUpdate(callbackUpdate(CONSENT_ACTION.accept));

      const [after] = await testDb()
        .select()
        .from(messagesRaw)
        .where(eq(messagesRaw.userId, userId));
      expect(after?.batchId).not.toBeNull();
    });
  });
});

describe('до первой выгрузки', () => {
  it('первый запуск не задаёт ни одного вопроса', async () => {
    // Условие готовности задачи 2.13 и требование §13.1: никакой
    // регистрации, опроса и настройки до первой выгрузки.
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(textUpdate('/start'));

    const replies = calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => String(call.payload['text']));

    expect(replies.length).toBeGreaterThan(0);
    for (const reply of replies) {
      expect(reply, reply).not.toContain('?');
    }

    // И состояние онбординга не сдвинулось: он ещё не начинался.
    expect((await settingsOf())?.onboardingStep).toBe(0);
  });

  it('обычное сообщение тоже не запускает опрос', async () => {
    const { bot } = createTestBot();
    await bot.init();

    await bot.handleUpdate(textUpdate('надо купить продукты'));

    expect((await settingsOf())?.onboardingStep).toBe(0);
  });
});

describe('имя из Telegram (видео заказчицы 15.09.2026)', () => {
  it('«Да» на «Называть тебя Аня?» запоминает имя', async () => {
    /**
     * Заказчица: «он спросил, звать тебя Ольга? Я сказала да, и он не
     * запомнил — пришлось через настройки писать имя заново». «Да»
     * двигало опрос дальше, а имя не записывало: настройки потом
     * говорили «По имени не зову». Подтверждение — это выбор человека,
     * и записывается так же, как имя, написанное своими словами.
     */
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.name);

    await bot.handleUpdate(callbackUpdate(ACTION.nameYes));

    expect((await settingsOf())?.preferredName).toBe('Аня');
    expect((await settingsOf())?.onboardingStep).toBe(STEP.timezone);
  });

  it('«Поправлю потом» имя не трогает', async () => {
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.name);

    await bot.handleUpdate(callbackUpdate(ACTION.nameLater));

    expect((await settingsOf())?.preferredName).toBeNull();
    expect((await settingsOf())?.onboardingStep).toBe(STEP.timezone);
  });
});

describe('полный путь', () => {
  it('пять нажатий доводят до конца и создают темы', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();
    await startedAt(STEP.name);

    await bot.handleUpdate(callbackUpdate(ACTION.nameYes));
    expect((await settingsOf())?.onboardingStep).toBe(STEP.timezone);

    await bot.handleUpdate(callbackUpdate(ACTION.timezoneMoscow));
    expect((await settingsOf())?.onboardingStep).toBe(STEP.morning);
    expect(await timezoneOf()).toEqual({ zone: 'Europe/Moscow', confirmed: true });

    await bot.handleUpdate(callbackUpdate(`${ACTION.morningPrefix}09:00`));
    expect((await settingsOf())?.onboardingStep).toBe(STEP.evening);

    // Вечер — последний вопрос: шага про сферы больше нет (правка
    // заказчицы 14.09.2026, п. 1.1 — сферы бот заводит сам по содержанию).
    await bot.handleUpdate(callbackUpdate(`${ACTION.eveningPrefix}22:00`));
    expect((await settingsOf())?.onboardingStep).toBe(STEP.done);
    expect((await settingsOf())?.onboardingDoneAt).not.toBeNull();

    const settings = await settingsOf();
    expect(settings?.morningTime).toBe('09:00:00');
    expect(settings?.eveningTime).toBe('22:00:00');

    // Опрос сфер не заводит и не трогает: базовый набор появляется на
    // первой разобранной выгрузке (задача 3.43), дальше — по содержанию.
    expect(await topicNames()).toEqual([]);

    const last = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(textOf(last)).toBe(defaultTexts.onboarding.finished);
  });

  it('после опроса — карточка старта с приглашением, без кнопок (ТЗ по визуалам 18.09.2026)', async () => {
    const { cards, shown } = recordingCards();
    const { bot } = createTestBot(undefined, undefined, undefined, undefined, cards);
    await bot.init();
    await startedAt(STEP.evening);

    await bot.handleUpdate(callbackUpdate(`${ACTION.eveningPrefix}22:00`));

    expect(shown).toEqual([{ card: 'start', caption: defaultTexts.cards.start }]);
  });

  it('опрос закрыт словами — карточка старта тоже', async () => {
    const { cards, shown } = recordingCards();
    const { bot } = createTestBot(
      recordingQuestions().sender,
      undefined,
      undefined,
      undefined,
      cards,
    );
    await bot.init();
    await startedAt(STEP.evening);

    await bot.handleUpdate(callbackUpdate(ACTION.eveningOwn));
    await bot.handleUpdate(textUpdate('в 21 45'));

    expect(shown.map((one) => one.card)).toEqual(['start']);
  });

  it('каждый ответ правит ту же реплику, а не шлёт новую', async () => {
    // §9.2 и §13.9: простыня из пяти сообщений подряд — это не «пара
    // вопросов», а анкета.
    const { bot, calls } = createTestBot();
    await bot.init();
    await startedAt(STEP.name);

    await bot.handleUpdate(callbackUpdate(ACTION.nameYes));
    await bot.handleUpdate(callbackUpdate(ACTION.timezoneMoscow));

    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'editMessageText')).toHaveLength(2);
  });

  it('в каждой показанной реплике ровно один вопрос', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();
    await startedAt(STEP.name);

    await bot.handleUpdate(callbackUpdate(ACTION.nameYes));
    await bot.handleUpdate(callbackUpdate(ACTION.timezoneOther));
    await bot.handleUpdate(callbackUpdate(`${ACTION.timezonePrefix}Asia/Krasnoyarsk`));
    await bot.handleUpdate(callbackUpdate(`${ACTION.morningPrefix}08:00`));

    for (const call of calls.filter((item) => item.method === 'editMessageText')) {
      const text = textOf(call);
      expect((text.match(/\?/gu) ?? []).length, text).toBeLessThanOrEqual(1);
    }
  });
});

describe('часовой пояс', () => {
  it('«другой город» показывает список и не двигает шаг', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();
    await startedAt(STEP.timezone);

    await bot.handleUpdate(callbackUpdate(ACTION.timezoneOther));

    // Шаг тот же: человек ещё не выбрал.
    expect((await settingsOf())?.onboardingStep).toBe(STEP.timezone);

    const last = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(textOf(last)).toBe(defaultTexts.onboarding.timezoneChoose);
  });

  it('выбранный город сохраняется и помечается подтверждённым', async () => {
    // Подтверждённый пояс отличается от значения по умолчанию: по нему
    // задача 2.14 решает, пересчитывать ли сроки первой выгрузки.
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.timezone);

    await bot.handleUpdate(callbackUpdate(`${ACTION.timezonePrefix}Asia/Vladivostok`));

    expect(await timezoneOf()).toEqual({ zone: 'Asia/Vladivostok', confirmed: true });
    expect((await settingsOf())?.onboardingStep).toBe(STEP.morning);
  });

  it('подделанный пояс из нажатия игнорируется', async () => {
    // callback_data приходит снаружи, и доверять ей нельзя: строка,
    // попавшая в настройку, сломала бы расчёт всех сроков.
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.timezone);

    await bot.handleUpdate(callbackUpdate(`${ACTION.timezonePrefix}Mars/Olympus`));

    expect((await timezoneOf())?.zone).toBe('Europe/Moscow');
    expect((await timezoneOf())?.confirmed).toBe(false);
    expect((await settingsOf())?.onboardingStep).toBe(STEP.timezone);
  });
});

describe('напоминания', () => {
  it('«не надо вечером» выключает вечернее, а не ставит пустое время', async () => {
    // Пустого времени в §11 нет, а выключатель есть.
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.evening);

    await bot.handleUpdate(callbackUpdate(ACTION.eveningOff));

    const settings = await settingsOf();
    expect(settings?.eveningOn).toBe(false);
    expect(settings?.eveningTime).toBe('21:00:00');
    expect(settings?.onboardingStep).toBe(STEP.done);
  });

  it('подделанное время не проходит', async () => {
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.morning);

    await bot.handleUpdate(callbackUpdate(`${ACTION.morningPrefix}утром`));

    expect((await settingsOf())?.morningTime).toBe('08:30:00');
    expect((await settingsOf())?.onboardingStep).toBe(STEP.morning);
  });
});

describe('устаревшие нажатия', () => {
  it('кнопка из прошлого шага не откатывает опрос назад', async () => {
    // Кнопки остаются в истории чата. Без сверки с текущим шагом такое
    // нажатие вернуло бы человека к вопросу про утро.
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.evening);

    await bot.handleUpdate(callbackUpdate(ACTION.nameYes));
    await bot.handleUpdate(callbackUpdate(ACTION.timezoneMoscow));

    expect((await settingsOf())?.onboardingStep).toBe(STEP.evening);
  });

  it('и не перезаписывает уже выбранное', async () => {
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.timezone);

    await bot.handleUpdate(callbackUpdate(`${ACTION.timezonePrefix}Asia/Omsk`));
    expect((await timezoneOf())?.zone).toBe('Asia/Omsk');

    // Через неделю человек листает историю и нажимает «Да, Москва».
    await bot.handleUpdate(callbackUpdate(ACTION.timezoneMoscow));

    expect((await timezoneOf())?.zone).toBe('Asia/Omsk');
  });

  it('после завершения опрос не начинается заново', async () => {
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.done);

    await bot.handleUpdate(callbackUpdate(ACTION.nameYes));

    expect((await settingsOf())?.onboardingStep).toBe(STEP.done);
  });
});

describe('вечернее напоминание отдельно от остальных', () => {
  it('«не надо вечером» не выключает утренние', async () => {
    // Человек просил не писать вечером, а не молчать вовсе.
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.evening);

    await bot.handleUpdate(callbackUpdate(ACTION.eveningOff));

    const settings = await settingsOf();
    expect(settings?.eveningOn).toBe(false);
    expect(settings?.notificationsOn).toBe(true);
  });

  it('выбранное время вечера включает его обратно', async () => {
    const { bot } = createTestBot();
    await bot.init();
    await testDb()
      .update(userSettings)
      .set({ eveningOn: false, onboardingStep: STEP.evening })
      .where(eq(userSettings.userId, userId));

    await bot.handleUpdate(callbackUpdate(`${ACTION.eveningPrefix}20:00`));

    const settings = await settingsOf();
    expect(settings?.eveningOn).toBe(true);
    expect(settings?.eveningTime).toBe('20:00:00');
  });
});

describe('домиграция первой выгрузки', () => {
  /** Запись первой выгрузки: срок разобран по московскому допущению. */
  async function firstDumpItem(topic: string): Promise<string> {
    const [row] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'записать сына к врачу',
        type: 'TASK',
        priority: 'SOON',
        topic,
        sourceOrder: 0,
        deadlineAt: startOfDayInZone({ year: 2026, month: 8, day: 27 }, 'Europe/Moscow'),
        deadlineAccuracy: 'day',
        createdAt: new Date('2026-08-25T09:00:00.000Z'),
      })
      .returning({ id: items.id });

    return row!.id;
  }

  async function localDeadline(itemId: string, zone: string): Promise<string> {
    const [row] = await testDb()
      .select({ deadlineAt: items.deadlineAt })
      .from(items)
      .where(eq(items.id, itemId));

    const parts = localDateParts(row!.deadlineAt!, zone);
    return `${String(parts.year)}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }

  it('полный путь: выгрузка, онбординг, пересчёт срока, перенос темы', async () => {
    // Тест из условия задачи 2.14. Первая выгрузка разобрана по
    // допущениям — московский пояс и базовый набор тем, — а человек
    // отвечает иначе.
    const { bot } = createTestBot();
    await bot.init();

    const itemId = await firstDumpItem('здоровье');
    await startedAt(STEP.timezone);

    // Пояс: Владивосток.
    await bot.handleUpdate(callbackUpdate(`${ACTION.timezonePrefix}Asia/Vladivostok`));

    expect((await timezoneOf())?.zone).toBe('Asia/Vladivostok');
    // День остался тем же днём — уже в её поясе, а не в московском.
    expect(await localDeadline(itemId, 'Asia/Vladivostok')).toBe('2026-08-27');

    // Дальше по опросу до конца: шага про сферы нет (правка 14.09.2026,
    // п. 1.1), тема записи остаётся той, что дал разбор.
    await bot.handleUpdate(callbackUpdate(`${ACTION.morningPrefix}08:00`));
    await bot.handleUpdate(callbackUpdate(`${ACTION.eveningPrefix}21:00`));

    expect((await settingsOf())?.onboardingStep).toBe(STEP.done);

    const [row] = await testDb()
      .select({ topic: items.topic })
      .from(items)
      .where(eq(items.id, itemId));
    expect(row?.topic).toBe('здоровье');
  });

  it('выбранная тема сохраняется, срок всё равно пересчитан', async () => {
    const { bot } = createTestBot();
    await bot.init();

    const itemId = await firstDumpItem('здоровье');
    await startedAt(STEP.timezone);

    await bot.handleUpdate(callbackUpdate(`${ACTION.timezonePrefix}Asia/Omsk`));
    await bot.handleUpdate(callbackUpdate(`${ACTION.morningPrefix}08:00`));
    await bot.handleUpdate(callbackUpdate(ACTION.eveningOff));

    expect(await localDeadline(itemId, 'Asia/Omsk')).toBe('2026-08-27');

    const [row] = await testDb()
      .select({ topic: items.topic })
      .from(items)
      .where(eq(items.id, itemId));
    expect(row?.topic).toBe('здоровье');
  });

  it('«Да, Москва» ничего не пересчитывает, но подтверждает пояс', async () => {
    // Пояс тот же, что действовал по умолчанию: пересчёта нет, а признак
    // подтверждения нужен — по нему 2.14 отличает «мы угадали неверно» от
    // «человек переехал».
    const { bot } = createTestBot();
    await bot.init();

    const itemId = await firstDumpItem('здоровье');
    await startedAt(STEP.timezone);

    await bot.handleUpdate(callbackUpdate(ACTION.timezoneMoscow));

    expect(await timezoneOf()).toEqual({ zone: 'Europe/Moscow', confirmed: true });
    expect(await localDeadline(itemId, 'Europe/Moscow')).toBe('2026-08-27');
  });
});

describe('опрос начинается с первого запуска (запрос на изменение №2)', () => {
  /**
   * До 02.09.2026 опрос шёл **после** первой выгрузки — так трижды
   * требовало ТЗ (§12.2 и §13.1). Правку дал автор самого ТЗ, посмотрев
   * на живой первый запуск: разбор приходил и сразу за ним вопрос про
   * имя и время, то есть два призыва к действию в одном обмене.
   */

  it('«/start» задаёт первый вопрос одним сообщением и ставит шаг', async () => {
    /**
     * **Приветствие и вопрос — одно сообщение** (задача 3.61, правка
     * заказчика 04.09.2026: «может сделаем опрос первым сообщением»).
     * Раньше уходило два сообщения подряд, и во втором был вопрос, то
     * есть два призыва к действию в одном обмене.
     */
    const questions = recordingQuestions();
    const { bot, calls } = createTestBot(questions.sender);

    await bot.handleUpdate(textUpdate('/start'));

    // Вторым сообщением вопрос больше не приходит.
    expect(questions.asked).toEqual([]);

    const sent = calls.filter((call) => call.method === 'sendMessage');
    expect(sent).toHaveLength(1);

    const screen = textOf(sent[0]);
    expect(screen).toContain('Привет. Я ВЫДОХ.');
    expect(screen).toContain(defaultTexts.onboarding.opening);
    expect(screen).toContain(defaultTexts.onboarding.nameConfirm('Аня'));

    // И кнопки на нём — вопроса, а не приветствия.
    const labels = keyboardOf(sent[0]).map((button) => button.text);
    expect(labels).toContain(defaultTexts.onboarding.buttonNameYes);
    expect(labels).toContain(defaultTexts.onboarding.buttonNameOwn);
    expect(labels).not.toContain(defaultTexts.start.buttonVoice);

    const state = await onboardingStateOf(testDb(), userId);
    expect(state.step).toBe(STEP.name);
  });

  it('рамка опроса появляется один раз, а не у каждого вопроса', async () => {
    // «Пара вопросов…» перед каждым шагом читалось бы как заклинание.
    const questions = recordingQuestions();
    const { bot, calls } = createTestBot(questions.sender);

    await bot.handleUpdate(textUpdate('/start'));
    await bot.handleUpdate(callbackUpdate(ACTION.nameYes));

    // Первый вопрос теперь внутри приветствия, следующие — правкой той
    // же реплики. Отдельным сообщением не уходит ни один.
    expect(questions.asked).toEqual([]);

    const texts = calls
      .filter((one) => one.method === 'sendMessage' || one.method === 'editMessageText')
      .map((one) => (typeof one.payload['text'] === 'string' ? one.payload['text'] : ''));

    // После имени идёт пояс, а не время: порядок шагов — name → timezone.
    const second = texts.filter((text) => text.includes(defaultTexts.onboarding.timezoneMoscow));

    expect(second, `реплики: ${texts.join(' | ')}`).toHaveLength(1);
    expect(second[0]).not.toContain(defaultTexts.onboarding.opening);
  });

  it('повторный «/start» опрос не перезапускает', async () => {
    // Человек может нажать «/start» и на десятый день: спрашивать заново
    // значило бы стереть его ответы.
    const questions = recordingQuestions();
    const { bot, calls } = createTestBot(questions.sender);

    await bot.handleUpdate(textUpdate('/start'));
    await bot.handleUpdate(textUpdate('/start'));

    const screens = calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => textOf(call));

    // Два экрана, но вопрос — только на первом: второй показывает
    // приветствие с прежними двумя кнопками.
    expect(screens).toHaveLength(2);
    expect(screens.filter((text) => text.includes(defaultTexts.onboarding.opening))).toHaveLength(
      1,
    );
    expect(questions.asked).toEqual([]);
  });

  it('без отправителя вопросов первый запуск работает как прежде', async () => {
    // Так поднимают бота там, где онбординг не проверяется.
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate('/start'));

    expect(calls.some((one) => one.method === 'sendMessage')).toBe(true);
    expect((await onboardingStateOf(testDb(), userId)).step).toBe(0);
  });
});

describe('ответ словами', () => {
  async function awaitingOfUser(): Promise<string | null> {
    return (await settingsOf())?.awaitingInput ?? null;
  }

  const repliesOf = (calls: readonly ApiCall[]): string[] =>
    calls.filter((one) => one.method === 'sendMessage').map((one) => textOf(one));

  it('«Напишу своё» просит имя и запоминает, чего ждёт', async () => {
    const { bot, calls } = createTestBot(recordingQuestions().sender);
    await bot.init();

    await bot.handleUpdate(textUpdate('/start'));
    await bot.handleUpdate(callbackUpdate(ACTION.nameOwn));

    expect(textOf(calls.filter((one) => one.method === 'editMessageText').at(-1))).toBe(
      defaultTexts.onboarding.nameAsk,
    );
    expect(await awaitingOfUser()).toBe('name');

    // Шаг не двинулся: человек ещё не ответил, он выбрал способ ответить.
    expect((await onboardingStateOf(testDb(), userId)).step).toBe(STEP.name);
  });

  it('присланное имя сохраняется и опрос идёт дальше', async () => {
    const { bot, calls } = createTestBot(recordingQuestions().sender);
    await bot.init();

    await bot.handleUpdate(textUpdate('/start'));
    await bot.handleUpdate(callbackUpdate(ACTION.nameOwn));
    await bot.handleUpdate(textUpdate('Леночка'));

    expect((await settingsOf())?.preferredName).toBe('Леночка');
    expect(await awaitingOfUser()).toBeNull();

    // Видно сразу, как теперь зовут: разбор имени строгий, но не
    // безошибочный, и промах человек должен заметить в ту же секунду.
    const replies = repliesOf(calls);
    expect(replies).toContain(defaultTexts.onboarding.nameSaved('Леночка'));

    // И следующий вопрос задан — опрос не встал.
    expect(replies.some((text) => text.includes(defaultTexts.onboarding.timezoneMoscow))).toBe(
      true,
    );
    expect((await onboardingStateOf(testDb(), userId)).step).toBe(STEP.timezone);
  });

  it('имя человека сильнее имени из Telegram', async () => {
    /**
     * `upsertUser` перезаписывает `users.first_name` тем, что пришло от
     * Telegram, на **каждом** сообщении. Выбранное имя, положенное туда,
     * исчезло бы со следующей репликой — поэтому оно в своей колонке.
     */
    const { bot } = createTestBot(recordingQuestions().sender);
    await bot.init();

    await bot.handleUpdate(textUpdate('/start'));
    await bot.handleUpdate(callbackUpdate(ACTION.nameOwn));
    await bot.handleUpdate(textUpdate('Ксюша'));

    // Ещё одно сообщение — то самое, на котором имя раньше и терялось.
    await bot.handleUpdate(textUpdate('надо купить хлеб'));

    expect((await onboardingStateOf(testDb(), userId)).name).toBe('Ксюша');
  });

  it('мысль вместо имени уходит в разбор, а не в имя', async () => {
    // Ровно то, из-за чего опрос был на кнопках. Ожидание снимается,
    // человеку сказано, что бот не понял, и сообщение идёт обычным путём.
    const { bot, calls } = createTestBot(recordingQuestions().sender);
    await bot.init();

    await bot.handleUpdate(textUpdate('/start'));
    await bot.handleUpdate(callbackUpdate(ACTION.nameOwn));
    await bot.handleUpdate(textUpdate('надо купить продукты и позвонить бабушке'));

    expect((await settingsOf())?.preferredName).toBeNull();
    expect(await awaitingOfUser()).toBeNull();
    expect(repliesOf(calls)).toContain(defaultTexts.onboarding.nameNotUnderstood);
  });

  it('«Другое время» принимает 7:30 и идёт к вечеру', async () => {
    const { bot, calls } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.morning);

    await bot.handleUpdate(callbackUpdate(ACTION.morningOwn));
    expect(await awaitingOfUser()).toBe('morning');

    await bot.handleUpdate(textUpdate('7:30'));

    expect((await settingsOf())?.morningTime).toBe('07:30:00');
    expect(await awaitingOfUser()).toBeNull();
    expect((await onboardingStateOf(testDb(), userId)).step).toBe(STEP.evening);
    expect(repliesOf(calls)).toContain(defaultTexts.onboarding.morningSaved('07:30'));
  });

  it('вечернее время словами тоже принимается', async () => {
    const { bot, calls } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.evening);

    await bot.handleUpdate(callbackUpdate(ACTION.eveningOwn));
    await bot.handleUpdate(textUpdate('в 21 45'));

    const settings = await settingsOf();
    expect(settings?.eveningTime).toBe('21:45:00');
    expect(settings?.eveningOn).toBe(true);
    // Последний ответ словами закрывает опрос (правка 14.09.2026, п. 1.1).
    expect((await onboardingStateOf(testDb(), userId)).step).toBe(STEP.done);
    const texts = calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => String(call.payload['text']));
    expect(texts.at(-1)).toBe(defaultTexts.onboarding.finished);
  });

  /**
   * Набор docs/eval-dialog/settings.md (28.09.2026): «в 9» на «Во сколько
   * писать вечером?» сохранялось как 09:00 — вечерняя сводка пришла бы
   * утром; «не пиши вечером» было «не разобрала».
   */
  it.each<[string, string]>([
    ['в 9', '21:00:00'],
    ['в девять', '21:00:00'],
    ['полдесятого', '21:30:00'],
  ])('вечер словами «%s» — вечерняя половина суток', async (said, expected) => {
    const { bot } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.evening);

    await bot.handleUpdate(callbackUpdate(ACTION.eveningOwn));
    await bot.handleUpdate(textUpdate(said));

    expect((await settingsOf())?.eveningTime).toBe(expected);
  });

  it('«не пиши вечером» — вечером не писать, опрос закрыт', async () => {
    const { bot, calls } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.evening);

    await bot.handleUpdate(callbackUpdate(ACTION.eveningOwn));
    await bot.handleUpdate(textUpdate('не пиши вечером'));

    expect((await settingsOf())?.eveningOn).toBe(false);
    expect((await onboardingStateOf(testDb(), userId)).step).toBe(STEP.done);
    expect(repliesOf(calls)).toContain(defaultTexts.settings.savedEveningOff);
  });

  it('«Меня зовут Оля» — имя «Оля», а не вся фраза', async () => {
    const { bot } = createTestBot(recordingQuestions().sender);
    await bot.init();

    await bot.handleUpdate(textUpdate('/start'));
    await bot.handleUpdate(callbackUpdate(ACTION.nameOwn));
    await bot.handleUpdate(textUpdate('Меня зовут Оля'));

    expect((await settingsOf())?.preferredName).toBe('Оля');
  });

  it('«купить хлеб» на «Как тебя звать?» — не имя: имя не тронуто', async () => {
    const { bot } = createTestBot(recordingQuestions().sender);
    await bot.init();

    await bot.handleUpdate(textUpdate('/start'));
    await bot.handleUpdate(callbackUpdate(ACTION.nameOwn));
    await bot.handleUpdate(textUpdate('купить хлеб'));

    expect((await settingsOf())?.preferredName).toBeNull();
  });

  it('не время — настройка не меняется, мысль идёт в разбор', async () => {
    const { bot, calls } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.morning);

    const before = (await settingsOf())?.morningTime;

    await bot.handleUpdate(callbackUpdate(ACTION.morningOwn));
    await bot.handleUpdate(textUpdate('когда получится'));

    expect((await settingsOf())?.morningTime).toBe(before);
    expect(await awaitingOfUser()).toBeNull();
    expect(repliesOf(calls)).toContain(defaultTexts.onboarding.timeNotUnderstood);
  });

  it('пока бот ничего не ждёт, сообщение идёт обычным путём', async () => {
    /**
     * Главное свойство всей задачи: колонка пуста почти всегда, и тогда
     * путь входящего ровно такой, каким был. Ни одной реплики от приёма
     * ответа быть не должно.
     */
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(textUpdate('надо купить хлеб'));

    const replies = repliesOf(calls);
    expect(replies).not.toContain(defaultTexts.onboarding.nameNotUnderstood);
    expect(replies).not.toContain(defaultTexts.onboarding.timeNotUnderstood);
    expect(await awaitingOfUser()).toBeNull();
  });

  describe('приветствие во время опроса (29.09.2026)', () => {
    /**
     * «Привет» на «Как тебя называть?» стал бы именем: бот звал бы
     * человека «Привет». На вопрос о времени — «не поняла время» и мысль
     * в разбор. Приветствие — не ответ и не мысль: бот здоровается по
     * часам человека и ждёт ответа дальше.
     */
    const DAY = new Date('2026-09-29T11:00:00Z'); // 14:00 по Москве
    const at = (): Date => DAY;

    it('«Привет» на «Как тебя называть?» — поздороваться и спросить снова; имя — следующим словом', async () => {
      const { bot, calls } = createTestBot(
        recordingQuestions().sender,
        undefined,
        logger,
        undefined,
        undefined,
        at,
      );
      await bot.init();

      await bot.handleUpdate(textUpdate('/start'));
      await bot.handleUpdate(callbackUpdate(ACTION.nameOwn));
      await bot.handleUpdate(textUpdate('Привет'));

      expect((await settingsOf())?.preferredName).toBeNull();
      expect(await awaitingOfUser()).toBe('name');
      const replies = repliesOf(calls);
      expect(replies.at(-1)).toBe(
        `${defaultTexts.answer.greetingDay} ${defaultTexts.onboarding.nameUnknown}`,
      );
      expect(replies).not.toContain(defaultTexts.onboarding.nameNotUnderstood);

      await bot.handleUpdate(textUpdate('Оля'));
      expect((await settingsOf())?.preferredName).toBe('Оля');
    });

    it('«Привет, я Оля» — имя Оля, а не «Привет, я Оля»', async () => {
      const { bot } = createTestBot(
        recordingQuestions().sender,
        undefined,
        logger,
        undefined,
        undefined,
        at,
      );
      await bot.init();

      await bot.handleUpdate(textUpdate('/start'));
      await bot.handleUpdate(callbackUpdate(ACTION.nameOwn));
      await bot.handleUpdate(textUpdate('Привет, я Оля'));

      expect((await settingsOf())?.preferredName).toBe('Оля');
    });

    it('«Добрый вечер» на «другое время» утра — приветствие по часам, время и ожидание целы', async () => {
      const { bot, calls } = createTestBot(
        recordingQuestions().sender,
        undefined,
        logger,
        undefined,
        undefined,
        at,
      );
      await bot.init();
      await startedAt(STEP.morning);
      const before = (await settingsOf())?.morningTime;

      await bot.handleUpdate(callbackUpdate(ACTION.morningOwn));
      await bot.handleUpdate(textUpdate('Добрый вечер'));

      expect((await settingsOf())?.morningTime).toBe(before);
      expect(await awaitingOfUser()).toBe('morning');
      const replies = repliesOf(calls);
      expect(replies.at(-1)).toBe(defaultTexts.answer.greetingDay);
      expect(replies).not.toContain(defaultTexts.onboarding.timeNotUnderstood);
    });

    it('вопрос опроса висит с кнопками — на «Привет» только приветствие, второго вопроса нет (§13.9)', async () => {
      const { bot, calls } = createTestBot(
        recordingQuestions().sender,
        undefined,
        logger,
        undefined,
        undefined,
        at,
      );
      await bot.init();

      await bot.handleUpdate(textUpdate('/start'));
      await bot.handleUpdate(textUpdate('Привет'));

      expect(repliesOf(calls).at(-1)).toBe(defaultTexts.answer.greetingDay);
    });
  });
});

/**
 * Город словами (задача 3.70, замечание проджекта 04.09.2026).
 *
 * «Другой город не выбирается, как ввести к примеру Краснодар». Кнопок
 * одиннадцать, и это не города, а все часовые пояса России; он искал свой
 * город и не нашёл.
 *
 * Здесь проверяется связка целиком: нажал, написал, пояс встал, опрос
 * пошёл дальше. И то, чего быть не должно: неизвестный город пояс не
 * меняет, а мысль человека не уходит в настройку.
 */
describe('город словами', () => {
  async function awaitingOfUser(): Promise<string | null> {
    return (await settingsOf())?.awaitingInput ?? null;
  }

  const repliesOf = (calls: readonly ApiCall[]): string[] =>
    calls.filter((one) => one.method === 'sendMessage').map((one) => textOf(one));

  it('«Напишу свой город» просит название и запоминает, чего ждёт', async () => {
    const { bot, calls } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.timezone);

    await bot.handleUpdate(callbackUpdate(ACTION.timezoneOther));
    await bot.handleUpdate(callbackUpdate(ACTION.timezoneOwn));

    expect(textOf(calls.filter((one) => one.method === 'editMessageText').at(-1))).toBe(
      defaultTexts.onboarding.cityAsk,
    );
    expect(await awaitingOfUser()).toBe('city');

    // Шаг не двинулся: человек выбрал способ ответить, а не ответил.
    expect((await onboardingStateOf(testDb(), userId)).step).toBe(STEP.timezone);
  });

  it('Краснодар ставит время Москвы и опрос идёт дальше', async () => {
    const { bot, calls } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.timezone);

    await bot.handleUpdate(callbackUpdate(ACTION.timezoneOwn));
    await bot.handleUpdate(textUpdate('Краснодар'));

    const zone = await timezoneOf();
    expect(zone?.zone).toBe('Europe/Moscow');
    expect(zone?.confirmed).toBe(true);
    expect(await awaitingOfUser()).toBeNull();

    // Какое время выбрано — человеку видно: справочник неполон намеренно.
    const replies = repliesOf(calls);
    expect(replies.some((text) => text.includes('Краснодар') && text.includes('Москва'))).toBe(
      true,
    );

    // И следующий вопрос задан.
    expect(replies.some((text) => text.includes(defaultTexts.onboarding.morning))).toBe(true);
    expect((await onboardingStateOf(testDb(), userId)).step).toBe(STEP.morning);
  });

  it('город из другого пояса ставит свой пояс', async () => {
    const { bot } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.timezone);

    await bot.handleUpdate(callbackUpdate(ACTION.timezoneOwn));
    await bot.handleUpdate(textUpdate('я в Новосибирске'));

    expect((await timezoneOf())?.zone).toBe('Asia/Krasnoyarsk');
  });

  it('неизвестный город пояс не меняет и возвращает список', async () => {
    /**
     * Здесь вся цена ошибки: неверный пояс ломает человеку **все** сроки
     * сразу. Догадка по созвучию запрещена — бот честно говорит, что не
     * знает, и показывает одиннадцать кнопок, как раньше.
     */
    const { bot, calls } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.timezone);

    const before = (await timezoneOf())?.zone;

    await bot.handleUpdate(callbackUpdate(ACTION.timezoneOwn));
    await bot.handleUpdate(textUpdate('Урюпинск'));

    expect((await timezoneOf())?.zone).toBe(before);
    expect(await awaitingOfUser()).toBeNull();

    const replies = repliesOf(calls);
    expect(replies).toContain(defaultTexts.onboarding.cityNotFound);
    expect(replies.some((text) => text === defaultTexts.onboarding.timezoneChoose)).toBe(true);

    // Шаг остался на поясе: человек ещё не ответил.
    expect((await onboardingStateOf(testDb(), userId)).step).toBe(STEP.timezone);
  });

  it('мысль вместо города пояс не меняет', async () => {
    const { bot, calls } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.timezone);

    const before = (await timezoneOf())?.zone;

    await bot.handleUpdate(callbackUpdate(ACTION.timezoneOwn));
    await bot.handleUpdate(textUpdate('надо купить продукты и позвонить бабушке'));

    expect((await timezoneOf())?.zone).toBe(before);
    expect(repliesOf(calls)).toContain(defaultTexts.onboarding.cityNotFound);
  });
});

describe('правка настроек словами не двигает опрос (§12.1)', () => {
  /**
   * Виды ожидания у настроек свои, и вот зачем.
   *
   * Ответ на опросе двигает опрос дальше — `askNext`. Если бы правка
   * времени из настроек шла тем же видом ожидания, человек, поправивший
   * время через месяц, снова оказался бы в знакомстве: бот задал бы ему
   * следующий вопрос опроса, которого он не просил.
   *
   * Проверяется именно это: значение меняется, а шаг остаётся `done`.
   */
  async function readyUser(): Promise<void> {
    await testDb()
      .update(userSettings)
      .set({ onboardingStep: STEP.done, onboardingDoneAt: new Date() })
      .where(eq(userSettings.userId, userId));
  }

  it('время словами меняется, а шаг опроса остаётся пройденным', async () => {
    const { bot } = createTestBot();
    await bot.init();
    await readyUser();

    await setAwaiting(testDb(), userId, AWAITING.setMorning);
    await bot.handleUpdate(textUpdate('в 06:45'));

    const row = await settingsOf();

    expect(row?.morningTime).toBe('06:45:00');
    expect(row?.onboardingStep).toBe(STEP.done);
    // Ожидание снято: следующее сообщение — это уже новая мысль.
    expect(row?.awaitingInput).toBeNull();
  });

  it('имя словами меняется, а опрос не начинается заново', async () => {
    const { bot } = createTestBot();
    await bot.init();
    await readyUser();

    await setAwaiting(testDb(), userId, AWAITING.setName);
    await bot.handleUpdate(textUpdate('Оля'));

    const row = await settingsOf();

    expect(row?.preferredName).toBe('Оля');
    expect(row?.onboardingStep).toBe(STEP.done);
  });

  it('непонятное время не съедается молча и настройку не портит', async () => {
    // Ничего не съедается молча: не подошло — сказали и оставили как было.
    const { bot, calls } = createTestBot();
    await bot.init();
    await readyUser();

    await setAwaiting(testDb(), userId, AWAITING.setMorning);
    await bot.handleUpdate(textUpdate('когда-нибудь утром'));

    const row = await settingsOf();

    expect(row?.morningTime).toBe('08:30:00');
    expect(calls.some((call) => textOf(call) === defaultTexts.onboarding.timeNotUnderstood)).toBe(
      true,
    );
  });
});

/**
 * Сбой отправки «не понял» не оставляет мысль сиротой (ревизия этапов 1–2).
 *
 * Приём сохраняет сообщение и фиксирует транзакцию раньше, чем привяжет
 * его к выгрузке, а между этими шагами стоит приём ответа словами. На
 * пути «не подошло — сказали и пустили в разбор» есть отправка в
 * Telegram. Упади она — 429, 5xx, обрыв посреди ответа, — исключение
 * уходило из приёма до привязки, и сообщение оставалось с пустой
 * выгрузкой навсегда: повтор того же апдейта от Telegram отбрасывается
 * как дубль, потому что сообщение уже сохранено. Человек, сказавший
 * мысль в ответ на вопрос бота, не получал ни «не понял», ни разбора, а
 * в журнале была только общая строка «Сбой обработки апдейта».
 *
 * Здесь Telegram отвергает ровно эту реплику, и проверяется то, что
 * обещано страховкой 3 задачи 3.61: сообщение всё равно идёт обычным
 * путём — то есть привязано к выгрузке, — а отказ назван в журнале.
 */
describe('сбой отправки «не понял» не оставляет мысль сиротой', () => {
  interface LogRecord {
    readonly level: number;
    readonly msg?: string;
    readonly [key: string]: unknown;
  }

  /** Журнал в память: проверяется то, что действительно попало в поток. */
  function loggerWithSink(): { logger: Logger; records: LogRecord[] } {
    const records: LogRecord[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.trim() !== '') records.push(JSON.parse(line) as LogRecord);
        }
        callback();
      },
    });

    return { logger: createLogger({ level: 'warn' }, sink), records };
  }

  /** Telegram отвергает одну реплику — ту, что названа. */
  function refuseReply(bot: Bot, refused: string): { refusals: number } {
    const seen = { refusals: 0 };

    bot.api.config.use((prev, method, payload, signal) => {
      if (method === 'sendMessage' && (payload as { text?: unknown }).text === refused) {
        seen.refusals++;
        throw new GrammyError(
          'Call to sendMessage failed',
          { ok: false, error_code: 429, description: 'Too Many Requests', parameters: {} },
          method,
          {},
        );
      }

      return prev(method, payload, signal);
    });

    return seen;
  }

  async function batchOfLastMessage(): Promise<string | null | undefined> {
    const [row] = await testDb()
      .select({ batchId: messagesRaw.batchId })
      .from(messagesRaw)
      .where(eq(messagesRaw.userId, userId))
      .orderBy(desc(messagesRaw.receivedAt))
      .limit(1);

    return row?.batchId;
  }

  const THOUGHT = 'надо купить продукты и позвонить бабушке';

  it('мысль вместо имени на опросе: реплика отвергнута, а выгрузка есть', async () => {
    const { logger: log, records } = loggerWithSink();
    const { bot } = createTestBot(recordingQuestions().sender, undefined, log);
    await bot.init();
    const seen = refuseReply(bot, defaultTexts.onboarding.nameNotUnderstood);

    await bot.handleUpdate(textUpdate('/start'));
    await bot.handleUpdate(callbackUpdate(ACTION.nameOwn));

    // Отказ Telegram не выходит из приёма: иначе повтор апдейта уже дубль.
    await bot.handleUpdate(textUpdate(THOUGHT));

    expect(seen.refusals).toBe(1);
    expect((await settingsOf())?.preferredName).toBeNull();
    expect((await settingsOf())?.awaitingInput).toBeNull();
    // Мысль пошла обычным путём — привязана к выгрузке, а не осталась сиротой.
    expect(await batchOfLastMessage()).toEqual(expect.any(String));
    // И отказ назван, а не проглочен: строка с причиной, без текста человека.
    const warned = records.filter((record) => record.level === 40);
    expect(warned.map((record) => record.msg)).toContainEqual(expect.stringContaining('не понял'));
    expect(JSON.stringify(warned)).toContain('429');
    expect(JSON.stringify(warned)).not.toContain(THOUGHT);
  });

  it('не время на опросе: то же', async () => {
    const { bot } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.morning);
    const seen = refuseReply(bot, defaultTexts.onboarding.timeNotUnderstood);

    await bot.handleUpdate(callbackUpdate(ACTION.morningOwn));
    await bot.handleUpdate(textUpdate('когда получится'));

    expect(seen.refusals).toBe(1);
    expect((await settingsOf())?.awaitingInput).toBeNull();
    expect(await batchOfLastMessage()).toEqual(expect.any(String));
  });

  it.each([
    [AWAITING.setName, defaultTexts.onboarding.nameNotUnderstood, THOUGHT],
    [AWAITING.setEvening, defaultTexts.onboarding.timeNotUnderstood, 'когда-нибудь вечером'],
  ])('правка настроек словами (%s): то же', async (awaiting, refused, said) => {
    const { bot } = createTestBot();
    await bot.init();
    const seen = refuseReply(bot, refused);

    await setAwaiting(testDb(), userId, awaiting);
    await bot.handleUpdate(textUpdate(said));

    expect(seen.refusals).toBe(1);
    expect((await settingsOf())?.awaitingInput).toBeNull();
    expect(await batchOfLastMessage()).toEqual(expect.any(String));
  });

  it('мысль вместо промокода (§14): «не похоже на код» отвергнута, а выгрузка есть', async () => {
    /**
     * Пятая отправка на той же дороге к буферу живёт не в приёме ответа,
     * а в приёме промокода (`billing.ts`), подключённом обратным вызовом —
     * как в бою. Ожидание кода снимается до разбора, значит присланное —
     * мысль, и терять её из-за отказа Telegram нельзя так же, как имя
     * или время.
     */
    const { logger: log, records } = loggerWithSink();
    // Провайдер есть, как в бою: без единого рельса кнопка промокода не
    // показывается вовсе, и стенд без него мерил бы недостижимое.
    const provider: PaymentProvider = {
      name: 'robokassa:smz',
      createCheckout: () => Promise.reject(new Error('в этом страже счёт не выставляется')),
      readEvent: () => Promise.resolve(undefined),
      stopRenewal: () => Promise.resolve(),
      statusOf: () => Promise.resolve(undefined),
    };
    const promo = createPromoConsumer({
      db: testDb(),
      offerUrl: 'https://vydoh.test/oferta',
      settings: new SettingsRegistry({ db: testDb(), logger: log, ttlMs: 0 }),
      logger: log,
      providers: { 'robokassa:smz': provider },
    });
    const { bot } = createTestBot(undefined, undefined, log, promo);
    await bot.init();
    const seen = refuseReply(bot, defaultTexts.billing.promoUnknown);

    await setAwaiting(testDb(), userId, AWAITING.promo);
    await bot.handleUpdate(textUpdate(THOUGHT));

    expect(seen.refusals).toBe(1);
    expect((await settingsOf())?.awaitingInput).toBeNull();
    // Мысль привязана к выгрузке, а не осталась сиротой.
    expect(await batchOfLastMessage()).toEqual(expect.any(String));
    // Отказ назван в журнале с причиной и без текста человека.
    const warned = records.filter((record) => record.level === 40);
    expect(warned.map((record) => record.msg)).toContainEqual(expect.stringContaining('не понял'));
    expect(JSON.stringify(warned)).toContain('429');
    expect(JSON.stringify(warned)).not.toContain(THOUGHT);
  });
});
