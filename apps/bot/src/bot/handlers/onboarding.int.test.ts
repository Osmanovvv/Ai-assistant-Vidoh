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
  STEP,
  topicRows,
  type Button,
} from '../../modules/onboarding/onboarding.service.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { incomingMiddleware } from './incoming.js';
import { registerOnboardingHandlers } from './onboarding.js';
import { registerStartHandlers } from './start.js';

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

  bot.use(incomingMiddleware({ db: testDb(), queue: stubQueue }));
  registerStartHandlers(bot, POLICY_URL);
  registerOnboardingHandlers(bot, testDb(), logger);

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
