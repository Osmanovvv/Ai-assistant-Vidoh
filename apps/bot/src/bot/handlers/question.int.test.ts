import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, type Item } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import type { AiClientDeps } from '../../modules/ai/client.js';
import { SpendCeilingError } from '../../infra/failures.js';
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

/**
 * Прошедшая пятница в поясе Москвы, строкой `ГГГГ-ММ-ДД`.
 *
 * **Ровно тот случай, ради которого писан пересчёт 3.65.** Человек
 * говорит «перенеси на пятницу», а модель отдаёт **ближайшую названную
 * пятницу от своего представления о сегодня** — и она регулярно
 * оказывается в прошлом. Прошлые сроки проверка §2.7 отбрасывает: без
 * пересчёта правка молча не применяется.
 */
function pastFridayInMoscow(): string {
  const now = new Date();
  const back = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Отходим назад до ближайшей пятницы, но не меньше суток от сегодня.
  while (back.getUTCDay() !== 5) back.setUTCDate(back.getUTCDate() - 1);

  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(back);
}

/** Ближайшая пятница впереди, в поясе Москвы, строкой `ГГГГ-ММ-ДД`. */
function nextFridayInMoscow(): string {
  /**
   * Считается **в московских сутках**, а не в UTC.
   *
   * Раньше шаг был по UTC, а сверка — по Москве, и с 21:00 UTC до
   * полуночи проверка ждала пятницу на неделю вперёд: московские сутки
   * там уже следующие. Найдено 07.09.2026 в два часа ночи — то есть
   * ровно в это окно; на CI это выпадало бы раз в сутки на три часа.
   */
  const moscow = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  // Полдень UTC: до края суток далеко в любую сторону, и шаг днями не
  // перескакивает дату из-за перевода часов.
  const at = new Date(`${moscow.format(new Date())}T12:00:00Z`);

  // Строго вперёд: «в пятницу», сказанное в пятницу, значит следующую.
  do {
    at.setUTCDate(at.getUTCDate() + 1);
  } while (at.getUTCDay() !== 5);

  return moscow.format(at);
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
    /**
     * **Ожидание переписано по смыслу 06.09.2026 (задача 3.82).**
     *
     * Здесь ждали завтрашнюю дату — ту, что вернула модель. Но человек
     * сказал «нет, **в пятницу**», а названный день недели правило 3.39
     * считает главнее даты модели: она видит своё «сегодня» и ошибается
     * в дне регулярно.
     *
     * Прежнее ожидание держалось на дефекте: кнопка не передавала слов
     * человека, пересчёт не работал, и дата модели проходила как есть.
     * Теперь правило действует, и ждать надо пятницу.
     */
    const questionId = await ask();

    const { bot, calls } = createTestBot(classifierSaying('неважно'));
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${QUESTION_ACTION.attach}${toShortId(questionId)}`));

    const [after] = await testDb().select().from(items).where(eq(items.id, item.id));

    // Срок сверяется с посчитанной датой, а не с числом в коде.
    const expected = nextFridayInMoscow();
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

  it('прошедшая пятница пересчитывается: это и была красная проверка сквозного', async () => {
    /**
     * **Задача 3.82.** Кнопка звала применение БЕЗ слов человека — и
     * пересчёт дня недели (3.65) на этом пути не работал вовсе. Человек
     * сказал «перенеси на пятницу», модель вернула прошедшую пятницу,
     * проверка §2.7 её отбросила, и правка не применилась ни к одной
     * записи. Бот при этом отвечал «Добавила к прошлой».
     *
     * Голосом тот же ответ работал — `pending.ts` слова передаёт. Два
     * пути разошлись молча, и нашлось это только на живом сквозном:
     * сценарий 2 давал 35 из 36.
     *
     * **Тест сюда просился ещё вчера, и я его ослабил.** 05.09 здесь
     * стояла дата, ставшая прошлой; вместо разбора причины я сдвинул её
     * в будущее — и случай, ради которого пересчёт написан, перестал
     * проверяться. Красным он был по делу.
     */
    const question = await askQuestion(testDb(), {
      userId,
      itemId: item.id,
      batchId,
      segment: 'перенеси на пятницу',
      action: 'update',
      changes: {
        note: '',
        text: '',
        // Прошедшая пятница — то, что модель отдаёт на самом деле.
        deadline: pastFridayInMoscow(),
        deadlineAccuracy: 'day',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
      },
    });

    const { bot } = createTestBot(classifierSaying('неважно'));
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${QUESTION_ACTION.attach}${toShortId(question.id)}`));

    const [after] = await testDb().select().from(items).where(eq(items.id, item.id));

    // Срок применён — и это ближайшая пятница ВПЕРЕДИ, а не позади.
    expect(after?.deadlineAt).not.toBeNull();

    const applied = after?.deadlineAt;
    expect(applied === null || applied === undefined ? 0 : applied.getTime()).toBeGreaterThan(
      Date.now() - 24 * 60 * 60 * 1000,
    );
    expect(applied?.getUTCDay() === 5 || applied?.getUTCDay() === 4).toBe(true);
  });

  it('вопрос про дополнение применяется дополнением, а не заменой', async () => {
    /**
     * **Задача 3.82, вторая половина.** Режима правки в таблице вопроса
     * не было вовсе, и оба ответа — кнопкой и голосом — применялись как
     * **замена**. Значит подробность из вопроса выбрасывалась: менять
     * оказывалось нечего, человек получал «Добавила к прошлой», а в
     * записи не появлялось ничего.
     *
     * §9.1 и §7.4 нарушались разом: слова пропадали, и реплика врала.
     * Случай не редкий — вопрос задаётся именно при двух похожих
     * записях, то есть в обстановке §21 п.5.
     */
    const question = await askQuestion(testDb(), {
      userId,
      itemId: item.id,
      batchId,
      segment: 'а ещё туда надо взять карту прививок',
      action: 'update',
      mode: 'append',
      changes: {
        note: 'взять карту прививок',
        text: '',
        deadline: '',
        deadlineAccuracy: 'none',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
      },
    });

    const { bot } = createTestBot(classifierSaying('неважно'));
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${QUESTION_ACTION.attach}${toShortId(question.id)}`));

    const [after] = await testDb().select().from(items).where(eq(items.id, item.id));

    // Подробность на месте, а заголовок не тронут — это и есть §7.4.
    expect(after?.body).toBe('взять карту прививок');
    expect(after?.text).toBe(item.text);
  });

  it('вопрос без режима применяется заменой — как было до правки', async () => {
    /**
     * Пусто означает «замена»: так вело себя применение раньше, и
     * вопросы, заданные до этой правки, обязаны дожить как жили.
     */
    const questionId = await ask();

    const { bot } = createTestBot(classifierSaying('неважно'));
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${QUESTION_ACTION.attach}${toShortId(questionId)}`));

    const [after] = await testDb().select().from(items).where(eq(items.id, item.id));

    // Срок применён заменой, подробности не появилось.
    expect(after?.deadlineAt).not.toBeNull();
    expect(after?.body).toBeNull();
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

  it('сегмент не теряется, даже если разбор СОРВАЛСЯ', async () => {
    /**
     * **Найдено встречной проверкой 06.09.2026 (задача 3.79).** Разбор
     * может не просто «не получиться», а броситься: модель недоступна,
     * потолок расхода перейдён, сеть моргнула. Тогда исключение уходило
     * в общий перехватчик бота, и человек не получал ничего: сообщение
     * не менялось, записи не появлялось, черновика тоже.
     *
     * А вопрос к этому моменту уже помечен отвеченным — второе нажатие
     * даёт «вопрос устарел». То есть отрезок выпадал из работы бота
     * навсегда, и это единственный путь, где остановка по потолку стоила
     * бы человеку сказанного.
     */
    const questionId = await ask();

    const falling: AiClientDeps = {
      db: testDb(),
      provider: new MockLlmProvider({
        respond: () => {
          throw new SpendCeilingError('потолок расхода за сутки перейдён');
        },
      }),
      prompts: new PromptRegistry(testDb()),
      retry: { attempts: 1, sleep: () => Promise.resolve() },
    };

    const { bot, calls } = createTestBot(falling);
    await bot.init();
    await bot.handleUpdate(callbackUpdate(`${QUESTION_ACTION.separate}${toShortId(questionId)}`));

    // Слова целы.
    const drafts = await testDb().select().from(items).where(eq(items.isDraft, true));
    expect(drafts.map((row) => row.text)).toContain('нет, в пятницу');

    // И человеку сказано, что не вышло, а не «завела отдельно».
    expect(edits(calls)).toEqual([defaultTexts.errors.generic]);
  });
});
