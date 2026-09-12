import { and, eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  itemRevisions,
  items,
  projectSteps,
  reminders,
  topics,
  userSettings,
} from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { CARD_ACTION } from '../../modules/items/card-actions.js';
import { FakeTopicGateway } from '../../modules/topics/fake-gateway.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { toShortId } from '../../modules/shared/short-id.js';
import { registerCardHandlers } from './card.js';
import { UNDO_PREFIX } from '../../modules/resolver/change-text.js';
import { registerUndoHandlers } from './undo.js';
import { ANSWER_ACTION } from '../../modules/presenter/presenter.service.js';
import { BILLING_ACTION } from './billing.js';
import { DELETE_STEP_ONE } from './privacy.js';
import { MENU_ACTION, registerMenuHandlers } from './menu.js';

/**
 * Меню и карточка записи через настоящие обработчики (задача 2.18).
 *
 * Главное, что здесь проверяется, — не удобство, а право: короткий
 * идентификатор в `callback_data` не секретный, его можно подделать, и
 * чужая запись по подобранному коду открываться не должна.
 */

const logger = createLogger({ level: 'silent' });
const TG_ID = 7070;
const OTHER_TG_ID = 7071;

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

let seq = 0;
let userId: string;
let otherUserId: string;

function createTestBot(gateway?: FakeTopicGateway): { bot: Bot; calls: ApiCall[] } {
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

  registerMenuHandlers(bot, testDb(), logger, undefined, gateway);
  registerCardHandlers(
    bot,
    { db: testDb(), logger, ...(gateway === undefined ? {} : { topics: gateway }) },
    MENU_ACTION.root,
  );
  // Кнопки карточки отвечают с отменой — как голос и напоминание.
  registerUndoHandlers(bot, { db: testDb(), logger });

  return { bot, calls };
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

function commandUpdate(text: string, from = TG_ID): Update {
  seq++;
  return {
    update_id: 700_000 + seq,
    message: {
      message_id: seq,
      date: 0,
      chat: { id: from, type: 'private', first_name: 'Аня' },
      from: { id: from, is_bot: false, first_name: 'Аня' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  } as unknown as Update;
}

function callbackUpdate(data: string, from = TG_ID, text?: string): Update {
  seq++;
  return {
    update_id: 700_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: from, is_bot: false, first_name: 'Аня' },
      chat_instance: 'test',
      data,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: from, type: 'private', first_name: 'Аня' },
        // Текст сообщения, на котором стоит кнопка: нужен там, где
        // обработчик обязан его сохранить.
        ...(text === undefined ? {} : { text }),
      },
    },
  } as unknown as Update;
}

async function addTopic(owner: string, name: string, isDefault = false): Promise<string> {
  const [row] = await testDb()
    .insert(topics)
    .values({ userId: owner, name, sortOrder: 0, isDefault })
    .returning({ id: topics.id });
  return row!.id;
}

async function addItem(params: {
  readonly owner: string;
  readonly text: string;
  readonly topic: string;
  readonly deadlineAt?: Date | undefined;
  readonly priority?: 'NOW' | 'SOON';
}): Promise<string> {
  const [row] = await testDb()
    .insert(items)
    .values({
      userId: params.owner,
      text: params.text,
      type: 'TASK',
      priority: params.priority ?? 'SOON',
      topic: params.topic,
      sourceOrder: 0,
      deadlineAt: params.deadlineAt ?? null,
      deadlineAccuracy: params.deadlineAt === undefined ? null : 'day',
    })
    .returning({ id: items.id });
  return row!.id;
}

async function itemRow(id: string) {
  const [row] = await testDb().select().from(items).where(eq(items.id, id));
  return row;
}

beforeEach(async () => {
  seq = 0;
  userId = (await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' })).id;
  otherUserId = (await upsertUser(testDb(), { tgId: OTHER_TG_ID, firstName: 'Не Аня' })).id;
});

describe('меню', () => {
  it('команда показывает корень меню', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(commandUpdate('/menu'));

    const sent = calls.find((call) => call.method === 'sendMessage');
    expect(textOf(sent)).toBe(defaultTexts.menu.title);
    expect(keyboardOf(sent).map((button) => button.text)).toEqual([
      // «Наговорить» — основная кнопка §12.1, поэтому первой.
      defaultTexts.menu.buttonVoice,
      defaultTexts.menu.buttonText,
      defaultTexts.menu.buttonAll,
      defaultTexts.menu.buttonToday,
      // «Большие цели» — §12.1, пункт появился 10.09.2026.
      defaultTexts.menu.buttonProjects,
      defaultTexts.menu.buttonHelp,
      defaultTexts.menu.buttonSettings,
      defaultTexts.menu.buttonSubscription,
      defaultTexts.menu.buttonDeleteData,
    ]);
  });

  it('у каждой кнопки корня есть свой экран, а не пустота', async () => {
    /**
     * **Страж переписан 10.09.2026, и прежний был вреден.** Он требовал,
     * чтобы в меню не было кнопки «Проекты», — и тем закреплял пробел:
     * §12.1 просит этот пункт прямо, а закрытие строки ТЗ выглядело бы
     * поломкой проверки. В его пояснении вдобавок стояла неправда:
     * «экран проекта открывается из карточки записи» — такого экрана не
     * существовало вовсе, `contextOf` звал только разбор выгрузки.
     *
     * Стеречь надо не отсутствие кнопок, а **отсутствие кнопок без
     * экрана**: кнопка, которая обещает и не выполняет, дороже
     * отсутствующей — Telegram покажет часики, погасит их, и человек
     * решит, что бот сломался.
     *
     * Кнопки, чьи обработчики живут в других файлах, сверяются по
     * `callback_data` с их же константой — связывает половины только
     * она (см. проверку про «Подписку» ниже).
     */
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(commandUpdate('/menu'));

    const root = keyboardOf(calls.find((call) => call.method === 'sendMessage'));

    /** Кнопки, чей экран живёт не в `menu.ts`. */
    const elsewhere = new Set<string>([BILLING_ACTION.open, DELETE_STEP_ONE]);

    expect(root.length).toBeGreaterThan(4);

    for (const button of root) {
      const data = button.callback_data ?? '';

      if (elsewhere.has(data)) continue;

      const before = calls.length;
      await bot.handleUpdate(callbackUpdate(data));
      const answered = calls
        .slice(before)
        .some((call) => call.method === 'editMessageText' || call.method === 'sendMessage');

      expect(answered, `кнопка «${button.text}» (${data}) не показала экрана`).toBe(true);
    }
  });

  it('«Наговорить» и «Написать» показывают подсказку, а не пустоту', async () => {
    /**
     * §12.1 называет «Наговорить» основной кнопкой меню. Реплики для
     * обеих лежали в словаре и не читались никем — намерение было,
     * связки не было.
     *
     * Текст берётся у приветствия: подсказка одна и та же, и две её
     * копии однажды разошлись бы.
     */
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.hintVoice));
    expect(textOf(calls.at(-1))).toBe(defaultTexts.start.hintVoice);

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.hintText));
    expect(textOf(calls.at(-1))).toBe(defaultTexts.start.hintText);
  });
  it('«Подписка» ведёт на экран подписки, а не в пустоту', async () => {
    /**
     * Кнопка в корне меню и обработчик оплаты живут в разных файлах, и
     * связывает их только строка `callback_data`. Разойдись они — кнопка
     * молча перестанет отвечать: Telegram покажет часики и погасит их, а
     * человек решит, что бот сломался.
     *
     * Тот же класс отказа, что «написано, покрыто тестами и
     * недостижимо»: обе половины целы, а связки между ними нет.
     */
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(commandUpdate('/menu'));

    const button = keyboardOf(calls.find((call) => call.method === 'sendMessage')).find(
      (one) => one.text === defaultTexts.menu.buttonSubscription,
    );

    expect(button?.callback_data).toBe(BILLING_ACTION.open);
  });

  describe('настройки (§11, задача 3.17)', () => {
    async function openSettings() {
      const { bot, calls } = createTestBot();
      await bot.init();
      await bot.handleUpdate(callbackUpdate(MENU_ACTION.settings));

      return { bot, calls };
    }

    const lastScreen = (calls: readonly ApiCall[]): ApiCall | undefined =>
      calls.filter((call) => call.method === 'editMessageText').at(-1);

    it('показывают состояние словами, а не только кнопками', async () => {
      const { calls } = await openSettings();

      expect(textOf(lastScreen(calls))).toContain(defaultTexts.settings.remindersOn);
    });

    it('выключатель напоминаний действительно выключает', async () => {
      const { bot, calls } = await openSettings();
      await bot.handleUpdate(callbackUpdate(MENU_ACTION.toggleReminders));

      const [saved] = await testDb()
        .select({ on: userSettings.notificationsOn })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));

      expect(saved?.on).toBe(false);
      expect(textOf(lastScreen(calls))).toContain(defaultTexts.settings.remindersOff);
    });

    it('нажатие второй раз возвращает как было', async () => {
      const { bot } = await openSettings();
      await bot.handleUpdate(callbackUpdate(MENU_ACTION.toggleReminders));
      await bot.handleUpdate(callbackUpdate(MENU_ACTION.toggleReminders));

      const [saved] = await testDb()
        .select({ on: userSettings.notificationsOn })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));

      expect(saved?.on).toBe(true);
    });

    it('режим тишины переключается и показывает границы', async () => {
      const { bot, calls } = await openSettings();

      expect(textOf(lastScreen(calls))).toContain('22:00');

      await bot.handleUpdate(callbackUpdate(MENU_ACTION.toggleQuiet));

      const [saved] = await testDb()
        .select({ on: userSettings.quietHoursOn })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));

      expect(saved?.on).toBe(false);
      expect(textOf(lastScreen(calls))).toContain(defaultTexts.settings.quietOff);
    });

    it('переключение снимает уже поставленные напоминания', async () => {
      /**
       * Найдено на приёмке этапа 3, на боевом.
       *
       * Раскладка смотрит вперёд на 36 часов. Без сброса человек включает
       * режим тишины, а вечернее напоминание, поставленное час назад на
       * 23:00, всё равно приходит: настройка вступала бы в силу не сразу,
       * а по мере устаревания заданий.
       */
      await testDb()
        .insert(reminders)
        .values({
          userId,
          kind: 'evening',
          dueAt: new Date(Date.now() + 60 * 60_000),
          dedupeKey: 'evening:тест',
        });

      const { bot } = await openSettings();
      await bot.handleUpdate(callbackUpdate(MENU_ACTION.toggleQuiet));

      const left = await testDb().select().from(reminders).where(eq(reminders.userId, userId));

      expect(left).toEqual([]);
    });

    it('отправленные напоминания остаются: по ним считается серия молчания', async () => {
      await testDb()
        .insert(reminders)
        .values({
          userId,
          kind: 'morning',
          dueAt: new Date(Date.now() - 60 * 60_000),
          dedupeKey: 'morning:тест',
          sentAt: new Date(Date.now() - 60 * 60_000),
        });

      const { bot } = await openSettings();
      await bot.handleUpdate(callbackUpdate(MENU_ACTION.toggleReminders));

      const left = await testDb().select().from(reminders).where(eq(reminders.userId, userId));

      expect(left).toHaveLength(1);
    });

    it('кнопка называет действие, а не состояние', async () => {
      // «Напоминания: вкл» на кнопке двусмысленно: непонятно, это то, что
      // сейчас, или то, что случится по нажатию.
      const { calls } = await openSettings();
      const labels = keyboardOf(lastScreen(calls)).map((button) => button.text);

      expect(labels).toContain(defaultTexts.settings.buttonRemindersOff);
      expect(labels).toContain(defaultTexts.menu.buttonBack);
    });
  });

  it('«Все задачи» ведёт по сферам, а сферы — к записям и карточке', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    const topicId = await addTopic(userId, 'здоровье');
    const itemId = await addItem({ owner: userId, text: 'к врачу', topic: 'здоровье' });

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.all));
    const topicsScreen = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(textOf(topicsScreen)).toBe(defaultTexts.menu.topicsTitle);
    expect(keyboardOf(topicsScreen).map((button) => button.text)).toContain('здоровье');

    await bot.handleUpdate(callbackUpdate(`${MENU_ACTION.topicPrefix}${toShortId(topicId)}`));
    const itemsScreen = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(textOf(itemsScreen)).toBe(defaultTexts.summary.header('здоровье'));
    expect(keyboardOf(itemsScreen).map((button) => button.text)).toContain('к врачу');

    const cardButton = keyboardOf(itemsScreen).find((button) => button.text === 'к врачу');
    await bot.handleUpdate(callbackUpdate(cardButton!.callback_data!));

    const card = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(textOf(card)).toContain('к врачу');
    expect(textOf(card)).toContain(defaultTexts.card.statusName('new'));
    expect(itemId).toBeTruthy();
  });

  it('чужая тема по подобранному коду не открывается', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    const mine = await addTopic(userId, 'здоровье');
    const theirs = await addTopic(otherUserId, 'их сфера');
    await addItem({ owner: otherUserId, text: 'чужое дело', topic: 'их сфера' });

    await bot.handleUpdate(callbackUpdate(`${MENU_ACTION.topicPrefix}${toShortId(theirs)}`));

    const screen = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(textOf(screen)).toBe(defaultTexts.menu.topicsTitle);
    expect(keyboardOf(screen).map((button) => button.text)).not.toContain('чужое дело');
    expect(mine).toBeTruthy();
  });

  it('«Сегодня» показывает просроченное и срочное, а не весь бэклог', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await addTopic(userId, 'личное', true);
    await addItem({
      owner: userId,
      text: 'просроченное',
      topic: 'личное',
      deadlineAt: new Date(Date.now() - 86_400_000),
    });
    await addItem({ owner: userId, text: 'срочное', topic: 'личное', priority: 'NOW' });
    await addItem({
      owner: userId,
      text: 'на потом',
      topic: 'личное',
      deadlineAt: new Date(Date.now() + 30 * 86_400_000),
    });

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.today));

    const labels = keyboardOf(calls.filter((call) => call.method === 'editMessageText').at(-1)).map(
      (button) => button.text,
    );

    expect(labels).toContain('просроченное');
    expect(labels).toContain('срочное');
    expect(labels).not.toContain('на потом');
  });

  it('большая цель в «Сегодня» — ближайшим шагом, а не заголовком (ревизия этапа 3, E17)', async () => {
    /**
     * Выдача разбора подставляет у проекта шаг («Выбрать торт»), а
     * «Сегодня» и утреннее писали заголовок («День рождения сына») —
     * §13.2 велит не ставить большую цель в список целиком.
     */
    const { bot, calls } = createTestBot();
    await bot.init();

    await addTopic(userId, 'личное', true);
    const projectId = await addItem({
      owner: userId,
      text: 'День рождения сына',
      topic: 'личное',
      priority: 'NOW',
    });
    await testDb().update(items).set({ isProject: true }).where(eq(items.id, projectId));
    await testDb()
      .insert(projectSteps)
      .values([
        {
          itemId: projectId,
          userId,
          text: 'Составить список гостей',
          position: 1,
          doneAt: new Date(),
        },
        { itemId: projectId, userId, text: 'Выбрать торт', position: 2, doneAt: null },
      ]);

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.today));

    const labels = keyboardOf(calls.filter((call) => call.method === 'editMessageText').at(-1)).map(
      (button) => button.text,
    );

    expect(labels).toContain('Выбрать торт');
    expect(labels).not.toContain('День рождения сына');
  });

  it('«Сегодня» без срочного говорит об этом, а не показывает пустоту', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.today));

    expect(textOf(calls.filter((call) => call.method === 'editMessageText').at(-1))).toBe(
      defaultTexts.menu.todayEmpty,
    );
  });

  it('«Помощь» и «Назад» возвращают в корень', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.help));
    expect(textOf(calls.filter((call) => call.method === 'editMessageText').at(-1))).toBe(
      defaultTexts.menu.help,
    );

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.root));
    expect(textOf(calls.filter((call) => call.method === 'editMessageText').at(-1))).toBe(
      defaultTexts.menu.title,
    );
  });

  it('каждый переход правит одну реплику, а не шлёт новую', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.all));
    await bot.handleUpdate(callbackUpdate(MENU_ACTION.today));
    await bot.handleUpdate(callbackUpdate(MENU_ACTION.root));

    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'editMessageText')).toHaveLength(3);
  });
});

describe('кнопки под ответом не стирают выдачу (ревизия этапа 3, E18)', () => {
  /**
   * 3.58 закрыла это для «Оставить на потом»: прощание дописывается под
   * сводку. «Разобрать всё» и «Сделать сейчас» по-прежнему правили само
   * сообщение с выдачей — три дела, которые человек только что увидел,
   * исчезали под списком сфер или карточкой.
   */
  const sent = (calls: readonly ApiCall[]) => calls.filter((call) => call.method === 'sendMessage');
  const edited = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'editMessageText');

  it('«Разобрать всё» под ответом — новым сообщением', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();
    await addTopic(userId, 'дом', true);

    await bot.handleUpdate(callbackUpdate(ANSWER_ACTION.all));

    expect(edited(calls)).toEqual([]);
    expect(textOf(sent(calls).at(-1))).toBe(defaultTexts.menu.topicsTitle);
  });

  it('«Сделать сейчас» под ответом — новым сообщением', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();
    const itemId = await addItem({ owner: userId, text: 'позвонить маме', topic: 'личное' });

    await bot.handleUpdate(callbackUpdate(`${ANSWER_ACTION.now}:${toShortId(itemId)}`));

    expect(edited(calls)).toEqual([]);
    expect(textOf(sent(calls).at(-1))).toContain('позвонить маме');
  });

  it('тот же пункт из меню по-прежнему правит экран меню', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();
    await addTopic(userId, 'дом', true);

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.all));

    expect(textOf(edited(calls).at(-1))).toBe(defaultTexts.menu.topicsTitle);
  });
});

describe('«Сделать сейчас» открывает показанное (ревизия этапа 3, E2)', () => {
  // Экран из-под ответа уходит новым сообщением, а не правкой (E18).
  it('с кодом дела — его карточку, даже если в «Сегодня» его нет', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    // Бессрочное дело: в «Сегодня» такого нет, а в ответе было.
    const itemId = await addItem({ owner: userId, text: 'позвонить маме', topic: 'личное' });

    await bot.handleUpdate(callbackUpdate(`${ANSWER_ACTION.now}:${toShortId(itemId)}`));

    const shown = textOf(calls.filter((call) => call.method === 'sendMessage').at(-1));
    expect(shown).toContain('позвонить маме');
    expect(shown).not.toBe(defaultTexts.menu.todayEmpty);
  });

  it('чужое дело по коду не открывает', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem({ owner: otherUserId, text: 'чужое', topic: 'личное' });

    await bot.handleUpdate(callbackUpdate(`${ANSWER_ACTION.now}:${toShortId(itemId)}`));

    expect(textOf(calls.filter((call) => call.method === 'sendMessage').at(-1))).toBe(
      defaultTexts.card.gone,
    );
  });

  it('без кода — по-прежнему первое на сегодня («Продолжаем» и старые кнопки)', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await addItem({
      owner: userId,
      text: 'к врачу',
      topic: 'личное',
      deadlineAt: new Date(Date.now() - 86_400_000),
    });

    await bot.handleUpdate(callbackUpdate(ANSWER_ACTION.now));

    expect(textOf(calls.filter((call) => call.method === 'sendMessage').at(-1))).toContain(
      'к врачу',
    );
  });
});

describe('карточка записи', () => {
  it('показывает тему, срок и статус', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await addTopic(userId, 'здоровье');
    const itemId = await addItem({
      owner: userId,
      text: 'к врачу',
      topic: 'здоровье',
      deadlineAt: new Date('2026-09-03T21:00:00.000Z'),
    });

    await bot.handleUpdate(callbackUpdate(`i:${toShortId(itemId)}`));

    const card = textOf(calls.filter((call) => call.method === 'editMessageText').at(-1));
    expect(card).toContain('к врачу');
    expect(card).toContain(`${defaultTexts.card.topicLabel}: здоровье`);
    expect(card).toContain('04.09');
    expect(card).toContain(defaultTexts.card.statusName('new'));
  });

  it('неточный срок числом не называет', async () => {
    // «На следующей неделе» — это не четвёртое сентября, и напоминание по
    // такому числу сработает не тогда.
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem({
      owner: userId,
      text: 'разобрать шкаф',
      topic: 'дом',
      deadlineAt: new Date('2026-09-03T21:00:00.000Z'),
    });
    await testDb().update(items).set({ deadlineAccuracy: 'week' }).where(eq(items.id, itemId));

    await bot.handleUpdate(callbackUpdate(`i:${toShortId(itemId)}`));

    expect(textOf(calls.filter((call) => call.method === 'editMessageText').at(-1))).toContain(
      defaultTexts.card.deadlineApprox('04.09'),
    );
  });

  /** Последняя правка сообщения: реплика на кнопку. */
  const lastEdit = (calls: readonly ApiCall[]) =>
    calls.filter((call) => call.method === 'editMessageText').at(-1);

  const revisionsOf = async (itemId: string) =>
    await testDb().select().from(itemRevisions).where(eq(itemRevisions.itemId, itemId));

  /** Начало местного дня через три дня — куда «Отложить» уносит срок. */
  const threeDaysAhead = (): Date => {
    const iso = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(
      new Date(Date.now() + 3 * 86_400_000),
    );
    return new Date(`${iso}T00:00:00.000+03:00`);
  };

  it('«Сделано» меняет статус, говорит словами резолвера и даёт отменить', async () => {
    /**
     * Ревизия этапа 3, C2: кнопка писала в базу напрямую — без ревизии,
     * без отката, своими словами. Теперь она идёт тем же путём, что
     * голос и кнопка под напоминанием.
     */
    const gateway = new FakeTopicGateway();
    const { bot, calls } = createTestBot(gateway);
    await bot.init();

    await addTopic(userId, 'здоровье');
    const itemId = await addItem({ owner: userId, text: 'к врачу', topic: 'здоровье' });

    await bot.handleUpdate(callbackUpdate(`i:done:${toShortId(itemId)}`));

    const row = await itemRow(itemId);
    expect(row?.status).toBe('done');
    expect(row?.completedAt).not.toBeNull();
    expect(textOf(lastEdit(calls))).toBe(defaultTexts.resolver.completed('к врачу'));
    expect(keyboardOf(lastEdit(calls))[0]?.callback_data).toMatch(
      new RegExp(`^${UNDO_PREFIX}`, 'u'),
    );
    expect(await revisionsOf(itemId)).toHaveLength(1);
    // §8.2: запись ушла из темы, значит сводка изменилась.
    expect(gateway.sent).toHaveLength(1);
  });

  it('отмена под репликой карточки возвращает запись', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem({ owner: userId, text: 'к врачу', topic: 'личное' });
    await bot.handleUpdate(callbackUpdate(`i:done:${toShortId(itemId)}`));

    const undo = keyboardOf(lastEdit(calls))[0]?.callback_data ?? '';
    await bot.handleUpdate(callbackUpdate(undo));

    const row = await itemRow(itemId);
    expect(row?.status).toBe('new');
    expect(row?.completedAt).toBeNull();
  });

  it('«Сделано» у регулярного двигает срок и говорит об этом, а второе за день — нет', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem({
      owner: userId,
      text: 'оплатить садик',
      topic: 'дом',
      deadlineAt: new Date(Date.now() - 86_400_000),
    });
    await testDb()
      .update(items)
      .set({
        recurrenceRule: { kind: 'monthly', interval: 1, anchor: '2026-01-05' },
        recurrenceText: 'каждый месяц',
        recurrenceSource: 'stated',
      })
      .where(eq(items.id, itemId));

    await bot.handleUpdate(callbackUpdate(`i:done:${toShortId(itemId)}`));

    const moved = await itemRow(itemId);
    expect(moved?.status).not.toBe('done');
    expect(moved?.deadlineAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
    expect(textOf(lastEdit(calls))).toMatch(/^Готово\. «оплатить садик» — снова /u);
    expect(await revisionsOf(itemId)).toHaveLength(1);

    // Второе нажатие в тот же день — повтор, а не второе выполнение.
    await bot.handleUpdate(callbackUpdate(`i:done:${toShortId(itemId)}`));

    expect((await itemRow(itemId))?.deadlineAt?.getTime()).toBe(moved?.deadlineAt?.getTime());
    expect(textOf(lastEdit(calls))).toBe(defaultTexts.card.doneToday('оплатить садик'));
    expect(await revisionsOf(itemId)).toHaveLength(1);
  });

  it('«Отложить» уносит на три дня, называет день и оставляет ревизию', async () => {
    /**
     * Ревизия этапа 3, C1: отложенное исчезало навсегда, а реплика
     * обещала «Напомню позже». Теперь дело открыто, срок — начало
     * местного дня через три дня, и человеку назван этот день.
     */
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem({
      owner: userId,
      text: 'к врачу',
      topic: 'личное',
      deadlineAt: new Date(Date.now() - 86_400_000),
    });

    await bot.handleUpdate(callbackUpdate(`i:snz:${toShortId(itemId)}`));

    const row = await itemRow(itemId);
    const until = threeDaysAhead();
    expect(row?.status).toBe('snoozed');
    expect(row?.deadlineAt?.toISOString()).toBe(until.toISOString());
    expect(row?.deadlineAccuracy).toBe('day');

    const [, month = '', day = ''] = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Moscow',
    })
      .format(until)
      .split('-');
    expect(textOf(lastEdit(calls))).toBe(defaultTexts.card.snoozedUntil(`${day}.${month}`));
    expect(keyboardOf(lastEdit(calls))[0]?.callback_data).toMatch(
      new RegExp(`^${UNDO_PREFIX}`, 'u'),
    );
    expect(await revisionsOf(itemId)).toHaveLength(1);
  });

  it('«Отложить» на уже отложенном ничего не меняет и говорит, до какого дня', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem({
      owner: userId,
      text: 'к врачу',
      topic: 'личное',
      deadlineAt: new Date('2030-03-04T21:00:00.000Z'),
    });
    await testDb().update(items).set({ status: 'snoozed' }).where(eq(items.id, itemId));

    await bot.handleUpdate(callbackUpdate(`i:snz:${toShortId(itemId)}`));

    expect(textOf(lastEdit(calls))).toBe(defaultTexts.card.snoozedAlready('05.03'));
    expect(await revisionsOf(itemId)).toHaveLength(0);
  });

  it('«Убрать» не удаляет запись физически (§13.5) и говорит словами резолвера', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem({ owner: userId, text: 'марафон', topic: 'личное' });

    await bot.handleUpdate(callbackUpdate(`i:rm:${toShortId(itemId)}`));

    const row = await itemRow(itemId);
    expect(row).toBeDefined();
    expect(row?.status).toBe('cancelled');
    expect(textOf(lastEdit(calls))).toBe(defaultTexts.resolver.cancelled('марафон'));
    expect(await revisionsOf(itemId)).toHaveLength(1);
  });

  it('кнопки старой карточки на закрытом деле ничего не меняют (ревизия этапа 3, C3)', async () => {
    /**
     * Карточка остаётся в чате навсегда. «Сделано» на вчерашней карточке
     * уже закрытого дела переписывало дату закрытия на сегодня — и
     * вечерний итог считал его заново; «Отложить» на убранном воскрешало
     * его в отложенные.
     */
    const { bot, calls } = createTestBot();
    await bot.init();

    const closedAt = new Date('2026-09-01T10:00:00.000Z');
    const doneId = await addItem({ owner: userId, text: 'к врачу', topic: 'личное' });
    await testDb()
      .update(items)
      .set({ status: 'done', completedAt: closedAt })
      .where(eq(items.id, doneId));
    const removedId = await addItem({ owner: userId, text: 'марафон', topic: 'личное' });
    await testDb().update(items).set({ status: 'cancelled' }).where(eq(items.id, removedId));

    await bot.handleUpdate(callbackUpdate(`i:done:${toShortId(doneId)}`));
    expect(textOf(lastEdit(calls))).toBe(
      defaultTexts.card.closed(defaultTexts.card.statusName('done')),
    );
    expect((await itemRow(doneId))?.completedAt?.toISOString()).toBe(closedAt.toISOString());

    await bot.handleUpdate(callbackUpdate(`i:snz:${toShortId(removedId)}`));
    expect(textOf(lastEdit(calls))).toBe(
      defaultTexts.card.closed(defaultTexts.card.statusName('cancelled')),
    );
    expect((await itemRow(removedId))?.status).toBe('cancelled');

    await bot.handleUpdate(callbackUpdate(`i:rm:${toShortId(doneId)}`));
    expect((await itemRow(doneId))?.status).toBe('done');

    expect(await revisionsOf(doneId)).toHaveLength(0);
    expect(await revisionsOf(removedId)).toHaveLength(0);
  });

  it('«Изменить» просит написать текст и не съедает карточку', async () => {
    /**
     * §7 ТЗ строит правку на речи. Учить человека формам вместо разговора
     * значит идти против продукта.
     *
     * **Подсказка приходила правкой сообщения и стирала клавиатуру** —
     * при том что сама говорит «кнопками рядом». Нажатие, которое ничего
     * не меняет, отнимало у человека экран. Найдено ручной проверкой
     * 29.08.2026; здесь по-прежнему проверяется, что карточка на месте.
     *
     * **А с задачи 3.61 кнопка перестала быть заглушкой.** Она просит
     * написать новый текст дела — отдельным сообщением, чтобы карточка
     * осталась, — и запоминает, чего ждёт.
     */
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem({ owner: userId, text: 'к врачу', topic: 'личное' });

    await bot.handleUpdate(callbackUpdate(`i:edt:${toShortId(itemId)}`));

    const asked = calls.filter((call) => call.method === 'sendMessage').at(-1);
    expect(textOf(asked)).toBe(defaultTexts.card.editHint);

    // Ни одной правки сообщения: карточка с кнопками осталась как была.
    expect(calls.filter((call) => call.method === 'editMessageText')).toHaveLength(0);
    expect((await itemRow(itemId))?.status).toBe('new');

    // И бот запомнил, чего ждёт: без этого следующая реплика человека
    // ушла бы в разбор, а не в правку.
    const [settings] = await testDb()
      .select({ awaiting: userSettings.awaitingInput })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));

    expect(settings?.awaiting).toBe(`edit:${itemId}`);
  });

  it('«Изменить» по исчезнувшей записи карточку как раз заменяет', async () => {
    // Обратная сторона правила: карточка несуществующей записи врёт, и
    // оставлять её на экране нельзя.
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem({ owner: userId, text: 'к врачу', topic: 'личное' });
    await testDb().delete(items).where(eq(items.id, itemId));

    await bot.handleUpdate(callbackUpdate(`i:edt:${toShortId(itemId)}`));

    const edited = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(textOf(edited)).toBe(defaultTexts.card.gone);
  });
});

describe('чужое по подобранному коду', () => {
  it('карточка чужой записи не открывается', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    const theirs = await addItem({ owner: otherUserId, text: 'чужое дело', topic: 'личное' });

    await bot.handleUpdate(callbackUpdate(`i:${toShortId(theirs)}`));

    const screen = textOf(calls.filter((call) => call.method === 'editMessageText').at(-1));
    expect(screen).toBe(defaultTexts.card.gone);
    expect(screen).not.toContain('чужое дело');
  });

  it('чужой статус по подобранному коду не меняется', async () => {
    // Самое важное здесь. Короткий идентификатор — сокращение, а не
    // секрет: его можно подделать.
    const { bot } = createTestBot();
    await bot.init();

    const theirs = await addItem({ owner: otherUserId, text: 'чужое дело', topic: 'личное' });

    for (const action of ['i:done:', 'i:snz:', 'i:rm:', 'i:edt:']) {
      await bot.handleUpdate(callbackUpdate(`${action}${toShortId(theirs)}`));
    }

    expect((await itemRow(theirs))?.status).toBe('new');
  });

  it('мусорный код отвечает «записи больше нет», а не падает', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate('i:done:AAAAAAAAAAAAAAAAAAAAAA'));

    expect(textOf(calls.filter((call) => call.method === 'editMessageText').at(-1))).toBe(
      defaultTexts.card.gone,
    );
  });
});

/**
 * «Оставить на потом» не стирает сводку (боевое 04.09.2026).
 *
 * Человек прислал голосовое на полторы минуты, бот разобрал семнадцать
 * записей и показал три дела, человек нажал «Оставить на потом» — и под
 * голосовым осталась одна строка «Всё на месте». Выглядело так, будто бот
 * не сделал ничего, и заказчик именно так это и прочёл.
 */
describe('«Оставить на потом» оставляет сводку на месте', () => {
  const summary = `Записала. На сегодня три дела:
— Помыть машину
— Позвонить стоматологу`;

  it('прощание дописывается под сводку, а не вместо неё', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(ANSWER_ACTION.later, TG_ID, summary));

    const edited = calls.filter((call) => call.method === 'editMessageText').at(-1);
    const text = textOf(edited);

    expect(text.startsWith(summary)).toBe(true);
    expect(text.endsWith(defaultTexts.answer.laterAccepted)).toBe(true);
  });

  it('клавиатура снимается: разговор закончен', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(ANSWER_ACTION.later, TG_ID, summary));

    const edited = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(keyboardOf(edited)).toEqual([]);
  });

  it('без текста у сообщения остаётся одно прощание', async () => {
    // Сообщение могло стать недоступным — тогда стирать нечего.
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(ANSWER_ACTION.later));

    const edited = calls.filter((call) => call.method === 'editMessageText').at(-1);
    expect(textOf(edited)).toBe(defaultTexts.answer.laterAccepted);
  });
});

describe('настройки §12.1: времена, пояс, сферы, имя', () => {
  /**
   * Строка §12.1 обещает четыре величины: «Темы, время напоминаний,
   * часовой пояс, выключатель напоминаний». До ревизии второго этапа
   * экран умел только последнюю: человек, выбравший на опросе 08:00, не
   * мог изменить время ничем — ни кнопкой, ни словами, — а пояс, который
   * ломает все сроки разом, правился только через разработчика.
   *
   * Проверки идут через настоящие обработчики и настоящую базу: связка
   * здесь и была дырой, а не сами служебные функции — они работали.
   */
  async function settingsRow() {
    const [row] = await testDb().select().from(userSettings).where(eq(userSettings.userId, userId));

    return row;
  }

  async function myTopics(): Promise<readonly string[]> {
    const rows = await testDb().select().from(topics).where(eq(topics.userId, userId));

    return rows.filter((one) => !one.isArchived).map((one) => one.name);
  }

  it('экран называет все четыре величины, а не одну', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();
    await addTopic(userId, 'работа');

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.settings));

    const screen = textOf(calls.at(-1));

    // Времена, пояс и сферы — то, чего на экране не было вовсе.
    expect(screen).toContain('08:30');
    expect(screen).toContain('Москва');
    expect(screen).toContain('работа');

    // И кнопки ко всем четырём, а не только к выключателям §11.
    const buttons = keyboardOf(calls.at(-1)).map((one) => one.text);

    expect(buttons).toContain(defaultTexts.settings.buttonMorning);
    expect(buttons).toContain(defaultTexts.settings.buttonEvening);
    expect(buttons).toContain(defaultTexts.settings.buttonCity);
    expect(buttons).toContain(defaultTexts.settings.buttonTopics);
  });

  it('утреннее время меняется кнопкой и видно новое значение', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.askMorning));
    await bot.handleUpdate(callbackUpdate(MENU_ACTION.morningPrefix + '09:00'));

    expect((await settingsRow())?.morningTime).toBe('09:00:00');

    // Человек должен увидеть, что стало, а не догадываться.
    expect(textOf(calls.at(-1))).toContain('09:00');
  });

  it('чужое время из подделанной кнопки не принимается', async () => {
    // callback_data не секретна: список времён закрытый, и значение
    // мимо него в базу попадать не должно.
    const { bot } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.morningPrefix + '03:33'));

    expect((await settingsRow())?.morningTime).toBe('08:30:00');
  });

  it('«не надо вечером» выключает вечернее и только его', async () => {
    const { bot } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.eveningOff));

    const row = await settingsRow();

    expect(row?.eveningOn).toBe(false);
    // Человек просил не писать вечером, а не молчать вовсе.
    expect(row?.notificationsOn).toBe(true);
  });

  it('город меняется кнопкой, и сроки при этом не пересчитываются', async () => {
    /**
     * Пересчёт положен только первому подтверждению пояса: тогда мы
     * угадали неверно. Человек, сменивший город в настройках, переехал —
     * сроки, которые он называл раньше, были верны в тот момент.
     */
    const { bot, calls } = createTestBot();
    await bot.init();

    const when = new Date(Date.UTC(2026, 8, 15, 9, 0, 0));
    const itemId = await addItem({
      owner: userId,
      text: 'к зубному',
      topic: 'здоровье',
      deadlineAt: when,
    });

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.askCity));
    await bot.handleUpdate(callbackUpdate(MENU_ACTION.cityPrefix + 'Asia/Omsk'));

    expect(textOf(calls.at(-1))).toContain('Омск');

    // Срок остался тем, который человек называл.
    expect((await itemRow(itemId))?.deadlineAt?.toISOString()).toBe(when.toISOString());
  });

  it('сферу можно добавить и убрать', async () => {
    const { bot } = createTestBot();
    await bot.init();
    await addTopic(userId, 'работа');

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.askTopics));
    await bot.handleUpdate(callbackUpdate(MENU_ACTION.topicSetPrefix + 'здоровье'));

    expect(await myTopics()).toContain('здоровье');

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.topicSetPrefix + 'здоровье'));

    expect(await myTopics()).not.toContain('здоровье');
  });

  it('снятая сфера не оставляет сирот: дела — в оставшуюся, ветка закрыта (ревизия этапа 3, E1)', async () => {
    /**
     * Онбординг на том же шаге переносил записи и закрывал ветку; меню
     * только архивировало тему. Пять дел из «здоровья» пропадали из
     * «Все задачи», ветка с закреплённой сводкой висела в чате навсегда,
     * а при возврате галочки бот заводил вторую такую же.
     */
    const gateway = new FakeTopicGateway();
    const { bot } = createTestBot(gateway);
    await bot.init();

    const homeId = await addTopic(userId, 'дом', true);
    const healthId = await addTopic(userId, 'здоровье');
    await testDb().update(topics).set({ tgThreadId: 777 }).where(eq(topics.id, healthId));
    const itemId = await addItem({ owner: userId, text: 'к зубному', topic: 'здоровье' });
    await testDb().update(items).set({ topicId: healthId }).where(eq(items.id, itemId));

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.askTopics));
    await bot.handleUpdate(callbackUpdate(MENU_ACTION.topicSetPrefix + 'здоровье'));

    expect(await myTopics()).toEqual(['дом']);

    const row = await itemRow(itemId);
    expect(row?.topic).toBe('дом');
    expect(row?.topicId).toBe(homeId);

    expect(gateway.deletedThreads.map((one) => one.threadId)).toEqual([777]);

    // Ни одной открытой записи в архивной теме — страж на будущее.
    const strays = await testDb()
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.topicId, healthId)));
    expect(strays).toEqual([]);
  });

  it('последнюю сферу убрать нельзя, и причина названа', async () => {
    // Классификация без списка не работает: записи ушли бы в никуда.
    const { bot, calls } = createTestBot();
    await bot.init();
    await addTopic(userId, 'работа');

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.topicSetPrefix + 'работа'));

    expect(await myTopics()).toEqual(['работа']);
    expect(textOf(calls.at(-1))).toBe(defaultTexts.settings.lastTopicKept);
  });

  it('снятие галочки не уносит в архив свои сферы человека', async () => {
    /**
     * `archiveTopicsExcept` убирает всё, чего нет в списке «оставить».
     * Значит темы, заведённые не из девяти предложенных, обязаны в него
     * попасть — иначе одна снятая галочка увозила бы в архив всё
     * остальное, что человек вёл.
     */
    const { bot } = createTestBot();
    await bot.init();
    await addTopic(userId, 'работа');
    await addTopic(userId, 'мотоцикл');

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.topicSetPrefix + 'работа'));

    const left = await myTopics();

    expect(left).not.toContain('работа');
    expect(left).toContain('мотоцикл');
  });

  it('«Имя» ждёт ответа словами — и своим видом ожидания', async () => {
    /**
     * Вид ожидания свой, а не опросный: ответ на опросе двигает опрос
     * дальше, а человек, поправивший имя через месяц, не должен снова
     * оказаться в знакомстве.
     */
    const { bot } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.askName));

    expect((await settingsRow())?.awaitingInput).toBe('set:name');
  });
});

describe('проекты в меню (§12.1: список, контекст и ближайший шаг)', () => {
  /**
   * Разложение на шаги, ближайший шаг и его закрытие работали с третьего
   * этапа. Не было экрана: попасть к ним человек мог только речью — если
   * догадается спросить. §12.1 просит пункт меню прямо, а страж вдобавок
   * требовал его отсутствия.
   */
  async function addProject(owner: string, text: string): Promise<string> {
    const [row] = await testDb()
      .insert(items)
      .values({
        userId: owner,
        text,
        type: 'TASK',
        priority: 'SOON',
        topic: 'личное',
        sourceOrder: 0,
        isProject: true,
      })
      .returning({ id: items.id });

    return row!.id;
  }

  async function addStep(
    owner: string,
    itemId: string,
    text: string,
    position: number,
    done = false,
  ): Promise<void> {
    await testDb()
      .insert(projectSteps)
      .values({
        itemId,
        userId: owner,
        text,
        position,
        doneAt: done ? new Date() : null,
      });
  }

  it('пункт меню есть, и он ведёт к списку целей', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();
    await addProject(userId, 'день рождения сына');

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.projects));

    expect(textOf(calls.at(-1))).toBe(defaultTexts.menu.projectsTitle);
    expect(keyboardOf(calls.at(-1)).map((one) => one.text)).toContain('день рождения сына');
  });

  it('внутри цели видно контекст и ближайший шаг с кнопкой', async () => {
    /**
     * §12.1 просит «внутри контекст и ближайший шаг». Текст собирает та
     * же функция, которой бот отвечает на вопрос словами: две сборки
     * дали бы человеку две разные правды об одной цели.
     */
    const { bot, calls } = createTestBot();
    await bot.init();

    const projectId = await addProject(userId, 'день рождения сына');
    await addStep(userId, projectId, 'выбрать кафе', 1, true);
    await addStep(userId, projectId, 'позвать гостей', 2);

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.projectPrefix + toShortId(projectId)));

    const screen = textOf(calls.at(-1));

    // Что сделано, что осталось и что дальше — всё три.
    expect(screen).toContain('выбрать кафе');
    expect(screen).toContain('позвать гостей');
    expect(screen).toContain(defaultTexts.project.doneHeader);

    // И кнопка закрыть ближайший шаг: без неё «Сделано» не наполнится.
    expect(keyboardOf(calls.at(-1)).map((one) => one.text)).toContain(
      defaultTexts.project.buttonStepDone,
    );
  });

  it('чужая цель по подобранному коду не открывается', async () => {
    // Короткий код в callback_data не секретный: владелец проверяется
    // запросом, как и у карточки записи.
    const { bot, calls } = createTestBot();
    await bot.init();

    const alien = await addProject(otherUserId, 'чужая цель');
    const before = calls.length;

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.projectPrefix + toShortId(alien)));

    const shown = calls
      .slice(before)
      .filter((call) => call.method === 'editMessageText' || call.method === 'sendMessage');

    expect(shown).toHaveLength(0);
  });

  it('целей нет — сказано словами, а не пустым списком', async () => {
    // Пустой экран человек читает как поломку; здесь он читает подсказку.
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.projects));

    expect(textOf(calls.at(-1))).toBe(defaultTexts.menu.noProjects);
  });

  it('обычная запись в список целей не попадает', async () => {
    // Иначе «Большие цели» станут вторым списком всех задач.
    const { bot, calls } = createTestBot();
    await bot.init();

    await addItem({ owner: userId, text: 'купить хлеб', topic: 'покупки' });
    await addProject(userId, 'день рождения сына');

    await bot.handleUpdate(callbackUpdate(MENU_ACTION.projects));

    const labels = keyboardOf(calls.at(-1)).map((one) => one.text);

    expect(labels).toContain('день рождения сына');
    expect(labels).not.toContain('купить хлеб');
  });
});

/**
 * §8.2 дословно: «Если запись меняет тему, бот переносит её и обновляет
 * сводки обеих веток».
 *
 * Половины были готовы с задачи 2.15 и не были связаны: `moveItemToTopic`
 * жила покрытой пятью тестами и не звалась ниоткуда. Поэтому страж стоит
 * на связке целиком — от нажатия до обеих веток, — а не на службе
 * переноса: её тесты были зелёными всё это время и о разрыве не знали.
 */
describe('«В другую сферу» переносит запись и обновляет обе ветки (§8.2)', () => {
  it('дело меняет сферу, и сводки обеих веток переписаны', async () => {
    const gateway = new FakeTopicGateway();
    const { bot, calls } = createTestBot(gateway);

    await addTopic(userId, 'здоровье');
    await addTopic(userId, 'покупки');

    const id = await addItem({ owner: userId, text: 'Купить витамины', topic: 'здоровье' });
    const code = toShortId(id);

    // Экран выбора: нынешней сферы в нём нет — перенос в неё же не перенос.
    await bot.handleUpdate(callbackUpdate(`${CARD_ACTION.move}${code}`));

    const choices = keyboardOf(calls.at(-1));
    expect(choices.map((one) => one.text)).toEqual(['покупки', 'Назад']);

    const to = choices[0]?.callback_data ?? '';
    expect(to.startsWith(CARD_ACTION.moveTo)).toBe(true);

    const writesBefore = gateway.writes;
    await bot.handleUpdate(callbackUpdate(to));

    // Запись переехала — и ссылка, и название.
    const row = await itemRow(id);
    expect(row?.topic).toBe('покупки');
    expect(row?.topicId).not.toBeNull();

    expect(textOf(calls.at(-1))).toContain('покупки');

    // И обе ветки переписаны, а не одна: §8.2 требует обеих.
    expect(
      gateway.writes - writesBefore,
      'сводку обновили не в обеих ветках',
    ).toBeGreaterThanOrEqual(2);
  });

  it('чужую запись переложить нельзя', async () => {
    const { bot, calls } = createTestBot();

    await addTopic(userId, 'здоровье');
    await addTopic(userId, 'покупки');

    const stranger = await addItem({
      owner: otherUserId,
      text: 'Чужое дело',
      topic: 'здоровье',
    });

    await bot.handleUpdate(callbackUpdate(`${CARD_ACTION.move}${toShortId(stranger)}`));

    // Код в кнопке не секрет: он приходит снаружи и подделывается. Без
    // проверки владельца чужая запись переезжала бы по подобранному коду.
    expect(textOf(calls.at(-1))).toBe(defaultTexts.card.gone);

    const row = await itemRow(stranger);
    expect(row?.topic).toBe('здоровье');
  });

  it('переложить в чужую сферу нельзя', async () => {
    const { bot, calls } = createTestBot();

    await addTopic(userId, 'здоровье');
    const alien = await addTopic(otherUserId, 'чужая сфера');

    const id = await addItem({ owner: userId, text: 'Купить витамины', topic: 'здоровье' });

    await bot.handleUpdate(
      callbackUpdate(`${CARD_ACTION.moveTo}${toShortId(id)}:${toShortId(alien)}`),
    );

    expect(textOf(calls.at(-1))).toBe(defaultTexts.card.moveNoTopic);

    // §6.4: тема, которой у человека нет, не должна возникнуть от переноса.
    const row = await itemRow(id);
    expect(row?.topic).toBe('здоровье');
  });

  it('одна сфера — экран говорит об этом, а не показывает пустоту', async () => {
    const { bot, calls } = createTestBot();

    await addTopic(userId, 'здоровье');
    const id = await addItem({ owner: userId, text: 'Купить витамины', topic: 'здоровье' });

    await bot.handleUpdate(callbackUpdate(`${CARD_ACTION.move}${toShortId(id)}`));

    expect(textOf(calls.at(-1))).toBe(defaultTexts.card.moveNoTopics);

    // Тупика быть не должно: назад в карточку.
    expect(keyboardOf(calls.at(-1)).map((one) => one.text)).toEqual(['Назад']);
  });
});
