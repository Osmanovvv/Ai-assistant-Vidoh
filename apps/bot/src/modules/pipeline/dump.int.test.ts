import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  aiCalls,
  batches,
  items,
  messagesRaw,
  promptVersions,
  topics,
  users,
  userSettings,
  userState,
} from '../../db/schema.js';
import { RedisLock } from '../../infra/lock.js';
import { createRedis } from '../../infra/redis.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { PromptRegistry } from '../ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../ai/prompts/seed.js';
import { MockLlmProvider } from '../ai/providers/mock.js';
import type { CompletionRequest } from '../ai/providers/types.js';
import {
  CLASSIFIER_SCHEMA_NAME,
  EXTRACTOR_SCHEMA_NAME,
  PRESENTER_SCHEMA_NAME,
  ROUTER_SCHEMA_NAME,
} from '../ai/schemas/index.js';
import { attachMessageToBatch, closeBatchOnSilence } from '../buffer/buffer.service.js';
import { MockEmbeddingProvider } from '../embedder/providers/mock.js';
import { FakeTopicGateway } from '../topics/fake-gateway.js';
import { ensureThread } from '../topics/topics.service.js';
import { STEP } from '../onboarding/onboarding.service.js';
import { countQuestions } from '../presenter/presenter.service.js';
import type { StatusSender } from '../presenter/status.service.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import type { AudioLimits } from '../speech/audio.service.js';
import { run } from '../speech/ffmpeg.js';
import { MockSpeechProvider } from '../speech/providers/mock.js';
import { PermanentSpeechError, TransientSpeechError } from '../speech/providers/types.js';
import { createFailureReporter } from './failure-notice.js';
import { upsertUser } from '../users/users.repo.js';
import type { SpendLimit } from '../metering/limits.js';
import { createDumpHandler } from './dump.handler.js';
import { processUserBatches } from './pipeline.service.js';

/**
 * Разбор выгрузки целиком: настоящая база, настоящий ffmpeg, настоящий
 * замок. Подменены провайдеры — распознавания, языковой модели и
 * смысловых представлений: живые вызовы стоили бы денег и сделали бы
 * тесты недетерминированными.
 *
 * Это проверка связки, а не отдельных шагов: каждый из них покрыт своими
 * тестами. Здесь важно, что они соединены в правильном порядке и что
 * текст человека не теряется ни на одном обрыве.
 */

const redis: Redis = createRedis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379', {
  maxReconnectAttempts: 3,
});
const lock = new RedisLock(redis, 'test-dump:');

const pricing = { mock: { kind: 'audio', currency: 'usd', perMinute: 0.006 } } as const;

const T0 = new Date('2026-08-24T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

let fixtureDir = '';
let audioPath = '';
let userId: string;
let seq = 0;

/**
 * Промпты помечены словами-маркерами: подменённая модель по ним понимает,
 * какой этап её спрашивает. Настоящие тексты промптов лежат вне
 * репозитория, и тесту они не нужны.
 */
const MARKERS = {
  router: 'МАРШРУТ',
  extractor: 'ЕДИНИЦЫ',
  classifier: 'КЛАССЫ',
  presenter: 'ПРИЗНАНИЕ',
} as const;

type Stage = keyof typeof MARKERS;

function stageOf(request: CompletionRequest): Stage | undefined {
  for (const [stage, marker] of Object.entries(MARKERS)) {
    if (request.prompt.includes(marker)) return stage as Stage;
  }
  return undefined;
}

/** Единицы из входа классификации: «1. текст» построчно. */
function unitsFromInput(input: string): string[] {
  return input
    .split('\n')
    .map((line) => /^\d+\.\s*(?<text>.+)$/u.exec(line)?.groups?.['text'])
    .filter((text): text is string => text !== undefined);
}

/**
 * Модель-эхо: всё сказанное проходит цепочку насквозь.
 *
 * Так видно, что шаги соединены: заголовок дела в ответе — это текст,
 * который человек наговорил, а не выдумка теста.
 */
function echoingLlm(
  overrides: Partial<Record<Stage, string>> = {},
  /** Название модели: по нему в учёте видно, полная работала или лёгкая. */
  model?: string,
): MockLlmProvider {
  return new MockLlmProvider({
    ...(model === undefined ? {} : { model }),
    respond: (request) => {
      const stage = stageOf(request);
      if (stage === undefined) return '{}';

      const override = overrides[stage];
      if (override !== undefined) return override;

      switch (stage) {
        case 'router':
          return JSON.stringify({
            crisis: false,
            segments: [{ intent: 'DUMP', text: request.input }],
          });
        case 'extractor':
          return JSON.stringify({
            units: request.input
              .split('\n')
              .filter((line) => line.trim() !== '')
              .map((line) => ({ text: line, isProject: false, isEmotion: false })),
          });
        case 'classifier':
          return JSON.stringify({
            items: unitsFromInput(request.input).map((text) => ({
              text,
              type: 'TASK',
              priority: 'SOON',
              topic: 'личное',
              isProject: false,
              deadline: '',
              deadlineAccuracy: 'none',
              recurrenceKind: 'none',
              recurrenceInterval: 0,
              recurrenceText: '',
            })),
          });
        case 'presenter':
          return JSON.stringify({ acknowledgement: 'Я тебя услышала.' });
      }
    },
  });
}

async function seedPrompts(): Promise<PromptRegistry> {
  const stages = [
    { stage: 'router', schema: ROUTER_SCHEMA_NAME, marker: MARKERS.router },
    { stage: 'extractor', schema: EXTRACTOR_SCHEMA_NAME, marker: MARKERS.extractor },
    { stage: 'classifier', schema: CLASSIFIER_SCHEMA_NAME, marker: MARKERS.classifier },
    { stage: 'presenter', schema: PRESENTER_SCHEMA_NAME, marker: MARKERS.presenter },
  ] as const;

  for (const { stage, schema, marker } of stages) {
    await seedPrompt(testDb(), {
      stage,
      version: `${stage}@test`,
      prompt: marker,
      schemaName: schema,
    });
    await activatePrompt(testDb(), stage, `${stage}@test`);
  }

  return new PromptRegistry(testDb(), 60_000);
}

interface HandlerOptions {
  readonly speech: MockSpeechProvider;
  readonly topics?: FakeTopicGateway | undefined;
  readonly llm?: MockLlmProvider;
  /** Лёгкая модель: на неё переходят тяжёлые стадии при превышении лимита. */
  readonly llmLight?: MockLlmProvider | undefined;
  readonly spendLimit?: SpendLimit | undefined;
  readonly prompts: PromptRegistry;
  readonly sender?: StatusSender | undefined;
  /** Потолки аудио: нужны тесту на обрезку (§10.5 ТЗ). */
  readonly speechLimits?: AudioLimits | undefined;
  readonly embedder?: MockEmbeddingProvider | undefined;
  readonly onboarding?: QuestionSender | undefined;
  readonly now?: Date | undefined;
}

/** Считает заданные вопросы онбординга вместо обращений к Telegram. */
function recordingQuestions(): { sender: QuestionSender; asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    sender: {
      ask: ({ text }) => {
        asked.push(text);
        return Promise.resolve(2000 + asked.length);
      },
    },
  };
}

function handler(options: HandlerOptions) {
  return createDumpHandler({
    speech: {
      provider: options.speech,
      download,
      pricing,
      ...(options.speechLimits === undefined ? {} : { limits: options.speechLimits }),
    },
    ai: {
      provider: options.llm ?? echoingLlm(),
      prompts: options.prompts,
      retry: { attempts: 1, sleep: () => Promise.resolve() },
    },
    ...(options.llmLight === undefined
      ? {}
      : {
          aiLight: {
            provider: options.llmLight,
            prompts: options.prompts,
            retry: { attempts: 1, sleep: () => Promise.resolve() },
          },
        }),
    ...(options.spendLimit === undefined ? {} : { spendLimit: options.spendLimit }),
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    ...(options.sender === undefined ? {} : { sender: options.sender }),
    ...(options.onboarding === undefined ? {} : { onboarding: options.onboarding }),
    ...(options.topics === undefined ? {} : { topics: options.topics }),
    now: () => options.now ?? at(60_000),
  });
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'vydoh-dump-'));
  audioPath = join(fixtureDir, 'voice.wav');
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-t',
    '2',
    '-i',
    'sine=frequency=440:sample_rate=16000',
    '-ac',
    '1',
    '-ar',
    '16000',
    audioPath,
  ]);
}, 120_000);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
  await redis.quit();
});

beforeEach(async () => {
  const keys = await redis.keys('test-dump:*');
  if (keys.length > 0) await redis.del(...keys);

  await testDb().delete(promptVersions);

  const user = await upsertUser(testDb(), { tgId: 700, firstName: 'Аня' });
  userId = user.id;
  seq = 0;
});

/** Скачивание подменяется копированием готового файла. */
const download = async (_fileId: string, dest: string): Promise<void> => {
  await copyFile(audioPath, dest);
};

interface Incoming {
  readonly kind: 'text' | 'voice';
  readonly text?: string;
  readonly offsetMs: number;
  readonly transcript?: string;
  /** Сообщение пришло внутри ветки темы (§8.1). */
  readonly threadId?: number | undefined;
}

/** Кладёт сообщения в одну выгрузку и закрывает её по тишине. */
async function queuedBatchOf(messages: readonly Incoming[]): Promise<string> {
  let batchId = '';

  for (const message of messages) {
    seq++;
    const [row] = await testDb()
      .insert(messagesRaw)
      .values({
        userId,
        updateId: 7000 + seq,
        tgChatId: 700,
        tgMessageId: seq,
        kind: message.kind,
        text: message.text ?? null,
        tgThreadId: message.threadId ?? null,
        fileId: message.kind === 'voice' ? `voice-${String(seq)}` : null,
        audioDurationSec: message.kind === 'voice' ? 2 : null,
        transcript: message.transcript ?? null,
        receivedAt: at(message.offsetMs),
      })
      .returning({ id: messagesRaw.id });

    const attached = await attachMessageToBatch(testDb(), {
      userId,
      messageId: row!.id,
      now: at(message.offsetMs),
    });
    batchId = attached.batchId;
  }

  const last = messages.at(-1)?.offsetMs ?? 0;
  await closeBatchOnSilence(testDb(), batchId, { now: at(last + 31_000) });

  return batchId;
}

async function combinedTextOf(batchId: string): Promise<string | null> {
  const [row] = await testDb()
    .select({ text: batches.combinedText })
    .from(batches)
    .where(eq(batches.id, batchId));
  return row?.text ?? null;
}

describe('расшифровка внутри разбора', () => {
  it('расшифровывает голосовые и склеивает их с текстом в порядке получения', async () => {
    // §9.1 правило 2 ТЗ: серия сообщений — это одна мысль.
    const prompts = await seedPrompts();
    const batchId = await queuedBatchOf([
      { kind: 'voice', offsetMs: 0 },
      { kind: 'text', text: 'и ещё забрать вещи', offsetMs: 5_000 },
      { kind: 'voice', offsetMs: 10_000 },
    ]);

    const speech = new MockSpeechProvider({
      responses: ['записать сына к врачу', 'купить продукты'],
    });

    const result = await processUserBatches(
      { db: testDb(), lock, handleBatch: handler({ speech, prompts }) },
      userId,
    );

    expect(result.processed).toBe(1);
    expect(await combinedTextOf(batchId)).toBe(
      'записать сына к врачу\nи ещё забрать вещи\nкупить продукты',
    );
  });

  it('доводит выгрузку до состояния «готово»', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const speech = new MockSpeechProvider({ responses: ['текст'] });

    await processUserBatches(
      { db: testDb(), lock, handleBatch: handler({ speech, prompts }) },
      userId,
    );

    const [batch] = await testDb().select().from(batches);
    expect(batch?.status).toBe('done');
    expect(batch?.error).toBeNull();
  });

  it('убирает ссылку на аудио: §16 ТЗ запрещает хранить файл после обработки', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const speech = new MockSpeechProvider({ responses: ['текст'] });

    await processUserBatches(
      { db: testDb(), lock, handleBatch: handler({ speech, prompts }) },
      userId,
    );

    const [row] = await testDb().select().from(messagesRaw);
    expect(row?.transcript).toBe('текст');
    expect(row?.fileId).toBeNull();
  });

  it('не расшифровывает заново то, что уже расшифровано', async () => {
    // Повторный заход бывает после сбоя посреди выгрузки, и платить
    // за одну и ту же секунду дважды нельзя — это чужие деньги.
    const prompts = await seedPrompts();
    const batchId = await queuedBatchOf([
      { kind: 'voice', offsetMs: 0, transcript: 'уже расшифровано' },
      { kind: 'voice', offsetMs: 5_000 },
    ]);

    const speech = new MockSpeechProvider({ responses: ['новое'] });

    await processUserBatches(
      { db: testDb(), lock, handleBatch: handler({ speech, prompts }) },
      userId,
    );

    expect(speech.callCount).toBe(1);
    expect(await combinedTextOf(batchId)).toBe('уже расшифровано\nновое');
  });

  it('не трогает провайдера речи, если голосовых в выгрузке нет', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'просто текст', offsetMs: 0 }]);
    const speech = new MockSpeechProvider();

    await processUserBatches(
      { db: testDb(), lock, handleBatch: handler({ speech, prompts }) },
      userId,
    );

    expect(speech.callCount).toBe(0);
  });

  it('сбойную выгрузку помечает сбойной, а не теряет', async () => {
    // §9 ТЗ запрещает терять сообщения. Пропустить нерасшифрованное
    // голосовое и склеить остальное было бы тише, но молча съело бы
    // часть сказанного.
    const prompts = await seedPrompts();
    const batchId = await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);

    const speech = new MockSpeechProvider({
      failFirst: { times: 1, error: new PermanentSpeechError('битый файл') },
    });

    await expect(
      processUserBatches({ db: testDb(), lock, handleBatch: handler({ speech, prompts }) }, userId),
    ).rejects.toThrow(/битый файл/u);

    const [batch] = await testDb().select().from(batches).where(eq(batches.id, batchId));
    expect(batch?.status).toBe('failed');
    expect(batch?.error).toContain('битый файл');

    // Сообщение осталось на месте вместе со ссылкой на файл: выгрузку
    // можно перезапустить.
    const [row] = await testDb().select().from(messagesRaw);
    expect(row?.fileId).not.toBeNull();
  });
});

describe('разбор', () => {
  it('создаёт записи из сказанного и считает им векторы', async () => {
    const prompts = await seedPrompts();
    const batchId = await queuedBatchOf([
      { kind: 'text', text: 'записать сына к врачу', offsetMs: 0 },
      { kind: 'text', text: 'купить продукты', offsetMs: 1_000 },
    ]);

    const embedder = new MockEmbeddingProvider();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, embedder }),
      },
      userId,
    );

    const saved = await testDb().select().from(items).orderBy(asc(items.createdAt));
    expect(saved.map((item) => item.text)).toEqual(['записать сына к врачу', 'купить продукты']);
    expect(saved.every((item) => item.sourceBatchId === batchId)).toBe(true);
    expect(saved.every((item) => item.topic === 'личное')).toBe(true);
    expect(saved.every((item) => item.embedding !== null)).toBe(true);
    expect(saved.some((item) => item.isDraft)).toBe(false);
  });

  it('пишет расход на каждый этап: речь, намерения, единицы, классы, признание', async () => {
    // §10.5 ТЗ и инвариант 6. Без полного учёта себестоимость выгрузки
    // на задаче 2.21 окажется занижена.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const speech = new MockSpeechProvider({ responses: ['купить продукты'] });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech, prompts, embedder: new MockEmbeddingProvider() }),
      },
      userId,
    );

    const calls = await testDb().select().from(aiCalls);
    const stages = new Set(calls.map((call) => call.stage));

    expect(stages).toEqual(
      new Set(['speech', 'router', 'extractor', 'classifier', 'embedder', 'presenter']),
    );
    expect(calls.every((call) => call.ok)).toBe(true);
    expect(calls.every((call) => call.batchId !== null)).toBe(true);
  });

  it('правку сказанного откладывает черновиком, а не превращает в задачу', async () => {
    // §7 ТЗ: правка требует резолвера, а он приходит на третьем этапе.
    // Задача «хотя нет, в пятницу» была бы задачей без задачи.
    const prompts = await seedPrompts();
    await queuedBatchOf([
      { kind: 'text', text: 'записать сына к врачу в четверг, хотя нет, в пятницу', offsetMs: 0 },
    ]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'DUMP', text: 'записать сына к врачу в четверг' },
          { intent: 'PATCH', text: 'хотя нет, в пятницу' },
        ],
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm }),
      },
      userId,
    );

    const saved = await testDb().select().from(items).orderBy(asc(items.createdAt));
    const drafts = saved.filter((item) => item.isDraft);
    const parsed = saved.filter((item) => !item.isDraft);

    expect(parsed.map((item) => item.text)).toEqual(['записать сына к врачу в четверг']);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.text).toBe('хотя нет, в пятницу');
    expect(drafts[0]?.draftReason).toContain('PATCH');
  });

  it('на «привет» не разбирает ничего и отвечает коротко', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'привет', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'SMALLTALK', text: 'привет' }],
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    expect(await testDb().select().from(items)).toHaveLength(0);
    expect(all.at(-1)).toBe(defaultTexts.answer.nothingToParse);
  });

  it('сбой извлечения сохраняет текст черновиком и говорит об этом', async () => {
    // §17 ТЗ: терять текст нельзя, сохранить его неразобранным можно.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'надо продукты и врача', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    const llm = echoingLlm({ extractor: 'это не JSON' });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const saved = await testDb().select().from(items);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.isDraft).toBe(true);
    expect(saved[0]?.text).toBe('надо продукты и врача');
    expect(all.at(-1)).toBe(defaultTexts.answer.savedUnparsed);
  });

  it('обрезка договаривается человеку, а не остаётся в журнале', async () => {
    // §10.5 ТЗ требует предупреждения, и требует справедливо: человек
    // говорил двадцать пять минут, получал разбор первых двадцати и не
    // знал, что остальное потеряно. До 27.08.2026 обрезка уходила только
    // в лог — ровно тот разрыв «модуль есть, а наверх не отдаёт».
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const speech = new MockSpeechProvider({ responses: ['купить продукты'] });
    const { sender, all } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech,
          prompts,
          sender,
          // Запись длится две секунды, потолок — одна.
          speechLimits: { maxSegmentSec: 82, maxSingleDurationSec: 1 },
        }),
      },
      userId,
    );

    expect(all.at(-1)).toContain(defaultTexts.listening.tooLong);
  });

  it('сорвавшийся разбор говорит человеку, а не умирает молча', async () => {
    // §17 ТЗ. Сверка 28.08.2026: текст `errors.generic` лежал в словаре и
    // не вызывался ни разу. Человек видел «Секунду, слушаю запись» и
    // больше ничего, навсегда — сбойные выгрузки намеренно не
    // переподхватываются, а админки, из которой их перезапускают, не будет
    // до четвёртого этапа.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    const speech = new MockSpeechProvider({
      failFirst: { times: 99, error: new PermanentSpeechError('запись не разобрать') },
    });

    await expect(
      processUserBatches(
        {
          db: testDb(),
          lock,
          handleBatch: handler({ speech, prompts, sender }),
          onFailure: createFailureReporter({ db: testDb(), sender }),
        },
        userId,
      ),
    ).rejects.toThrow();

    // §17, первая строка: расшифровка не удалась — просим прислать текстом.
    expect(all.at(-1)).toBe(defaultTexts.errors.speechFailed);

    const [batch] = await testDb().select().from(batches);
    expect(batch?.status).toBe('failed');
  });

  it('о временном сбое говорят как о задержке, а не как о поражении', async () => {
    // Выгрузка вернулась в очередь: звать человека переделывать работу
    // значило бы заставить его заплатить дважды.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    const speech = new MockSpeechProvider({
      failFirst: { times: 99, error: new TransientSpeechError('распознаватель занят') },
    });

    await expect(
      processUserBatches(
        {
          db: testDb(),
          lock,
          handleBatch: handler({ speech, prompts, sender }),
          onFailure: createFailureReporter({ db: testDb(), sender }),
        },
        userId,
      ),
    ).rejects.toThrow();

    expect(all.at(-1)).toBe(defaultTexts.errors.delayed);

    const [batch] = await testDb().select().from(batches);
    expect(batch?.status).toBe('queued');
  });

  it('высказанное состояние снижает уровень сил и оставляет одно действие', async () => {
    // §13.7 ТЗ: эмоция влияет ровно на одно — на число действий в выдаче.
    //
    // Одно, а не два. Раньше здесь ожидалось два дела — по уровню «сил
    // мало», — и это противоречило ТЗ: §2 сценарий 7 и §21 п.7 говорят
    // «выдача сокращена до одного действия», §13.7 задаёт формулу
    // «признание, сокращение объёма, одно действие». Нашёл сквозной тест
    // этапа: модули были правы каждый по себе, требование не выполнял
    // никто.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'дела и усталость', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    const llm = echoingLlm({
      classifier: JSON.stringify({
        items: [
          ...['первое дело', 'второе дело', 'третье дело'].map((text) => ({
            text,
            type: 'TASK',
            priority: 'SOON',
            topic: 'личное',
            isProject: false,
            deadline: '',
            deadlineAccuracy: 'none',
            recurrenceKind: 'none',
            recurrenceInterval: 0,
            recurrenceText: '',
          })),
          {
            text: 'я ничего не успеваю',
            type: 'EMOTION',
            priority: 'NONE',
            topic: 'личное',
            isProject: false,
            deadline: '',
            deadlineAccuracy: 'none',
            recurrenceKind: 'none',
            recurrenceInterval: 0,
            recurrenceText: '',
          },
        ],
      }),
      presenter: JSON.stringify({ acknowledgement: 'Поняла. Сегодня тяжело.' }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const [state] = await testDb().select().from(userState);
    expect(state?.energy).toBe('low');

    // Дело ровно одно, и это первое сказанное, а не произвольное:
    // порядок внутри выгрузки сохранён.
    const reply = all.at(-1) ?? '';
    expect(reply).toContain('первое дело');
    expect(reply).not.toContain('второе дело');
    expect(reply).not.toContain('третье дело');
    // Уровень «сил мало» при этом остаётся уровнем: следующая выгрузка
    // того же дня получит свои два дела. Предел был на этот ответ.
    expect(reply).toContain(defaultTexts.answer.closingTired);
  });

  it('в выдачу идут и записи прошлых выгрузок, а не только новые', async () => {
    // §13.2 спрашивает «что взять на сегодня», а не «что ты сказала
    // последним»: срочное дело вчерашней выгрузки важнее нового «когда-нибудь».
    const prompts = await seedPrompts();

    await testDb()
      .insert(items)
      .values({
        userId,
        text: 'просроченное дело',
        type: 'TASK',
        priority: 'NOW',
        topic: 'личное',
        deadlineAt: at(-86_400_000),
        deadlineAccuracy: 'day',
      });

    await queuedBatchOf([{ kind: 'text', text: 'новое дело', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender }),
      },
      userId,
    );

    expect(all.at(-1)).toContain('просроченное дело');
  });
});

describe('онбординг после первой выгрузки', () => {
  it('первая разобранная выгрузка запускает опрос', async () => {
    // §12.2: онбординг идёт после первой выгрузки, не до неё. До этого
    // момента бот не задал ни одного вопроса — это проверяется в тестах
    // обработчиков.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'записать сына к врачу', offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    const questions = recordingQuestions();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          onboarding: questions.sender,
        }),
      },
      userId,
    );

    expect(questions.asked).toHaveLength(1);
    expect(questions.asked[0]).toContain('Аня');

    const [settings] = await testDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    expect(settings?.onboardingStep).toBe(STEP.name);

    // Свой вопрос ответ при этом не задал: его место занял первый вопрос
    // онбординга. Иначе у человека было бы два открытых вопроса подряд.
    const reply = all.at(-1) ?? '';
    expect(reply).toContain('записать сына к врачу');
    expect(reply).not.toContain(defaultTexts.answer.question);
    expect(countQuestions(reply)).toBe(0);
  });

  it('вторая выгрузка опрос не повторяет', async () => {
    const prompts = await seedPrompts();
    await testDb()
      .update(userSettings)
      .set({ onboardingStep: STEP.done })
      .where(eq(userSettings.userId, userId));

    await queuedBatchOf([{ kind: 'text', text: 'купить продукты', offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    const questions = recordingQuestions();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          onboarding: questions.sender,
        }),
      },
      userId,
    );

    expect(questions.asked).toHaveLength(0);
    // И свой вопрос вернулся на место.
    expect(all.at(-1)).toContain(defaultTexts.answer.question);
  });

  it('выгрузка без разбора опрос не запускает', async () => {
    // Спрашивать сферы жизни у человека, чья первая выгрузка оказалась
    // «привет», рано.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'привет', offsetMs: 0 }]);
    const questions = recordingQuestions();

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'SMALLTALK', text: 'привет' }],
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm,
          sender: recordingSender().sender,
          onboarding: questions.sender,
        }),
      },
      userId,
    );

    expect(questions.asked).toHaveLength(0);

    const [settings] = await testDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    expect(settings?.onboardingStep).toBe(0);
  });

  it('темы человека берутся из его списка, а не из базового набора', async () => {
    // §6.4: список тем создаётся онбордингом, и классификация обязана
    // работать по нему.
    const prompts = await seedPrompts();
    await testDb()
      .insert(topics)
      .values([
        { userId, name: 'дети', sortOrder: 0 },
        { userId, name: 'бизнес', sortOrder: 1, isDefault: true },
      ]);

    await queuedBatchOf([{ kind: 'text', text: 'дело', offsetMs: 0 }]);
    const llm = echoingLlm();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm }),
      },
      userId,
    );

    const classifierInput =
      llm.requests.find((request) => request.prompt.includes(MARKERS.classifier))?.input ?? '';

    expect(classifierInput).toContain('дети');
    expect(classifierInput).toContain('бизнес');
    expect(classifierInput).not.toContain('покупки');
  });
});

describe('ветки тем в разборе', () => {
  it('сообщение внутри ветки разбирается в контексте её темы (§8.1)', async () => {
    // Женщина, написавшая в ветку «здоровье», не должна получать дело в
    // «личном» только потому, что не назвала сферу словами.
    const prompts = await seedPrompts();
    const gateway = new FakeTopicGateway();

    await testDb()
      .insert(topics)
      .values([
        { userId, name: 'здоровье', sortOrder: 0 },
        { userId, name: 'личное', sortOrder: 1, isDefault: true },
      ]);

    const [health] = await testDb().select().from(topics).where(eq(topics.name, 'здоровье'));
    const thread = await ensureThread(
      { db: testDb(), gateway },
      { topicId: health!.id, chatId: 700 },
    );

    await queuedBatchOf([{ kind: 'text', text: 'дело', offsetMs: 0, threadId: thread.threadId }]);

    // Модель отдаёт тему, которой у человека нет: код обязан заменить её
    // темой по умолчанию, а по умолчанию здесь — тема ветки.
    const llm = echoingLlm({
      classifier: JSON.stringify({
        items: [
          {
            text: 'дело',
            type: 'TASK',
            priority: 'SOON',
            topic: 'выдуманная',
            isProject: false,
            deadline: '',
            deadlineAccuracy: 'none',
            recurrenceKind: 'none',
            recurrenceInterval: 0,
            recurrenceText: '',
          },
        ],
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm }),
      },
      userId,
    );

    const [saved] = await testDb().select().from(items).where(eq(items.isDraft, false));
    expect(saved?.topic).toBe('здоровье');
  });

  it('после разбора обновляются сводки затронутых тем, и только они', async () => {
    const prompts = await seedPrompts();
    const gateway = new FakeTopicGateway();

    await testDb()
      .insert(topics)
      .values([
        { userId, name: 'здоровье', sortOrder: 0 },
        { userId, name: 'покупки', sortOrder: 1 },
        { userId, name: 'личное', sortOrder: 2, isDefault: true },
      ]);

    await queuedBatchOf([{ kind: 'text', text: 'к врачу', offsetMs: 0 }]);

    const llm = echoingLlm({
      classifier: JSON.stringify({
        items: [
          {
            text: 'к врачу',
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
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, topics: gateway }),
      },
      userId,
    );

    // Затронута одна тема — значит и ветка создана одна, и сводка одна.
    expect(gateway.created.map((thread) => thread.name)).toEqual(['здоровье']);
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]?.text).toContain('к врачу');
  });

  it('без шлюза тем разбор работает целиком: плоский режим', async () => {
    // §8.2: плоский режим резервный, но он должен работать.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'к врачу', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender }),
      },
      userId,
    );

    expect(await testDb().select().from(items)).toHaveLength(1);
    expect(all.at(-1)).toContain('к врачу');
  });

  it('пропавшая ветка не роняет разбор', async () => {
    // §17: человек удалил ветку руками, пока шла обработка.
    const prompts = await seedPrompts();

    await testDb()
      .insert(topics)
      .values([{ userId, name: 'личное', sortOrder: 0, isDefault: true, tgThreadId: 4242 }]);

    await queuedBatchOf([{ kind: 'text', text: 'дело', offsetMs: 0 }]);
    const gone = new FakeTopicGateway({ goneThreads: new Set([4242]) });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, topics: gone }),
      },
      userId,
    );

    // Запись сохранена, а ветка забыта — пересоздастся при надобности.
    expect(await testDb().select().from(items)).toHaveLength(1);
    const [topic] = await testDb().select().from(topics).where(eq(topics.name, 'личное'));
    expect(topic?.tgThreadId).toBeNull();
    expect(topic?.isArchived).toBe(false);
  });
});

describe('острый кризис', () => {
  it('маркер останавливает разбор до первого обращения к модели', async () => {
    // §13.7 и задача 2.12. Первый контур считается в коде, поэтому на
    // настоящем кризисе не тратится ни одной копейки на разбор.
    const prompts = await seedPrompts();
    await queuedBatchOf([
      { kind: 'text', text: 'надо продукты, и вообще я не хочу жить', offsetMs: 0 },
    ]);
    const { sender, all } = recordingSender();
    const llm = echoingLlm();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    expect(llm.callCount).toBe(0);
    expect(await testDb().select().from(items)).toHaveLength(0);
    expect(all.at(-1)).toBe(defaultTexts.safety.crisis);
  });

  it('признак модели останавливает разбор после маршрутизатора', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'всё это больше не имеет смысла', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: true,
        segments: [{ intent: 'DUMP', text: 'всё это больше не имеет смысла' }],
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    // Маршрутизатор спрошен, дальше — нет: ни единиц, ни классов,
    // ни признания.
    expect(llm.callCount).toBe(1);
    const stages = new Set((await testDb().select().from(aiCalls)).map((call) => call.stage));
    expect(stages).toEqual(new Set(['router']));

    expect(await testDb().select().from(items)).toHaveLength(0);
    expect(all.at(-1)).toBe(defaultTexts.safety.crisis);
  });

  it('выгрузка доведена до «готово», а не оставлена висеть', async () => {
    // Иначе досмотр будет подбирать её вечно и раз за разом отвечать
    // человеку одним и тем же.
    const prompts = await seedPrompts();
    const batchId = await queuedBatchOf([{ kind: 'text', text: 'хочу умереть', offsetMs: 0 }]);

    await processUserBatches(
      { db: testDb(), lock, handleBatch: handler({ speech: new MockSpeechProvider(), prompts }) },
      userId,
    );

    const [batch] = await testDb().select().from(batches).where(eq(batches.id, batchId));
    expect(batch?.status).toBe('done');
  });

  it('текст сказанного остаётся на месте', async () => {
    // Инвариант 1: сообщение сохранено до всякого разбора. Записей нет, но
    // и потери нет.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'я не хочу жить', offsetMs: 0 }]);

    await processUserBatches(
      { db: testDb(), lock, handleBatch: handler({ speech: new MockSpeechProvider(), prompts }) },
      userId,
    );

    const [row] = await testDb().select().from(messagesRaw);
    expect(row?.text).toBe('я не хочу жить');
  });
});

/** Считает отправки и правки вместо обращений к Telegram. */
function recordingSender(): {
  sender: StatusSender;
  sent: string[];
  edited: string[];
  all: string[];
} {
  const sent: string[] = [];
  const edited: string[] = [];
  const all: string[] = [];

  return {
    sent,
    edited,
    all,
    sender: {
      send: ({ text }) => {
        sent.push(text);
        all.push(text);
        return Promise.resolve(1000 + sent.length);
      },
      edit: ({ text }) => {
        edited.push(text);
        all.push(text);
        return Promise.resolve();
      },
    },
  };
}

describe('ответ пользователю', () => {
  it('правит статусное сообщение, а не шлёт новое', async () => {
    // §9.2 ТЗ: одна реплика на выгрузку. Подтверждение приёма уже ушло
    // из обработчика входящих, конвейер только правит его.
    const prompts = await seedPrompts();
    const batchId = await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const { sender, sent, edited } = recordingSender();

    await testDb()
      .update(batches)
      .set({ statusMessageId: 777, statusUpdatedAt: at(-60_000) })
      .where(eq(batches.id, batchId));

    const speech = new MockSpeechProvider({ responses: ['купить продукты'] });

    await processUserBatches(
      { db: testDb(), lock, handleBatch: handler({ speech, prompts, sender }) },
      userId,
    );

    expect(sent).toEqual([]);
    // Промежуточная реплика на время расшифровки и итоговый разбор.
    expect(edited).toHaveLength(2);
    expect(edited.at(-1)).toContain('купить продукты');
  });

  it('отвечает по §13.2: признание, список, сохранённое, один вопрос', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([
      { kind: 'text', text: 'записать сына к врачу', offsetMs: 0 },
      { kind: 'text', text: 'и ещё забрать вещи', offsetMs: 5_000 },
    ]);
    const { sender, all } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender }),
      },
      userId,
    );

    const reply = all.at(-1) ?? '';
    expect(reply.startsWith('Я тебя услышала.')).toBe(true);
    expect(reply).toContain('записать сына к врачу');
    expect(reply).toContain('и ещё забрать вещи');
    expect(reply).toContain(defaultTexts.answer.question);
    expect(countQuestions(reply)).toBe(1);
  });

  it('на пустой расшифровке честно говорит, что не разобрала', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    const speech = new MockSpeechProvider({ responses: [''] });

    await processUserBatches(
      { db: testDb(), lock, handleBatch: handler({ speech, prompts, sender }) },
      userId,
    );

    expect(all.at(-1)).toContain('Не разобрала');
    expect(await testDb().select().from(items)).toHaveLength(0);
  });

  it('несостоявшийся ответ не мешает разбору', async () => {
    // Человек мог заблокировать бота, пока шла расшифровка. Ответ важен,
    // но выгрузка важнее: её терять нельзя из-за недоставленной реплики.
    const prompts = await seedPrompts();
    const batchId = await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const speech = new MockSpeechProvider({ responses: ['текст'] });

    const silentSender: StatusSender = {
      // Ноль означает «отправить не удалось».
      send: () => Promise.resolve(0),
      edit: () => Promise.resolve(),
    };

    await processUserBatches(
      { db: testDb(), lock, handleBatch: handler({ speech, prompts, sender: silentSender }) },
      userId,
    );

    const [batch] = await testDb().select().from(batches).where(eq(batches.id, batchId));
    expect(batch?.status).toBe('done');
    expect(batch?.combinedText).toBe('текст');
    // Записи созданы: ответ не доехал, а разбор состоялся.
    expect(await testDb().select().from(items)).toHaveLength(1);
    // Несуществующее сообщение не запомнено: следующая попытка отправит заново.
    expect(batch?.statusMessageId).toBeNull();
  });

  it('без отправителя работает молча и не падает', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const speech = new MockSpeechProvider({ responses: ['текст'] });

    await expect(
      processUserBatches({ db: testDb(), lock, handleBatch: handler({ speech, prompts }) }, userId),
    ).resolves.toMatchObject({ processed: 1 });
  });
});

describe('онбординг: края', () => {
  it('без имени в профиле опрос начинается с часового пояса', async () => {
    // У части аккаунтов Telegram имени нет: подтверждать нечего.
    const prompts = await seedPrompts();
    await testDb().update(users).set({ firstName: null }).where(eq(users.id, userId));

    await queuedBatchOf([{ kind: 'text', text: 'дело', offsetMs: 0 }]);
    const questions = recordingQuestions();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender: recordingSender().sender,
          onboarding: questions.sender,
        }),
      },
      userId,
    );

    expect(questions.asked).toEqual([defaultTexts.onboarding.timezoneMoscow]);

    const [settings] = await testDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    expect(settings?.onboardingStep).toBe(STEP.timezone);
  });

  it('пока опрос не закончен, разбор своего вопроса не задаёт', async () => {
    // Человек мог наговорить ещё раз, не ответив. Тот вопрос никуда не
    // делся, и второй к нему добавлять нельзя (§13.9).
    const prompts = await seedPrompts();
    await testDb()
      .update(userSettings)
      .set({ onboardingStep: STEP.morning })
      .where(eq(userSettings.userId, userId));

    await queuedBatchOf([{ kind: 'text', text: 'ещё одно дело', offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    const questions = recordingQuestions();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          onboarding: questions.sender,
        }),
      },
      userId,
    );

    const reply = all.at(-1) ?? '';
    expect(reply).toContain('ещё одно дело');
    expect(countQuestions(reply)).toBe(0);

    // И второй вопрос онбординга не задан: человек ещё на прежнем шаге.
    expect(questions.asked).toHaveLength(0);
  });
});

describe('мягкий лимит расхода', () => {
  /**
   * §10.5 ТЗ, задача 2.22. Требования не было ни в одном этапе плана
   * работ ТЗ, а оно важное: как только продуктом начинают пользоваться
   * живые люди, один нетипичный пользователь может съесть месячный
   * бюджет за день, и узнаем мы об этом из счёта.
   */

  const LIMIT: SpendLimit = { micros: 10_000_000, currency: 'rub' };

  /** Уже потраченное за расчётный период. */
  async function spend(micros: number, options: { known: boolean } = { known: true }) {
    await testDb()
      .insert(aiCalls)
      .values({
        userId,
        stage: 'classifier',
        model: 'mock:full',
        latencyMs: 10,
        ok: true,
        tokensIn: 1000,
        tokensOut: 500,
        ...(options.known ? { costMicros: micros, costCurrency: 'rub' as const } : {}),
      });
  }

  async function modelsByStage(): Promise<Map<string, string[]>> {
    const rows = await testDb()
      .select({ stage: aiCalls.stage, model: aiCalls.model })
      .from(aiCalls)
      .orderBy(asc(aiCalls.createdAt));

    const byStage = new Map<string, string[]>();
    for (const row of rows) {
      byStage.set(row.stage, [...(byStage.get(row.stage) ?? []), row.model]);
    }
    return byStage;
  }

  it('в пределах лимита тяжёлые стадии идут на полной модели', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'купить продукты', offsetMs: 0 }]);
    await spend(1_000_000);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm({}, 'mock:full'),
          llmLight: echoingLlm({}, 'mock:light'),
          spendLimit: LIMIT,
        }),
      },
      userId,
    );

    const byStage = await modelsByStage();
    expect(byStage.get('extractor')).toEqual(['mock:full']);
    expect(byStage.get('classifier')).toContain('mock:full');
  });

  it('при превышении извлечение и классификация переходят на лёгкую модель', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'купить продукты', offsetMs: 0 }]);
    await spend(12_000_000);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm({}, 'mock:full'),
          llmLight: echoingLlm({}, 'mock:light'),
          spendLimit: LIMIT,
        }),
      },
      userId,
    );

    const byStage = await modelsByStage();
    expect(byStage.get('extractor')).toEqual(['mock:light']);
    // Маршрутизатор и так на лёгкой (§7.1), а представление остаётся на
    // полной: §10.5 называет тяжёлыми извлечение, классификацию и
    // резолвер, а одна фраза признания стоит копейки.
    expect(byStage.get('router')).toEqual(['mock:light']);
    expect(byStage.get('presenter')).toEqual(['mock:full']);
  });

  it('человек ничего не замечает: ответ тот же и лишних сообщений нет', async () => {
    // §17 ТЗ: деградация не объясняется пользователю. Он не виноват, что
    // его выгрузки дороже среднего, и знать об этом ему незачем.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'купить продукты', offsetMs: 0 }]);
    await spend(12_000_000);
    const { sender, all } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm({}, 'mock:full'),
          llmLight: echoingLlm({}, 'mock:light'),
          spendLimit: LIMIT,
          sender,
        }),
      },
      userId,
    );

    expect(all).toHaveLength(1);
    expect(all[0]).toContain('купить продукты');
    expect(all.join(' ')).not.toMatch(/лимит|модель|дешевл|ограничен/iu);

    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(saved).toHaveLength(1);
  });

  it('без известной цены лимит не срабатывает вслепую', async () => {
    // Ключевое свойство. Расход с неизвестной ценой — нижняя оценка;
    // деградировать по ней значило бы понизить качество разбора из-за
    // незаполненного прайс-листа, а не из-за расхода человека. В журнале
    // при этом остаётся предупреждение: молча не работающий лимит хуже
    // отсутствующего, на него надеются.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'купить продукты', offsetMs: 0 }]);
    await spend(0, { known: false });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm({}, 'mock:full'),
          llmLight: echoingLlm({}, 'mock:light'),
          spendLimit: LIMIT,
        }),
      },
      userId,
    );

    expect((await modelsByStage()).get('extractor')).toEqual(['mock:full']);
  });

  it('лимит не задан — ограничения нет', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'купить продукты', offsetMs: 0 }]);
    await spend(999_000_000);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm({}, 'mock:full'),
          llmLight: echoingLlm({}, 'mock:light'),
        }),
      },
      userId,
    );

    expect((await modelsByStage()).get('extractor')).toEqual(['mock:full']);
  });
});
