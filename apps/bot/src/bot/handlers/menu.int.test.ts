import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, topics } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { FakeTopicGateway } from '../../modules/topics/fake-gateway.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { toShortId } from '../../modules/shared/short-id.js';
import { registerCardHandlers } from './card.js';
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

  registerMenuHandlers(bot, testDb(), logger);
  registerCardHandlers(
    bot,
    { db: testDb(), logger, ...(gateway === undefined ? {} : { topics: gateway }) },
    MENU_ACTION.root,
  );

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

function callbackUpdate(data: string, from = TG_ID): Update {
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
      defaultTexts.menu.buttonAll,
      defaultTexts.menu.buttonToday,
      defaultTexts.menu.buttonHelp,
      defaultTexts.menu.buttonDeleteData,
    ]);
  });

  it('в меню нет кнопок, за которыми пока ничего нет', async () => {
    // §12.1 перечисляет девять пунктов, но «Проекты», «Настройки» и
    // «Подписка» приходят со своими задачами. Кнопка, которая обещает и
    // не выполняет, дороже отсутствующей.
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(commandUpdate('/menu'));
    const labels = keyboardOf(calls.find((call) => call.method === 'sendMessage')).map(
      (button) => button.text,
    );

    expect(labels).not.toContain('Проекты');
    expect(labels).not.toContain('Настройки');
    expect(labels).not.toContain('Подписка');
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

  it('«Сделано» меняет статус и обновляет сводку темы', async () => {
    const gateway = new FakeTopicGateway();
    const { bot, calls } = createTestBot(gateway);
    await bot.init();

    await addTopic(userId, 'здоровье');
    const itemId = await addItem({ owner: userId, text: 'к врачу', topic: 'здоровье' });

    await bot.handleUpdate(callbackUpdate(`i:done:${toShortId(itemId)}`));

    expect((await itemRow(itemId))?.status).toBe('done');
    expect(textOf(calls.filter((call) => call.method === 'editMessageText').at(-1))).toBe(
      defaultTexts.card.done,
    );
    // §8.2: запись ушла из темы, значит сводка изменилась.
    expect(gateway.sent).toHaveLength(1);
  });

  it('«Отложить» сдвигает срок вперёд, а не оставляет просроченным', async () => {
    // Иначе отложенное дело полезет в выдачу тем же вечером.
    const { bot } = createTestBot();
    await bot.init();

    const itemId = await addItem({
      owner: userId,
      text: 'к врачу',
      topic: 'личное',
      deadlineAt: new Date(Date.now() - 86_400_000),
    });

    await bot.handleUpdate(callbackUpdate(`i:snz:${toShortId(itemId)}`));

    const row = await itemRow(itemId);
    expect(row?.status).toBe('snoozed');
    expect(row?.deadlineAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
  });

  it('«Убрать» не удаляет запись физически (§13.5)', async () => {
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem({ owner: userId, text: 'марафон', topic: 'личное' });

    await bot.handleUpdate(callbackUpdate(`i:rm:${toShortId(itemId)}`));

    const row = await itemRow(itemId);
    expect(row).toBeDefined();
    expect(row?.status).toBe('cancelled');
    expect(textOf(calls.filter((call) => call.method === 'editMessageText').at(-1))).toBe(
      defaultTexts.card.deleted,
    );
  });

  it('«Изменить» подсказывает словами и не съедает карточку', async () => {
    // §7 ТЗ строит правку на речи. Учить человека формам вместо разговора
    // значит идти против продукта.
    //
    // **Подсказка приходила правкой сообщения и стирала клавиатуру** —
    // при том что сама говорит «кнопками рядом». Нажатие, которое ничего
    // не меняет, отнимало у человека экран. Найдено ручной проверкой
    // 29.08.2026; здесь проверяется, что карточка на месте.
    const { bot, calls } = createTestBot();
    await bot.init();

    const itemId = await addItem({ owner: userId, text: 'к врачу', topic: 'личное' });

    await bot.handleUpdate(callbackUpdate(`i:edt:${toShortId(itemId)}`));

    const answer = calls.filter((call) => call.method === 'answerCallbackQuery').at(-1);
    expect(textOf(answer)).toBe(defaultTexts.card.editHint);
    expect(answer?.payload['show_alert']).toBe(true);

    // Ни одной правки сообщения: карточка с кнопками осталась как была.
    expect(calls.filter((call) => call.method === 'editMessageText')).toHaveLength(0);
    expect((await itemRow(itemId))?.status).toBe('new');
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
