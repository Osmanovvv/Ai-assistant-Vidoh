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
import { toShortId } from '../../modules/shared/short-id.js';
import { QUESTION_ACTION } from '../../modules/resolver/change-text.js';
import { questionMessage, registerQuestionHandlers } from './question.js';

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
              deadlineText: '',
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

/**
 * Завтрашний день в поясе Москвы, строкой `ГГГГ-ММ-ДД`.
 *
 * **Дата считается, а не пишется руками.** Здесь стояло `2026-09-04`, и
 * 05.09.2026 тест покраснел сам собой: срок стал прошлым, а прошлые сроки
 * страж отбрасывает намеренно — «человек не ставит задачи на вчера»
 * (`dates.ts`, задача 2.7). Обработчик нажатия времени не принимает, и
 * подменить «сейчас» в нём нельзя, поэтому дату двигает тест.
 *
 * Завтра, а не сегодня: у сегодняшнего срока полночь уже прошла бы,
 * попади прогон на конец суток.
 */
function tomorrowInMoscow(): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));

  // Формат `sv-SE` и есть `ГГГГ-ММ-ДД` — тот же, что ждёт разбор срока.
  return parts;
}

async function ask(): Promise<string> {
  const question = await askQuestion(testDb(), {
    userId,
    itemId: item.id,
    batchId,
    segment: 'нет, в пятницу',
    action: 'update',
    changes: {
      note: '',
      text: '',
      deadline: tomorrowInMoscow(),
      deadlineAccuracy: 'day',
      recurrenceKind: 'none',
      recurrenceInterval: 0,
      recurrenceText: '',
    },
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

    /**
     * Кнопок две — как требует §7.3. Раньше здесь стояло «две кнопки в
     * первой строке», и это оказалось лишним: «Добавить к прошлой» — это
     * восемнадцать знаков, и рядом с «Это новое» на телефоне подпись
     * обрезалась. Теперь раскладка разводит их по строкам, а требование
     * ТЗ — про число кнопок, а не про число строк.
     */
    expect(message.keyboard.inline_keyboard.flat()).toHaveLength(2);
    expect(message.keyboard.inline_keyboard.flat().map((one) => one.text)).toEqual([
      defaultTexts.resolver.buttonAttach,
      defaultTexts.resolver.buttonSeparate,
    ]);
  });
});

describe('«Добавить к прошлой»', () => {
  it('правит найденную запись и даёт кнопку отмены', async () => {
    const questionId = await ask();

    const { bot, calls } = createTestBot(classifierSaying('неважно'));
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${QUESTION_ACTION.attach}${toShortId(questionId)}`));

    const [after] = await testDb().select().from(items).where(eq(items.id, item.id));

    // Срок сверяется с той же посчитанной датой, а не с числом в коде.
    const expected = tomorrowInMoscow();
    const actual = after?.deadlineAt;
    expect(actual).toBeDefined();
    expect(
      actual === null || actual === undefined
        ? ''
        : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(actual),
    ).toBe(expected);

    // §7.3: показать, что именно изменилось, и дать кнопку отмены.
    const [, month, day] = expected.split('-');
    const edit = calls.find((call) => call.method === 'editMessageText');
    expect(String(edit?.payload['text'])).toContain(`${day ?? ''}.${month ?? ''}`);
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
