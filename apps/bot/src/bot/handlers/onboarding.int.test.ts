import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, topics, users, userSettings } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { localDateParts, startOfDayInZone } from '../../modules/classifier/dates.js';
import type { PipelineJob } from '../../infra/queue.js';
import {
  ACTION,
  onboardingStateOf,
  STEP,
  topicRows,
  type Button,
} from '../../modules/onboarding/onboarding.service.js';
import { FakeTopicGateway } from '../../modules/topics/fake-gateway.js';
import { createTopics, listTopics } from '../../modules/topics/topics.repo.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { consumeAwaited } from './awaiting.js';
import { incomingMiddleware } from './incoming.js';
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

  bot.use(
    incomingMiddleware({
      db: testDb(),
      queue: stubQueue,
      // Ответ словами (задача 3.61): без этого текстовая реплика
      // уходит в буфер выгрузки, как было до задачи.
      consume: consumeAwaited({ db: testDb(), logger }),
    }),
  );
  registerStartHandlers(bot, {
    db: testDb(),
    logger,
    privacyPolicyUrl: POLICY_URL,
    ...(questions === undefined ? {} : { onboarding: questions }),
  });
  registerOnboardingHandlers(bot, testDb(), logger, gateway);

  return { bot, calls };
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

beforeEach(async () => {
  seq = 0;
  const user = await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' });
  userId = user.id;
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

    await bot.handleUpdate(callbackUpdate(`${ACTION.eveningPrefix}22:00`));
    expect((await settingsOf())?.onboardingStep).toBe(STEP.topics);

    // Отмечаем две сферы, затем «Готово».
    await bot.handleUpdate(
      callbackUpdate(`${ACTION.topicPrefix}семья`, topicRows(defaultTexts, [])),
    );
    await bot.handleUpdate(
      callbackUpdate(`${ACTION.topicPrefix}здоровье`, topicRows(defaultTexts, ['семья'])),
    );
    await bot.handleUpdate(
      callbackUpdate(ACTION.topicsDone, topicRows(defaultTexts, ['семья', 'здоровье'])),
    );

    const settings = await settingsOf();
    expect(settings?.onboardingStep).toBe(STEP.done);
    expect(settings?.onboardingDoneAt).not.toBeNull();
    expect(settings?.morningTime).toBe('09:00:00');
    expect(settings?.eveningTime).toBe('22:00:00');

    // §6.4: тема по умолчанию должна быть, иначе запись, не попавшая ни в
    // одну, потеряется на проверке целостности.
    expect(await topicNames()).toEqual(['здоровье', 'личное', 'семья']);
    const [fallback] = await testDb().select().from(topics).where(eq(topics.name, 'личное'));
    expect(fallback?.isDefault).toBe(true);

    const last = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(textOf(last)).toBe(defaultTexts.onboarding.finished);
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
    expect(settings?.onboardingStep).toBe(STEP.topics);
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

describe('сферы жизни', () => {
  it('повторное нажатие снимает отметку', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();
    await startedAt(STEP.topics);

    await bot.handleUpdate(
      callbackUpdate(`${ACTION.topicPrefix}работа`, topicRows(defaultTexts, ['работа'])),
    );

    const last = calls.filter((call) => call.method === 'editMessageText').at(-1);
    const keyboard = last?.payload['reply_markup'] as {
      inline_keyboard: { text: string }[][];
    };
    const labels = keyboard.inline_keyboard.flat().map((button) => button.text);

    expect(labels).toContain('работа');
    expect(labels).not.toContain(defaultTexts.onboarding.topicChosen('работа'));
  });

  it('без выбора берётся базовый набор §6.4 и об этом честно говорится', async () => {
    // Оставить человека без тем нельзя: классификация без списка не
    // работает. Спорить с ним, заставляя выбрать, — тоже: разгрузка не
    // должна превращаться в анкету.
    const { bot, calls } = createTestBot();
    await bot.init();
    await startedAt(STEP.topics);

    await bot.handleUpdate(callbackUpdate(ACTION.topicsDone, topicRows(defaultTexts, [])));

    expect(await topicNames()).toEqual(['здоровье', 'личное', 'покупки', 'работа', 'семья']);

    const last = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(textOf(last)).toBe(defaultTexts.onboarding.finishedDefault);
  });

  it('повторное «Готово» не задваивает темы', async () => {
    // Кнопка остаётся в истории чата, и нажать её второй раз человек
    // может через неделю.
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.topics);

    const keyboard = topicRows(defaultTexts, ['семья']);
    await bot.handleUpdate(callbackUpdate(ACTION.topicsDone, keyboard));
    await bot.handleUpdate(callbackUpdate(ACTION.topicsDone, keyboard));

    expect(await topicNames()).toEqual(['личное', 'семья']);
  });

  it('выбранное «личное» не задваивается темой по умолчанию', async () => {
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.topics);

    await bot.handleUpdate(
      callbackUpdate(ACTION.topicsDone, topicRows(defaultTexts, ['личное', 'дети'])),
    );

    expect(await topicNames()).toEqual(['дети', 'личное']);
  });
});

describe('устаревшие нажатия', () => {
  it('кнопка из прошлого шага не откатывает опрос назад', async () => {
    // Кнопки остаются в истории чата. Без сверки с текущим шагом такое
    // нажатие вернуло бы человека к вопросу про утро.
    const { bot } = createTestBot();
    await bot.init();
    await startedAt(STEP.topics);

    await bot.handleUpdate(callbackUpdate(ACTION.nameYes));
    await bot.handleUpdate(callbackUpdate(ACTION.timezoneMoscow));

    expect((await settingsOf())?.onboardingStep).toBe(STEP.topics);
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

    // Дальше по опросу до сфер жизни.
    await bot.handleUpdate(callbackUpdate(`${ACTION.morningPrefix}08:00`));
    await bot.handleUpdate(callbackUpdate(`${ACTION.eveningPrefix}21:00`));

    // Выбирает «дети» и «деньги» — «здоровья» среди них нет.
    await bot.handleUpdate(
      callbackUpdate(ACTION.topicsDone, topicRows(defaultTexts, ['дети', 'деньги'])),
    );

    // Порядок — как сортирует JS по кодам символов: «деньги» раньше «дети».
    expect(await topicNames()).toEqual(['деньги', 'дети', 'личное']);

    // §6.4: запись из темы, которой у неё нет, уехала в тему по умолчанию.
    const [row] = await testDb()
      .select({ topic: items.topic })
      .from(items)
      .where(eq(items.id, itemId));
    expect(row?.topic).toBe('личное');
  });

  it('выбранная тема сохраняется, срок всё равно пересчитан', async () => {
    const { bot } = createTestBot();
    await bot.init();

    const itemId = await firstDumpItem('здоровье');
    await startedAt(STEP.timezone);

    await bot.handleUpdate(callbackUpdate(`${ACTION.timezonePrefix}Asia/Omsk`));
    await bot.handleUpdate(callbackUpdate(`${ACTION.morningPrefix}08:00`));
    await bot.handleUpdate(callbackUpdate(ACTION.eveningOff));
    await bot.handleUpdate(
      callbackUpdate(ACTION.topicsDone, topicRows(defaultTexts, ['здоровье'])),
    );

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

describe('предложение добавить сферу (§6.4)', () => {
  /**
   * ТЗ §6.4: дела, не подошедшие ни к одной выбранной сфере, уходят в
   * тему по умолчанию, **а бот предлагает создать новую**. План обещал
   * это на задаче 2.15, но в коде потерянные названия только писались в
   * журнал. Нашлось на живой выкладке этапа 2: у человека десять покупок
   * ушло в «личное», и сказать ему об этом было некому.
   */

  async function dumpItemIn(topic: string): Promise<void> {
    await testDb().insert(items).values({
      userId,
      text: 'купить пуфики',
      type: 'TASK',
      priority: 'LATER',
      topic,
      sourceOrder: 0,
    });
  }

  /** Проходит онбординг до сфер и выбирает названные. */
  async function finishOnboarding(bot: Bot, chosen: readonly string[]): Promise<void> {
    await startedAt(STEP.timezone);
    await bot.handleUpdate(callbackUpdate(ACTION.timezoneMoscow));
    await bot.handleUpdate(callbackUpdate(`${ACTION.morningPrefix}08:00`));
    await bot.handleUpdate(callbackUpdate(`${ACTION.eveningPrefix}21:00`));
    await bot.handleUpdate(callbackUpdate(ACTION.topicsDone, topicRows(defaultTexts, chosen)));
  }

  it('после онбординга бот предлагает сферу, в которую дела не попали', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await dumpItemIn('покупки');
    await finishOnboarding(bot, ['семья', 'здоровье']);

    const offer = calls.filter((call) => call.method === 'sendMessage').at(-1);

    expect(String(offer?.payload['text'])).toContain('покупки');
    // Кнопки «Добавить» и «Не надо» — решает человек, а не бот.
    expect(JSON.stringify(offer?.payload['reply_markup'])).toContain(ACTION.addTopicsPrefix);
  });

  it('согласие создаёт сферу и не трогает порядок прежних', async () => {
    const { bot } = createTestBot();
    await bot.init();

    await dumpItemIn('покупки');
    await finishOnboarding(bot, ['семья', 'здоровье']);

    await bot.handleUpdate(callbackUpdate(`${ACTION.addTopicsPrefix}3`));

    // Новая сфера дописана в конец: встань она первой — человеку
    // перетасовало бы весь список без его просьбы. Проверяется именно
    // порядок сортировки, а не алфавит: названия помощник сортирует сам.
    const rows = await testDb()
      .select({ name: topics.name, order: topics.sortOrder })
      .from(topics)
      .where(eq(topics.userId, userId))
      .orderBy(topics.sortOrder);

    expect(rows.map((row) => row.name)).toEqual(['семья', 'здоровье', 'личное', 'покупки']);
    expect(rows.at(-1)?.order).toBeGreaterThan(rows.at(-2)?.order ?? 0);
  });

  it('отказ ничего не создаёт', async () => {
    const { bot } = createTestBot();
    await bot.init();

    await dumpItemIn('покупки');
    await finishOnboarding(bot, ['семья', 'здоровье']);
    const before = await topicNames();

    await bot.handleUpdate(callbackUpdate(ACTION.addTopicsSkip));

    expect(await topicNames()).toEqual(before);
  });

  it('без потерянных сфер предложения нет', async () => {
    // Лишний вопрос дороже отсутствующего: §13.9 не терпит болтовни.
    const { bot, calls } = createTestBot();
    await bot.init();

    await dumpItemIn('здоровье');
    await finishOnboarding(bot, ['семья', 'здоровье']);

    const texts = calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => String(call.payload['text']));

    expect(texts.join(' ')).not.toContain('Добавить такую сферу');
  });

  it('повторное согласие не плодит двойников', async () => {
    const { bot } = createTestBot();
    await bot.init();

    await dumpItemIn('покупки');
    await finishOnboarding(bot, ['семья', 'здоровье']);

    await bot.handleUpdate(callbackUpdate(`${ACTION.addTopicsPrefix}3`));
    await bot.handleUpdate(callbackUpdate(`${ACTION.addTopicsPrefix}3`));

    const names = await topicNames();
    expect(names.filter((name) => name === 'покупки')).toHaveLength(1);
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

  it('ответ на вопрос опроса считается согласием (§16)', async () => {
    /**
     * Пока опрос шёл после выгрузки, сообщение человека всегда было
     * раньше и согласие успевало записаться. Теперь опрос идёт первым, а
     * отвечают на него кнопками — без этого бот узнавал бы имя, пояс и
     * время, не имея согласия вовсе.
     */
    const questions = recordingQuestions();
    const { bot } = createTestBot(questions.sender);

    await bot.handleUpdate(textUpdate('/start'));

    const [before] = await testDb().select().from(users).where(eq(users.id, userId));
    expect(before?.consentAt, 'команда согласием не считается').toBeNull();

    await bot.handleUpdate(callbackUpdate(ACTION.nameYes));

    const [after] = await testDb().select().from(users).where(eq(users.id, userId));
    expect(after?.consentAt).not.toBeNull();
  });

  it('без отправителя вопросов первый запуск работает как прежде', async () => {
    // Так поднимают бота там, где онбординг не проверяется.
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate('/start'));

    expect(calls.some((one) => one.method === 'sendMessage')).toBe(true);
    expect((await onboardingStateOf(testDb(), userId)).step).toBe(0);
  });
});

describe('сферы, появившиеся до опроса (задача 3.43)', () => {
  /**
   * Базовые сферы теперь создаются на первой выгрузке. К шагу «какие
   * сферы важны» они уже есть — и ответ человека обязан их убрать, иначе
   * выбор ничего не значит.
   */

  const BASE = ['семья', 'здоровье', 'работа', 'покупки', 'личное'] as const;

  async function baseSpheresWithThreads(): Promise<void> {
    await createTopics(
      testDb(),
      userId,
      BASE.map((name) => ({ name, isDefault: name === 'личное' })),
    );
    // Две ветки уже созданы в чате — как после первой выгрузки.
    await testDb().update(topics).set({ tgThreadId: 501 }).where(eq(topics.name, 'работа'));
    await testDb().update(topics).set({ tgThreadId: 502 }).where(eq(topics.name, 'покупки'));
  }

  async function itemIn(topic: string): Promise<string> {
    const [row] = await testDb().select().from(topics).where(eq(topics.name, topic));
    const [item] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'купить пуфики',
        type: 'TASK',
        priority: 'LATER',
        topic,
        topicId: row?.id ?? null,
        sourceOrder: 0,
      })
      .returning({ id: items.id });
    return item?.id ?? '';
  }

  async function walkToSpheres(bot: Bot): Promise<void> {
    await startedAt(STEP.timezone);
    await bot.handleUpdate(callbackUpdate(ACTION.timezoneMoscow));
    await bot.handleUpdate(callbackUpdate(`${ACTION.morningPrefix}08:00`));
    await bot.handleUpdate(callbackUpdate(`${ACTION.eveningPrefix}21:00`));
  }

  it('невыбранные сферы уходят в архив, их ветки убраны, дела переехали', async () => {
    const gateway = new FakeTopicGateway();
    const { bot } = createTestBot(undefined, gateway);
    await bot.init();

    await baseSpheresWithThreads();
    const itemId = await itemIn('покупки');
    await walkToSpheres(bot);

    await bot.handleUpdate(
      callbackUpdate(ACTION.topicsDone, topicRows(defaultTexts, ['семья', 'здоровье'])),
    );

    const alive = (await listTopics(testDb(), userId)).map((topic) => topic.name).sort();
    expect(alive).toEqual(['здоровье', 'личное', 'семья']);

    // Строки в базе остались, помечены архивными.
    const all = await testDb().select().from(topics).where(eq(topics.userId, userId));
    expect(
      all
        .filter((topic) => topic.isArchived)
        .map((topic) => topic.name)
        .sort(),
    ).toEqual(['покупки', 'работа']);

    // Ветки архивных сфер убраны из чата — обе, у которых они были.
    expect(gateway.deletedThreads.map((thread) => thread.threadId).sort()).toEqual([501, 502]);

    // Дело из «покупок» уехало в тему по умолчанию вместе со ссылкой.
    const [moved] = await testDb().select().from(items).where(eq(items.id, itemId));
    const fallback = all.find((topic) => topic.name === 'личное');
    expect(moved?.topic).toBe('личное');
    expect(moved?.topicId).toBe(fallback?.id);
  });

  it('пустой выбор оставляет базовый набор как есть', async () => {
    const gateway = new FakeTopicGateway();
    const { bot } = createTestBot(undefined, gateway);
    await bot.init();

    await baseSpheresWithThreads();
    await walkToSpheres(bot);

    await bot.handleUpdate(callbackUpdate(ACTION.topicsDone, topicRows(defaultTexts, [])));

    const alive = (await listTopics(testDb(), userId)).map((topic) => topic.name).sort();
    expect(alive).toEqual(['здоровье', 'личное', 'покупки', 'работа', 'семья']);
    expect(gateway.deletedThreads).toHaveLength(0);
  });

  it('выбранное сверх базового добавляется, а не упирается в существующее', async () => {
    const gateway = new FakeTopicGateway();
    const { bot } = createTestBot(undefined, gateway);
    await bot.init();

    await baseSpheresWithThreads();
    await walkToSpheres(bot);

    await bot.handleUpdate(
      callbackUpdate(ACTION.topicsDone, topicRows(defaultTexts, ['семья', 'дети'])),
    );

    const alive = (await listTopics(testDb(), userId)).map((topic) => topic.name).sort();
    expect(alive).toEqual(['дети', 'личное', 'семья']);
  });
});

/**
 * Ответ словами вместо кнопки (задача 3.61).
 *
 * Пять пунктов заказчика от 04.09.2026, из них здесь два: своё имя
 * («может кто-то хочет, чтобы её называли Леночка») и своё время («если
 * человек хочет 7-30»).
 *
 * Опрос был целиком на кнопках намеренно: свободный ответ приходит
 * обычным сообщением и попадает в буфер выгрузки. Поэтому главное, что
 * проверяется ниже, — **мысль человека не теряется ни в одном случае**.
 */
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
    const { bot } = createTestBot(recordingQuestions().sender);
    await bot.init();
    await startedAt(STEP.evening);

    await bot.handleUpdate(callbackUpdate(ACTION.eveningOwn));
    await bot.handleUpdate(textUpdate('в 21 45'));

    const settings = await settingsOf();
    expect(settings?.eveningTime).toBe('21:45:00');
    expect(settings?.eveningOn).toBe(true);
    expect((await onboardingStateOf(testDb(), userId)).step).toBe(STEP.topics);
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
});
