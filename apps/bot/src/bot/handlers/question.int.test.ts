import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, type Item } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import type { AiClientDeps } from '../../modules/ai/client.js';
import { MockLlmProvider } from '../../modules/ai/providers/mock.js';
import { PromptRegistry } from '../../modules/ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../../modules/ai/prompts/seed.js';
import { CLASSIFIER_SCHEMA_NAME } from '../../modules/ai/schemas/index.js';
import { askQuestion } from '../../modules/resolver/questions.repo.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { defaultTexts } from '../../texts/index.js';
import { toShortId } from '../short-id.js';
import { QUESTION_ACTION, questionMessage, registerQuestionHandlers } from './question.js';

/**
 * Две кнопки уточняющего вопроса через настоящий обработчик (задача 3.5).
 *
 * §7.3 обещает человеку, что оба ответа что-то делают: «Добавить к
 * прошлой» правит найденную запись, «Это новое» заводит отдельную. Здесь
 * проверяется именно это, а не то, что кнопки нарисовались.
 */

const logger = createLogger({ level: 'silent' });
const TG_ID = 5252;

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

let userId = '';
let batchId = '';
let item: Item;
let seq = 0;

/** Классификация подменена: разбор проверен своими тестами. */
function classifierSaying(text: string): AiClientDeps {
  return {
    db: testDb(),
    provider: new MockLlmProvider({
      respond: () =>
        JSON.stringify({
          items: [
            {
              text,
              type: 'TASK',
              priority: 'SOON',
              topic: 'здоровье',
              isProject: false,
              deadline: '',
              deadlineAccuracy: 'none',
              recurrenceKind: 'none',
              recurrenceInterval: 0,
              recurrenceText: '',
            },
          ],
        }),
    }),
    prompts: new PromptRegistry(testDb()),
    retry: { attempts: 1, sleep: () => Promise.resolve() },
  };
}

function createTestBot(ai: AiClientDeps): { bot: Bot; calls: ApiCall[] } {
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

  registerQuestionHandlers(bot, { db: testDb(), ai, logger });
  return { bot, calls };
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
      message: { message_id: 1, date: 0, chat: { id: TG_ID, type: 'private' } },
    },
  } as unknown as Update;
}

function edits(calls: readonly ApiCall[]): string[] {
  return calls
    .filter((call) => call.method === 'editMessageText')
    .map((call) => String(call.payload['text']));
}

async function ask(): Promise<string> {
  const question = await askQuestion(testDb(), {
    userId,
    itemId: item.id,
    batchId,
    segment: 'нет, в пятницу',
    action: 'update',
    changes: { text: '', deadline: '2026-09-04', deadlineAccuracy: 'day' },
  });

  return question.id;
}

beforeEach(async () => {
  seq++;
  userId = (await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Аня' })).id;

  await seedPrompt(testDb(), {
    stage: 'classifier',
    version: 'classifier@test',
    prompt: 'разложи',
    schemaName: CLASSIFIER_SCHEMA_NAME,
  });
  await activatePrompt(testDb(), 'classifier', 'classifier@test');

  const [batch] = await testDb()
    .insert(batches)
    .values({ userId, status: 'processing' })
    .returning({ id: batches.id });

  batchId = batch?.id ?? '';

  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: 'Записать сына к врачу в четверг',
      type: 'TASK',
      priority: 'SOON',
      topic: 'здоровье',
    })
    .returning();

  if (!row) throw new Error('запись не создалась');
  item = row;
});

describe('текст вопроса', () => {
  it('называет запись, о которой спрашивает (§7.3)', () => {
    // «Это про прошлое или новое?» без названия заставляет человека
    // вспоминать, о чём вообще речь.
    const message = questionMessage(
      '11111111-1111-4111-8111-111111111111',
      'запись к врачу',
      defaultTexts,
    );

    expect(message.text).toContain('запись к врачу');
    expect(message.keyboard.inline_keyboard[0]).toHaveLength(2);
  });
});

describe('«Добавить к прошлой»', () => {
  it('правит найденную запись и даёт кнопку отмены', async () => {
    const questionId = await ask();

    const { bot, calls } = createTestBot(classifierSaying('неважно'));
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${QUESTION_ACTION.attach}${toShortId(questionId)}`));

    const [after] = await testDb().select().from(items).where(eq(items.id, item.id));
    expect(after?.deadlineAt?.toISOString()).toBe('2026-09-03T21:00:00.000Z');

    // §7.3: показать, что именно изменилось, и дать кнопку отмены.
    const edit = calls.find((call) => call.method === 'editMessageText');
    expect(String(edit?.payload['text'])).toContain('04.09');
    expect(edit?.payload['reply_markup']).toBeDefined();
  });

  it('второе нажатие отвечает «неактуально»', async () => {
    const questionId = await ask();
    const data = `${QUESTION_ACTION.attach}${toShortId(questionId)}`;

    const { bot, calls } = createTestBot(classifierSaying('неважно'));
    await bot.init();
    await bot.handleUpdate(callbackUpdate(data));
    await bot.handleUpdate(callbackUpdate(data));

    expect(edits(calls).at(-1)).toBe(defaultTexts.resolver.questionStale);
  });
});

describe('«Это новое»', () => {
  it('заводит отдельную запись из сказанного', async () => {
    const questionId = await ask();

    const { bot, calls } = createTestBot(classifierSaying('Позвонить в пятницу'));
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${QUESTION_ACTION.separate}${toShortId(questionId)}`));

    expect(edits(calls)).toEqual([defaultTexts.resolver.separated]);

    const rows = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(rows.map((row) => row.text).sort()).toEqual([
      'Записать сына к врачу в четверг',
      'Позвонить в пятницу',
    ]);
  });

  it('найденную запись не трогает', async () => {
    const questionId = await ask();

    const { bot } = createTestBot(classifierSaying('Позвонить в пятницу'));
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${QUESTION_ACTION.separate}${toShortId(questionId)}`));

    const [after] = await testDb().select().from(items).where(eq(items.id, item.id));
    expect(after?.deadlineAt).toBeNull();
  });

  it('сегмент не теряется, даже если разобрать не вышло (§9.1)', async () => {
    const questionId = await ask();

    const broken: AiClientDeps = {
      db: testDb(),
      provider: new MockLlmProvider({ respond: () => 'не json' }),
      prompts: new PromptRegistry(testDb()),
      retry: { attempts: 1, sleep: () => Promise.resolve() },
    };

    const { bot } = createTestBot(broken);
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${QUESTION_ACTION.separate}${toShortId(questionId)}`));

    const drafts = await testDb().select().from(items).where(eq(items.isDraft, true));
    expect(drafts.map((row) => row.text)).toContain('нет, в пятницу');
  });
});
