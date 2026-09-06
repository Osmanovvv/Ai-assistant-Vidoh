import { eq, isNull } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, projectSteps, type Item } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { defaultTexts } from '../../texts/index.js';
import { toShortId } from '../../modules/shared/short-id.js';
import { PROJECT_ACTION } from '../../modules/projects/project-actions.js';
import { contextOf } from '../../modules/projects/projects.service.js';
import { describeProject } from '../../modules/projects/project-text.js';
import { registerProjectHandlers } from './project.js';

/**
 * «Шаг сделан» (§21 п.6 ТЗ, задача 3.82).
 *
 * **Дефект, который эти тесты закрывают.** `completeStep` не звала ни
 * одна кнопка бота: `projectSteps.doneAt` оставался пустым всегда,
 * «ближайший шаг» был вечно первым, а раздел «Сделано» в ответе о
 * проекте не мог наполниться никогда. Три реплики про закрытие шага
 * лежали в текстах без единого читателя.
 *
 * Проверяется последствие в базе, а не текст реплики: кнопка, которая
 * только меняет сообщение, — тот же дефект, но незаметный.
 */

const logger = createLogger({ level: 'silent' });
const TG_ID = 7788;

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

  registerProjectHandlers(bot, testDb(), logger);
  return { bot, calls };
}

function callbackUpdate(data: string): Update {
  seq += 1;

  return {
    update_id: 820_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: TG_ID, is_bot: false, first_name: 'Аня' },
      chat_instance: 'test',
      data,
      message: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
    },
  } as unknown as Update;
}

const edits = (calls: readonly ApiCall[]): string[] =>
  calls
    .filter((call) => call.method === 'editMessageText')
    .map((call) => String(call.payload['text']));

const keyboardOf = (calls: readonly ApiCall[]): string[] => {
  const last = calls.filter((call) => call.method === 'editMessageText').at(-1);
  const markup = last?.payload['reply_markup'] as
    { inline_keyboard?: { text: string }[][] } | undefined;

  return (markup?.inline_keyboard ?? []).flat().map((button) => button.text);
};

/** Проект с тремя шагами: как их кладёт разложение. */
async function sowProject(): Promise<{ item: Item; stepIds: string[] }> {
  const [item] = await testDb()
    .insert(items)
    .values({
      userId,
      text: 'День рождения дочки',
      type: 'TASK',
      priority: 'SOON',
      topic: 'семья',
      isProject: true,
    })
    .returning();

  if (!item) throw new Error('проект не создался');

  const steps = await testDb()
    .insert(projectSteps)
    .values(
      ['Позвонить в кафе', 'Позвать гостей', 'Купить торт'].map((text, position) => ({
        itemId: item.id,
        userId,
        text,
        position,
      })),
    )
    .returning();

  return { item, stepIds: steps.map((step) => step.id) };
}

/** Нажатие по кнопке шага. */
const press = (stepId: string | undefined): Update =>
  callbackUpdate(`${PROJECT_ACTION.stepDone}${toShortId(stepId ?? '')}`);

beforeEach(async () => {
  userId = (await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' })).id;
  await testDb().delete(items).where(eq(items.userId, userId));
});

describe('«Шаг сделан»', () => {
  it('закрывает шаг в базе и называет следующий', async () => {
    const { stepIds } = await sowProject();
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(press(stepIds[0]));

    const [closed] = await testDb()
      .select()
      .from(projectSteps)
      .where(eq(projectSteps.id, stepIds[0] ?? ''));

    // Главное: последствие в базе. Без него «Отметила» — обман.
    expect(closed?.doneAt).not.toBeNull();
    expect(edits(calls).at(-1)).toBe(defaultTexts.project.stepDone('Позвать гостей'));

    // И кнопка следующему шагу: иначе закрыть проект вышло бы один раз.
    expect(keyboardOf(calls)).toEqual([defaultTexts.project.buttonStepDone]);
  });

  it('после закрытия шага ответ о проекте показывает «Сделано»', async () => {
    const { item, stepIds } = await sowProject();
    const { bot } = createTestBot();
    await bot.init();

    await bot.handleUpdate(press(stepIds[0]));

    const text = describeProject(item, await contextOf(testDb(), item.id), defaultTexts);

    /**
     * §21 п.6 обещает показать, что уже решено. До задачи 3.82 этот
     * раздел был пуст всегда: закрыть шаг было нечем.
     */
    expect(text).toContain(defaultTexts.project.doneHeader);
    expect(text).toContain('Позвонить в кафе');
    expect(text).toContain(defaultTexts.project.nextStep('Позвать гостей'));
  });

  it('последний шаг закрывает проект — и кнопки больше нет', async () => {
    const { stepIds } = await sowProject();
    const { bot, calls } = createTestBot();
    await bot.init();

    for (const stepId of stepIds) {
      await bot.handleUpdate(press(stepId));
    }

    const open = await testDb().select().from(projectSteps).where(isNull(projectSteps.doneAt));

    expect(open).toHaveLength(0);
    expect(edits(calls).at(-1)).toBe(defaultTexts.project.allStepsDone);
    expect(keyboardOf(calls)).toEqual([]);
  });

  it('повторное нажатие по кнопке из переписки отвечает то же, а не молчит', async () => {
    const { stepIds } = await sowProject();
    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(press(stepIds[0]));
    await bot.handleUpdate(press(stepIds[0]));

    // Кнопки остаются в чате навсегда; сломанной она выглядеть не должна.
    expect(edits(calls).at(-1)).toBe(defaultTexts.project.stepDone('Позвать гостей'));
  });

  it('чужой шаг по подобранному коду не закрывается', async () => {
    const { stepIds } = await sowProject();

    const stranger = await upsertUser(testDb(), { tgId: TG_ID + 1, firstName: 'Не Аня' });
    const [foreign] = await testDb()
      .insert(items)
      .values({
        userId: stranger.id,
        text: 'Чужой проект',
        type: 'TASK',
        priority: 'SOON',
        topic: 'личное',
        isProject: true,
      })
      .returning();

    if (!foreign) throw new Error('чужой проект не создался');

    const [foreignStep] = await testDb()
      .insert(projectSteps)
      .values({ itemId: foreign.id, userId: stranger.id, text: 'Чужой шаг', position: 0 })
      .returning();

    if (!foreignStep) throw new Error('чужой шаг не создался');

    const { bot, calls } = createTestBot();
    await bot.init();

    await bot.handleUpdate(press(foreignStep.id));

    const [untouched] = await testDb()
      .select()
      .from(projectSteps)
      .where(eq(projectSteps.id, foreignStep.id));

    expect(untouched?.doneAt).toBeNull();
    expect(edits(calls).at(-1)).toBe(defaultTexts.card.gone);

    // Свой шаг при этом закрывается: проверка про владельца, не про код.
    await bot.handleUpdate(press(stepIds[0]));

    const [mine] = await testDb()
      .select()
      .from(projectSteps)
      .where(eq(projectSteps.id, stepIds[0] ?? ''));

    expect(mine?.doneAt).not.toBeNull();
  });
});
