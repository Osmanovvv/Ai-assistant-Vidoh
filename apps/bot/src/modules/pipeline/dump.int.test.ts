import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, asc, desc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  aiCalls,
  batches,
  itemRevisions,
  items,
  messagesRaw,
  misunderstood,
  pendingQuestions,
  projectSteps,
  promptVersions,
  reminders,
  topics,
  users,
  userSettings,
} from '../../db/schema.js';
import { RedisLock } from '../../infra/lock.js';
import { createRedis } from '../../infra/redis.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { PromptRegistry } from '../ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../ai/prompts/seed.js';
import { MockLlmProvider } from '../ai/providers/mock.js';
import type { CardSender } from '../cards/cards.js';
import { withCapital } from '../items/item-text.js';
import { answerQuestion, askQuestion } from '../resolver/questions.repo.js';
import { QUESTION_ACTION } from '../resolver/change-text.js';
import { RETURNING_ACTION } from '../returning/returning-actions.js';
import { toShortId } from '../shared/short-id.js';
import { recordRevision, revertRevision } from '../resolver/revisions.repo.js';
import type { CompletionRequest } from '../ai/providers/types.js';
import {
  CLASSIFIER_SCHEMA_NAME,
  EXTRACTOR_SCHEMA_NAME,
  ANSWERER_SCHEMA_NAME,
  PRESENTER_SCHEMA_NAME,
  PRESENTER_V2_SCHEMA_NAME,
  RESOLVER_SCHEMA_NAME,
  ROUTER_SCHEMA_NAME,
} from '../ai/schemas/index.js';
import { attachMessageToBatch, closeBatchOnSilence } from '../buffer/buffer.service.js';
import { MockEmbeddingProvider } from '../embedder/providers/mock.js';
import { setItemEmbedding } from '../embedder/embedder.service.js';
import { pickMain } from '../presenter/pick.service.js';
import { FakeTopicGateway } from '../topics/fake-gateway.js';
import { ensureThread } from '../topics/topics.service.js';
import { listTopics, MAX_TOPICS } from '../topics/topics.repo.js';
import { STEP } from '../onboarding/onboarding.service.js';
import { ANSWER_ACTION, countQuestions } from '../presenter/presenter.service.js';
import type { StatusSender } from '../presenter/status.service.js';
import type { DialogTurn } from '../dialog/dialog.js';
import type { DialogStore } from '../dialog/dialog.store.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import type { AudioLimits } from '../speech/audio.service.js';
import { run } from '../speech/ffmpeg.js';
import { MockSpeechProvider } from '../speech/providers/mock.js';
import { putSetting, SettingsRegistry } from '../settings/settings.repo.js';
import { PermanentSpeechError, TransientSpeechError } from '../speech/providers/types.js';
import { createFailureReporter } from './failure-notice.js';
import { upsertUser } from '../users/users.repo.js';
import type { SpendLimit } from '../metering/limits.js';
import { createDumpHandler, type PipelineEvent, type PipelineObserver } from './dump.handler.js';
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

/** Завтра по Москве от часов теста — ГГГГ-ММ-ДД, как отвечает модель. */
function tomorrowIso(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at(24 * 60 * 60_000));
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';

  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * Список по «Выбрать главное» для последней выгрузки человека (решение
 * заказчицы 15.09.2026): дел под признанием больше нет, и что бот
 * предложил бы, проверяется здесь.
 */
async function pickedNow(): Promise<readonly string[]> {
  const [last] = await testDb()
    .select({ id: batches.id })
    .from(batches)
    .where(eq(batches.userId, userId))
    .orderBy(desc(batches.openedAt))
    .limit(1);

  const picked = await pickMain(testDb(), {
    userId,
    batchId: last?.id,
    now: at(0),
    timeZone: 'Europe/Moscow',
  });
  return picked.actions;
}

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
  resolver: 'РЕШЕНИЕ',
  answerer: 'ОТВЕТ',
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
 * Номер кандидата с таким заголовком во входе резолвера.
 *
 * Резолвер нумерует записи «1», «2», «3» и ждёт номер обратно. Тест не
 * должен угадывать порядок кандидатов — он читает его из того же текста,
 * который видит модель.
 */
const NEWLINE = String.fromCharCode(10);

function numberOfCandidate(input: string, title: string): number {
  for (const line of input.split(NEWLINE)) {
    const match = /^(?<number>\d+)\.\s*(?<text>[^·]+)/u.exec(line);
    if (match?.groups?.['text']?.trim() === title) return Number(match.groups['number']);
  }

  throw new Error(`кандидата «${title}» нет во входе резолвера:${NEWLINE}${input}`);
}

/**
 * Модель-эхо: всё сказанное проходит цепочку насквозь.
 *
 * Так видно, что шаги соединены: заголовок дела в ответе — это текст,
 * который человек наговорил, а не выдумка теста.
 */
/**
 * Ответ этапа: строкой, если он один на весь прогон, или функцией, если
 * этап зовётся несколько раз и должен отвечать по-разному.
 */
type StageAnswer = string | ((request: CompletionRequest) => string);

function echoingLlm(
  overrides: Partial<Record<Stage, StageAnswer>> = {},
  /** Название модели: по нему в учёте видно, полная работала или лёгкая. */
  model?: string,
): MockLlmProvider {
  return new MockLlmProvider({
    ...(model === undefined ? {} : { model }),
    respond: (request) => {
      const stage = stageOf(request);
      if (stage === undefined) return '{}';

      const override = overrides[stage];
      if (typeof override === 'function') return override(request);
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
              deadlineText: '',
            })),
          });
        case 'resolver':
          return JSON.stringify({
            action: 'new',
            mode: 'replace',
            itemId: '',
            confidence: 0.1,
            changes: {
              note: '',
              text: '',
              deadline: '',
              deadlineAccuracy: 'none',
              recurrenceKind: 'none',
              recurrenceInterval: 0,
              recurrenceText: '',
            },
            reason: 'заглушка',
          });
        case 'presenter':
          return JSON.stringify({ acknowledgement: 'Я тебя услышала.' });
        case 'answerer':
          // Пусто — «сказать нечего»: ответ словарный, как без модели.
          return JSON.stringify({ answer: '' });
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
    { stage: 'resolver', schema: RESOLVER_SCHEMA_NAME, marker: MARKERS.resolver },
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
  /** Бренд-карточки (ТЗ по визуалам 18.09.2026). */
  readonly cards?: CardSender | undefined;
  readonly topics?: FakeTopicGateway | undefined;
  readonly llm?: MockLlmProvider;
  /** Лёгкая модель: на неё переходят тяжёлые стадии при превышении лимита. */
  readonly llmLight?: MockLlmProvider | undefined;
  /** Модель маршрутизатора (решение Никиты 23.09.2026 — Pro). */
  readonly llmRouter?: MockLlmProvider | undefined;
  readonly spendLimit?: SpendLimit | undefined;
  readonly prompts: PromptRegistry;
  readonly sender?: StatusSender | undefined;
  /** Потолки аудио: нужны тесту на обрезку (§10.5 ТЗ). */
  readonly speechLimits?: AudioLimits | undefined;
  /** Через сколько говорить «слушаю дольше обычного» (голос 4, 18.09.2026). */
  readonly slowAfterMs?: number | undefined;
  readonly embedder?: MockEmbeddingProvider | undefined;
  readonly onboarding?: QuestionSender | undefined;
  readonly now?: Date | undefined;
  /** Наблюдатель конвейера — для стенда набора (20.09.2026). */
  readonly observe?: PipelineObserver | undefined;
  /** Хвост разговора и выключатель (план docs/26, задача 8). */
  readonly dialog?: DialogStore | undefined;
  readonly useDialog?: boolean | undefined;
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
      ...(options.slowAfterMs === undefined ? {} : { slowAfterMs: options.slowAfterMs }),
    },
    ...(options.cards === undefined ? {} : { cards: options.cards }),
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
    ...(options.llmRouter === undefined
      ? {}
      : {
          aiRouter: {
            provider: options.llmRouter,
            prompts: options.prompts,
            retry: { attempts: 1, sleep: () => Promise.resolve() },
          },
        }),
    ...(options.spendLimit === undefined ? {} : { spendLimit: options.spendLimit }),
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    ...(options.sender === undefined ? {} : { sender: options.sender }),
    ...(options.onboarding === undefined ? {} : { onboarding: options.onboarding }),
    ...(options.topics === undefined ? {} : { topics: options.topics }),
    ...(options.observe === undefined ? {} : { observe: options.observe }),
    ...(options.dialog === undefined ? {} : { dialog: options.dialog }),
    ...(options.useDialog === undefined ? {} : { useDialog: options.useDialog }),
    /**
     * Реестр настроек — **всегда**, а не по желанию проверки.
     *
     * Найдено ревизией четвёртого этапа. Без него разбор не читает
     * предел пробного периода, а значит и не тратит его: весь набор
     * проверок про пробный период мерил обстановку, которой в бою нет.
     * Момент «пробный кончился» в этих проверках не писался ни разу —
     * `trialLimit` уезжал `undefined`.
     */
    settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
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
    expect(saved.map((item) => item.text)).toEqual(['Записать сына к врачу', 'Купить продукты']);
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

    // Признание собирается кодом (16.09.2026): этапа презентера в учёте нет.
    expect(stages).toEqual(new Set(['speech', 'router', 'extractor', 'classifier', 'embedder']));
    expect(calls.every((call) => call.ok)).toBe(true);
    expect(calls.every((call) => call.batchId !== null)).toBe(true);
  });

  it('правку без цели откладывает черновиком, а не превращает в задачу', async () => {
    /**
     * Резолвер (подменённый) отвечает «это новая мысль», а извлечение из
     * «хотя нет, в пятницу» единиц не даёт — как и настоящее: это обрывок,
     * а не мысль. Задача «хотя нет, в пятницу» была бы задачей без задачи;
     * слова ложатся черновиком, и человеку об этом сказано.
     *
     * До ревизии этапа 3 (A4-средняя) поздняя мысль в разбор не попадала
     * вовсе — черновиком ложилось всё подряд, и настоящая мысль тоже.
     */
    const prompts = await seedPrompts();
    await queuedBatchOf([
      { kind: 'text', text: 'записать сына к врачу в четверг, хотя нет, в пятницу', offsetMs: 0 },
    ]);
    const { sender, all } = recordingSender();

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'DUMP', text: 'записать сына к врачу в четверг' },
          { intent: 'PATCH', text: 'хотя нет, в пятницу' },
        ],
      }),
      extractor: (request) =>
        request.input === 'хотя нет, в пятницу'
          ? JSON.stringify({ units: [] })
          : JSON.stringify({
              units: [{ text: request.input, isProject: false, isEmotion: false }],
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

    const saved = await testDb().select().from(items).orderBy(asc(items.createdAt));
    const drafts = saved.filter((item) => item.isDraft);
    const parsed = saved.filter((item) => !item.isDraft);

    expect(parsed.map((item) => item.text)).toEqual(['Записать сына к врачу в четверг']);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.text).toBe('хотя нет, в пятницу');
    expect(drafts[0]?.draftReason).toContain('поздняя мысль');
    expect(all.at(-1)).toContain(defaultTexts.answer.savedUnparsed);
  });

  it('час из слов дела ложится в запись — для напоминания в указанный час (ТЗ проджекта 17.09.2026, шаг 5)', async () => {
    const prompts = await seedPrompts();
    const speech = 'Завтра надо сходить к стоматологу в 13 0 0 и погулять с собакой.';
    await queuedBatchOf([{ kind: 'text', text: speech, offsetMs: 0 }]);
    const { sender } = recordingSender();

    const llm = echoingLlm({
      router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: speech }] }),
      extractor: () =>
        JSON.stringify({
          units: [
            { text: 'Сходить к стоматологу в 13:00', isProject: false, isEmotion: false },
            { text: 'Погулять с собакой', isProject: false, isEmotion: false },
          ],
        }),
      classifier: (request) =>
        JSON.stringify({
          items: request.input.includes('стоматолог')
            ? [
                {
                  text: 'Сходить к стоматологу в 13:00',
                  type: 'TASK',
                  priority: 'SOON',
                  topic: 'здоровье',
                  isProject: false,
                  deadline: '{{tomorrow}}',
                  deadlineAccuracy: 'day',
                  deadlineText: 'завтра',
                  recurrenceKind: 'none',
                  recurrenceInterval: 0,
                  recurrenceText: '',
                },
                {
                  text: 'Погулять с собакой',
                  type: 'TASK',
                  priority: 'SOON',
                  topic: 'личное',
                  isProject: false,
                  deadline: '{{tomorrow}}',
                  deadlineAccuracy: 'day',
                  deadlineText: 'завтра',
                  recurrenceKind: 'none',
                  recurrenceInterval: 0,
                  recurrenceText: '',
                },
              ]
            : [],
        }).replaceAll('{{tomorrow}}', tomorrowIso()),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const saved = await testDb().select().from(items).orderBy(asc(items.sourceOrder));

    // Час ушёл в срок — из заголовка срезан (бой 22.09.2026): иначе в
    // списке «Сходить к стоматологу в 13:00» и рядом «Срок: 13:00».
    expect(saved.map((item) => [item.text, item.deadlineAccuracy, item.deadlineTime])).toEqual([
      ['Сходить к стоматологу', 'day', 13 * 60],
      ['Погулять с собакой', 'day', null],
    ]);
  });

  it('первое дело с часом — карточка 04 «Записала. Напомню в нужный момент.» с кнопками; второе — без картинки (визуал 04)', async () => {
    const prompts = await seedPrompts();
    const { cards, shown } = recordingCards();
    const { sender } = recordingSender();

    const dumpWithHour = (text: string) =>
      echoingLlm({
        router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text }] }),
        extractor: () => JSON.stringify({ units: [{ text, isProject: false, isEmotion: false }] }),
        classifier: () =>
          JSON.stringify({
            items: [
              {
                text,
                type: 'TASK',
                priority: 'SOON',
                topic: 'здоровье',
                isProject: false,
                deadline: tomorrowIso(),
                deadlineAccuracy: 'day',
                deadlineText: 'завтра',
                recurrenceKind: 'none',
                recurrenceInterval: 0,
                recurrenceText: '',
              },
            ],
          }),
      });

    await queuedBatchOf([{ kind: 'text', text: 'Завтра к стоматологу в 13:00', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          cards,
          llm: dumpWithHour('Завтра к стоматологу в 13:00'),
        }),
      },
      userId,
    );

    const [first] = await testDb().select().from(items).orderBy(asc(items.createdAt));
    expect(shown).toEqual([
      {
        card: 'reminder',
        caption: defaultTexts.cards.reminder,
        buttons: [defaultTexts.card.buttonRetime, defaultTexts.reminders.buttonAll],
      },
    ]);
    expect(first?.deadlineTime).toBe(13 * 60);

    // Второе дело с часом — картинки больше нет: визуалы редкие.
    await queuedBatchOf([{ kind: 'text', text: 'Завтра к врачу в 15:00', offsetMs: 60_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          cards,
          llm: dumpWithHour('Завтра к врачу в 15:00'),
        }),
      },
      userId,
    );

    expect(shown).toHaveLength(1);
  });

  it('эхо самопоправки не становится второй записью: «К врачу лучше в пятницу» (стенд 21.09.2026)', async () => {
    /**
     * Живой набор, `live-14`: извлечение сделало из «хотя нет к врачу
     * лучше в пятницу» отдельную единицу; день у «отвезти дочку к врачу»
     * перенесён верно, а эхо поправки ложилось второй записью про врача.
     */
    const prompts = await seedPrompts();
    const speech = 'Так, во вторник надо отвезти дочку к врачу, хотя нет к врачу лучше в пятницу.';
    await queuedBatchOf([{ kind: 'text', text: speech, offsetMs: 0 }]);
    const { sender } = recordingSender();

    const llm = echoingLlm({
      router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: speech }] }),
      extractor: () =>
        JSON.stringify({
          units: [
            { text: 'Во вторник надо отвезти дочку к врачу', isProject: false, isEmotion: false },
            { text: 'К врачу лучше в пятницу', isProject: false, isEmotion: false },
          ],
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

    const saved = await testDb().select().from(items).orderBy(asc(items.createdAt));

    expect(saved.filter((item) => item.isDraft)).toHaveLength(0);
    expect(saved.map((item) => item.text)).toEqual(['Отвезти дочку к врачу']);
  });

  it('правка без цели, но с делом внутри, — мысль: «зато надо записаться … к косметологу» (стенд 21.09.2026)', async () => {
    /**
     * Живой набор, `live-08`: «…зато надо записаться к стоматологу, ой,
     * не к стоматологу, к косметологу» маршрутизатор отдал `PATCH`. У
     * человека без записей кандидатов нет, резолвер без модели отвечает
     * «создать, но не мысль» — и дело уходило в черновик. Правило второго
     * этапа верно для «нет, в пятницу»; здесь же есть слово долга и
     * глагол дела (`thought-words.ts`), и это мысль. У нового человека
     * первая же самопоправка иначе теряла дело.
     */
    const prompts = await seedPrompts();
    await queuedBatchOf([
      {
        kind: 'text',
        text: 'зато надо записаться к стоматологу, ой, не к стоматологу, к косметологу.',
        offsetMs: 0,
      },
    ]);
    const { sender } = recordingSender();

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          {
            intent: 'PATCH',
            text: 'зато надо записаться к стоматологу, ой, не к стоматологу, к косметологу.',
          },
        ],
      }),
      extractor: () =>
        JSON.stringify({
          units: [{ text: 'записаться к косметологу', isProject: false, isEmotion: false }],
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

    const saved = await testDb().select().from(items).orderBy(asc(items.createdAt));

    expect(saved.filter((item) => item.isDraft)).toHaveLength(0);
    expect(saved.map((item) => item.text)).toEqual(['Записаться к косметологу']);
  });

  it('мысль, принятая за правку после первой мысли, становится записью (ревизия этапа 3, A4-средняя)', async () => {
    /**
     * «Записать сына к врачу, купить молоко»: маршрутизатор счёл второе
     * правкой к первому. Правка после мысли разбирается уже после
     * сохранения; резолвер, глядя на записи, говорит «это новая мысль».
     * Раньше вставить её в разбор было нечем: слова ложились черновиком
     * с «Сохранила целиком», и обещание маршрутизатора «запись всё равно
     * появится» было неправдой. Теперь для неё идёт свой проход
     * извлечения и классификации — две дополнительных единицы работы
     * модели, и только в этом редком случае.
     */
    const prompts = await seedPrompts();
    await queuedBatchOf([
      { kind: 'text', text: 'записать сына к врачу в четверг, купить молоко', offsetMs: 0 },
    ]);
    const { sender, all } = recordingSender();

    // Свои сферы с ветками: поздняя запись должна дойти и до своей ветки.
    const gateway = new FakeTopicGateway();
    await testDb()
      .insert(topics)
      .values([
        { userId, name: 'личное', sortOrder: 0, isDefault: true },
        { userId, name: 'дом', sortOrder: 1, isDefault: false },
      ]);
    for (const row of await testDb().select().from(topics).where(eq(topics.userId, userId))) {
      await ensureThread({ db: testDb(), gateway }, { topicId: row.id, chatId: 700 });
    }

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'DUMP', text: 'записать сына к врачу в четверг' },
          { intent: 'PATCH', text: 'купить молоко' },
        ],
      }),
      classifier: (request) =>
        JSON.stringify({
          items: unitsFromInput(request.input).map((text) => ({
            text,
            type: 'TASK',
            priority: 'SOON',
            topic: text.includes('молоко') ? 'дом' : 'личное',
            isProject: false,
            deadline: '',
            deadlineAccuracy: 'none',
            recurrenceKind: 'none',
            recurrenceInterval: 0,
            recurrenceText: '',
            deadlineText: '',
          })),
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
          sender,
          topics: gateway,
        }),
      },
      userId,
    );

    const saved = await testDb().select().from(items).orderBy(asc(items.createdAt));
    expect(saved.filter((item) => item.isDraft)).toHaveLength(0);
    expect(saved.map((item) => [item.text, item.topic])).toEqual([
      ['Записать сына к врачу в четверг', 'личное'],
      ['Купить молоко', 'дом'],
    ]);
    expect(saved.every((item) => item.sourceBatchId !== null)).toBe(true);

    // Второй проход извлечения и классификации — по одному вызову на каждое.
    const calls = await testDb().select().from(aiCalls);
    expect(calls.filter((call) => call.stage === 'extractor')).toHaveLength(2);
    expect(calls.filter((call) => call.stage === 'classifier')).toHaveLength(2);

    // Человеку не говорят «сохранила целиком»: всё разобрано, и дело —
    // в списке по «Выбрать главное» (решение заказчицы 15.09.2026).
    expect(all.join('\n')).not.toContain(defaultTexts.answer.savedUnparsed);
    const picked = await pickMain(testDb(), { userId, now: at(0), timeZone: 'Europe/Moscow' });
    expect(picked.actions).toContain('Купить молоко');

    // Сводка ветки «дом» тронута поздней записью, как и любой другой.
    const summaries = [...gateway.sent, ...gateway.edited].map((message) => message.text);
    expect(summaries.some((text) => text.includes('Купить молоко'))).toBe(true);
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

  /**
   * Отложенная правка не должна пропадать на раннем выходе (задача 3.82).
   *
   * **Как теряется.** Правка, сказанная после мысли этой же выгрузки,
   * ждёт второго прохода — он идёт после сохранения записей (задача
   * 3.24). Между откладыванием и вторым проходом стоят четыре выхода:
   * разбирать нечего, извлечение не удалось, единиц ноль, классификация
   * не удалась. На любом из них список отложенных исчезал вместе с
   * областью видимости — ни записи, ни черновика, ни слова человеку.
   *
   * Модель здесь не нужна: правка попадает в отложенные **по порядку
   * сегментов**, ещё до всякого разбора.
   */
  it('единиц ноль — отложенная правка уходит в черновик, а не в никуда', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([
      { kind: 'text', text: 'надо продукты. нет, лучше в пятницу', offsetMs: 0 },
    ]);
    const { sender, all } = recordingSender();

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'DUMP', text: 'надо продукты' },
          // Правка после мысли: уходит в отложенные до сохранения.
          { intent: 'PATCH', text: 'нет, лучше в пятницу' },
        ],
      }),
      // Единиц ноль — ранний выход прямо перед вторым проходом.
      extractor: JSON.stringify({ units: [] }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const saved = await testDb().select().from(items);

    expect(saved.map((one) => one.text)).toContain('нет, лучше в пятницу');
    expect(saved.find((one) => one.text === 'нет, лучше в пятницу')?.isDraft).toBe(true);
    expect(saved.find((one) => one.text === 'нет, лучше в пятницу')?.draftReason).toContain(
      'единиц',
    );

    /**
     * И реплика — про сохранённое. «Расскажешь, что в голове?» человеку,
     * который только что сказал своё, читается как «я тебя не услышала».
     */
    expect(all.at(-1)).toBe(defaultTexts.answer.savedUnparsed);
    expect(all).not.toContain(defaultTexts.answer.nothingToParse);
  });

  it('сбой извлечения — отложенная правка получает свой черновик', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([
      { kind: 'text', text: 'надо продукты. нет, лучше в пятницу', offsetMs: 0 },
    ]);
    const { sender, all } = recordingSender();

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'DUMP', text: 'надо продукты' },
          { intent: 'PATCH', text: 'нет, лучше в пятницу' },
        ],
      }),
      extractor: 'это не JSON',
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const drafts = await testDb().select().from(items);

    // Две потери — два черновика: сама выгрузка и отложенная правка.
    expect(drafts.every((one) => one.isDraft)).toBe(true);
    expect(drafts.map((one) => one.text).sort()).toEqual(
      ['надо продукты', 'нет, лучше в пятницу'].sort(),
    );
    expect(all.at(-1)).toBe(defaultTexts.answer.savedUnparsed);
  });

  it('распознавание затянулось — человеку говорят, что ждать и не перезаписывать (голос 4, 18.09.2026)', async () => {
    // SpeechKit отдавал расшифровку и за секунду, и за десять минут; всё
    // это время человек видел «Секунду, слушаю запись» — и не знал,
    // ждать ли или наговаривать заново.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    // Секунда с лишним: статусное сообщение правится не чаще раза в
    // секунду, и «дольше обычного» обязано пройти через это же сито.
    const speech = new MockSpeechProvider({ responses: ['купить продукты'], delayMs: 1_500 });
    const { sender, all } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech, prompts, sender, slowAfterMs: 1_100 }),
      },
      userId,
    );

    const slowAt = all.indexOf(defaultTexts.listening.slow);
    expect(slowAt).toBeGreaterThan(all.indexOf(defaultTexts.listening.working));
    expect(slowAt).toBeLessThan(all.length - 1);
    // Итог всё равно пришёл и лёг последним.
    expect(all.at(-1)).not.toBe(defaultTexts.listening.slow);
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

  /** Выгрузка из трёх дел и одного состояния. Текст состояния — параметр. */
  function threeTasksAnd(emotion: string): string {
    return JSON.stringify({
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
          deadlineText: '',
        })),
        {
          text: emotion,
          type: 'EMOTION',
          priority: 'NONE',
          topic: 'личное',
          isProject: false,
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
          deadlineText: '',
        },
      ],
    });
  }

  it('усталость сокращает форму, но оставляет три дела (задача 3.47)', async () => {
    /**
     * Запрос заказчика 03.09.2026: «при усталости одно действие
     * показывается, сделай чтобы три самых важных показывало».
     *
     * ТЗ это различие делает само, в таблице сигналов §13.7: «вообще без
     * сил» — одно действие, «ничего не успеваю» — **сокращённая
     * выдача**, а не одна строка. Главный эталон §13.2 при названной
     * усталости показывает три дела.
     *
     * Короткая форма при этом остаётся: закрытие без вопроса.
     */
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'дела и усталость', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    const llm = echoingLlm({
      classifier: threeTasksAnd('я ничего не успеваю'),
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

    // Дел под признанием нет ни у кого (решение заказчицы 15.09.2026) —
    // они по «Выбрать главное», и там их три, а не одно.
    const reply = all.at(-1) ?? '';
    expect(reply).not.toContain('Первое дело');
    expect(reply).toContain(defaultTexts.answer.keepOrPick);

    const picked = await pickMain(testDb(), { userId, now: at(0), timeZone: 'Europe/Moscow' });
    expect(picked.actions).toEqual(['Первое дело', 'Второе дело', 'Третье дело']);
  });

  it('выгрузка из одних чувств старые дела не вытаскивает (решение заказчицы 13.09.2026, 1.4)', async () => {
    /**
     * §13.2 её ТЗ на монолог без дел подставлял три старых дела из
     * бэклога. Заказчица отменила: «она поделилась состоянием, а ей в
     * ответ выдали задачи» — давление. Коротко принять, дела не
     * вытаскивать; посмотреть их можно по кнопке. Кризис — своим
     * сценарием, он здесь не трогается.
     */
    const prompts = await seedPrompts();
    for (const text of ['Записать сына к врачу', 'Оплатить садик', 'Разобрать балкон']) {
      await testDb()
        .insert(items)
        .values({ userId, text, type: 'TASK', priority: 'NOW', topic: 'личное' });
    }
    await queuedBatchOf([{ kind: 'text', text: 'так устала, всё навалилось', offsetMs: 0 }]);
    const { sender, all, buttons } = recordingSender();

    const llm = echoingLlm({
      classifier: JSON.stringify({
        items: [
          {
            text: 'так устала, всё навалилось',
            type: 'EMOTION',
            priority: 'NONE',
            topic: 'личное',
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
      presenter: JSON.stringify({ acknowledgement: 'Слышу. Много всего сразу.' }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const reply = all.at(-1) ?? '';
    // Одни чувства — одна фраза её словами (16.09.2026), без счёта дел.
    // «Устала» — лёгкая усталость по её тексту про эмоции: «Похоже,
    // батарейка на сегодня почти всё 😮‍💨 …», приглашение выгрузить.
    expect(reply).toContain(defaultTexts.answer.feelingsOnlyTired);
    expect(reply).not.toContain(defaultTexts.answer.feelingsOnly);
    expect(reply).not.toContain('Записала');
    for (const text of ['Записать сына к врачу', 'Оплатить садик', 'Разобрать балкон']) {
      expect(reply).not.toContain(text);
    }
    expect(reply).not.toContain(defaultTexts.answer.actionsLead);
    expect(reply).not.toContain(defaultTexts.answer.nothingHidden);
    // Правка 14.09.2026 (п. 1.5): коротко и спокойно — ни вопроса, ни
    // кнопок к делам под признанием.
    expect(reply).not.toContain('?');
    expect(buttons).toEqual([]);
  });

  it('«сил нет вовсе» больше не режет выдачу: уровень сил не выводится (правка заказчицы 14.09.2026, п. 1.2)', async () => {
    /**
     * §13.7 её ТЗ на «я на нуле» оставлял одно дело и снижал уровень сил
     * до конца дня. 14.09 она это отменила: «самостоятельно делать вывод
     * о силах женщины и хранить такой показатель не нужно». Дел — до
     * трёх, как всегда; короткая форма (§13.7, закрытие без вопроса)
     * остаётся — она про эмоцию в выгрузке, а не про уровень.
     */
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'дела и совсем нет сил', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    const llm = echoingLlm({
      classifier: threeTasksAnd('я на нуле совсем'),
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

    const reply = all.at(-1) ?? '';
    expect(reply).not.toContain(defaultTexts.answer.actionsLead);

    const picked = await pickMain(testDb(), { userId, now: at(0), timeZone: 'Europe/Moscow' });
    expect(picked.actions).toEqual(['Первое дело', 'Второе дело', 'Третье дело']);
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
    const { sender } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender }),
      },
      userId,
    );

    // Просроченное — с числом после дела: видно, что день прошёл.
    expect(await pickedNow()).toContain('просроченное дело · 23.08');
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
    // Впереди вопрос опроса — своего вопроса ответ не задаёт (§13.9: один
    // вопрос на обмен).
    expect(reply).not.toContain(defaultTexts.answer.keepOrPick);
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
    expect(all.at(-1)).toContain(defaultTexts.answer.keepOrPick);
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

  it('темы человека идут первыми, базовые имена — подсказкой следом (16.09.2026)', async () => {
    /**
     * §6.4 в первой редакции: список тем создаёт онбординг, классификация
     * работает по нему. Опроса про сферы нет с 14.09.2026, а с 16.09
     * сферы заводятся только под записи — значит после первой выгрузки у
     * человека может быть одна тема, и модели нужен ориентир: свои темы
     * впереди, недостающие базовые имена следом.
     */
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
    expect(classifierInput).toContain('покупки');
    expect(classifierInput.indexOf('дети')).toBeLessThan(classifierInput.indexOf('покупки'));
  });
});

describe('дополнение против замены сквозь конвейер (§7.4)', () => {
  /**
   * Найдено ручным прогоном 31.08.2026: дословный пример из условия
   * готовности 3.7 создавал вторую запись вместо подробности к первой.
   *
   * Механизм дополнения был цел и покрыт тестами на двух уровнях — но
   * обоим сегмент приходил **уже размеченным**. Размечает маршрутизатор,
   * и он такие фразы отдавал в обычный разбор. Здесь проверяется путь
   * целиком: от слов человека до поля записи.
   */
  it('«а ещё туда надо взять карту прививок» дописывает подробность', async () => {
    const prompts = await seedPrompts();
    const [item] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Записать сына к врачу в четверг',
        type: 'TASK',
        priority: 'SOON',
        topic: 'здоровье',
      })
      .returning({ id: items.id });

    await queuedBatchOf([
      { kind: 'text', text: 'а ещё туда надо взять карту прививок', offsetMs: 0 },
    ]);

    /**
     * Маршрутизатор отвечает так, как отвечает живая модель, — `DUMP`.
     * Переразметку делает правило в коде, и именно она здесь проверяется.
     */
    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'DUMP', text: 'а ещё туда надо взять карту прививок' }],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'append',
        itemId: '1',
        confidence: 0.95,
        changes: {
          note: 'взять карту прививок',
          text: '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'дополнение к записи про врача',
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

    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    const doctor = saved.find((one) => one.id === item!.id);

    // Подробность легла в запись, заголовок не тронут.
    expect(doctor?.body).toBe('взять карту прививок');
    expect(doctor?.text).toBe('Записать сына к врачу в четверг');

    // И второй записи не появилось — ради этого всё и делалось.
    expect(saved.filter((one) => !one.isDraft)).toHaveLength(1);
  });

  it('вектор пересчитывается, когда правка сменила заголовок', async () => {
    /**
     * План 2.9 обещает дословно: «Считается при создании записи **и при
     * изменении заголовка**». Вторая половина не работала вовсе:
     * `setItemEmbedding` из боя не звал никто — написана, покрыта
     * тестами, недостижима.
     *
     * Цена: после «не к врачу, а к стоматологу» смысловой источник
     * кандидатов §7.2 продолжал искать запись по словам, которых в ней
     * уже нет. Сутки это прикрывает источник «сессия», дальше — нет.
     */
    const prompts = await seedPrompts();
    const embedder = new MockEmbeddingProvider();

    const [item] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Записать сына к врачу в четверг',
        type: 'TASK',
        priority: 'SOON',
        topic: 'здоровье',
      })
      .returning({ id: items.id });

    // Вектор от прежних слов: так выглядит запись, созданная разбором.
    const before = await embedder.embed({
      text: 'Записать сына к врачу в четверг',
      purpose: 'document',
    });
    await setItemEmbedding(testDb(), item?.id ?? '', before.vector);

    await queuedBatchOf([{ kind: 'text', text: 'не к врачу, а к стоматологу', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'не к врачу, а к стоматологу' }],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'replace',
        itemId: '1',
        confidence: 0.95,
        changes: {
          note: '',
          text: 'Записать сына к стоматологу в четверг',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'замена заголовка',
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, embedder }),
      },
      userId,
    );

    const [after] = await testDb()
      .select({ text: items.text, embedding: items.embedding, updatedAt: items.updatedAt })
      .from(items)
      .where(eq(items.id, item?.id ?? ''));

    expect(after?.text).toBe('Записать сына к стоматологу в четверг');

    // Вектор новых слов, а не прежних.
    const expected = await embedder.embed({
      text: 'Записать сына к стоматологу в четверг',
      purpose: 'document',
    });

    /**
     * Целиком, а не по первому измерению: свёртка заглушки разрежена, и
     * у двух разных текстов нулевое измерение совпадает запросто. Страж,
     * сравнивавший его, зеленел и на сломанном дереве — проверено
     * диверсией.
     */
    const shape = (vector: readonly number[]): string =>
      vector.map((one) => one.toFixed(6)).join(',');

    expect(shape(after?.embedding ?? []), 'вектор не от нынешних слов записи').toBe(
      shape(expected.vector),
    );

    expect(
      shape(after?.embedding ?? []),
      'вектор остался от слов, которых в записи уже нет',
    ).not.toBe(shape(before.vector));
  });

  it('вектор не пересчитывается, когда заголовок не менялся', async () => {
    /**
     * Платит отправка, а не результат. Дополнение подробности заголовка
     * не трогает — значит и платить за него нечего: вектор считается от
     * заголовка, и второй вызов дал бы ровно тот же вектор за те же
     * деньги.
     */
    const prompts = await seedPrompts();
    const embedder = new MockEmbeddingProvider();

    const [item] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Записать сына к врачу в четверг',
        type: 'TASK',
        priority: 'SOON',
        topic: 'здоровье',
      })
      .returning({ id: items.id });

    const before = await embedder.embed({
      text: 'Записать сына к врачу в четверг',
      purpose: 'document',
    });
    await setItemEmbedding(testDb(), item?.id ?? '', before.vector);

    /**
     * Считаем только вызовы **на запись** (`document`). Резолвер тем же
     * провайдером считает и вектор запроса (`query`), чтобы найти
     * кандидатов, — он идёт всегда и к пересчёту отношения не имеет.
     */
    const documents = (): number =>
      embedder.requests.filter((one) => one.purpose === 'document').length;

    const spent = documents();

    await queuedBatchOf([
      { kind: 'text', text: 'а ещё туда надо взять карту прививок', offsetMs: 0 },
    ]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'а ещё туда надо взять карту прививок' }],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'append',
        itemId: '1',
        confidence: 0.95,
        changes: {
          note: 'взять карту прививок',
          text: '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'дополнение',
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, embedder }),
      },
      userId,
    );

    expect(documents() - spent, 'заплатили за вектор, хотя заголовок не менялся').toBe(0);
  });

  it('замена, понятая дополнением: реплика не врёт и даёт поправить заголовок', async () => {
    /**
     * **Вторая половина задачи 3.28.** Человек сказал «нет, няня пусть
     * приходит в 9 30». Модель разобрала это дополнением и нового
     * заголовка не дала — заменять нечем, правка остаётся дополнением, и
     * это не беда: слова человека сохранены.
     *
     * Беда была в реплике. «Добавила подробность» молчала о том, что в
     * заголовке осталось прежнее время, и человек уходил с ощущением,
     * что его поняли, — при том что запись противоречит сказанному.
     *
     * Здесь проверяется путь целиком: от слов человека до реплики и
     * кнопок под ней. Тот самый разрыв «служба работает, а в боте не
     * вызывается» этот проект ловил трижды.
     */
    const prompts = await seedPrompts();
    const { sender, all, buttons } = recordingSender();

    await testDb().insert(items).values({
      userId,
      text: 'Договориться с няней, чтобы приходила не в 11, а в 9',
      type: 'TASK',
      priority: 'SOON',
      topic: 'семья',
    });

    await queuedBatchOf([{ kind: 'text', text: 'нет, няня пусть приходит в 9 30', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'нет, няня пусть приходит в 9 30' }],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'append',
        itemId: '1',
        confidence: 0.95,
        changes: {
          note: 'приходит в 9 30',
          text: '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'уточнение времени',
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

    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    const nanny = saved.find((one) => one.text.includes('няней'));

    // Слова человека сохранены — это и раньше работало.
    expect(nanny?.body).toBe('приходит в 9 30');

    // А теперь реплика не молчит о том, что заголовок остался прежним.
    const told = all.join(' | ');
    expect(told).toContain('Сам заголовок не меняла');
    expect(told).toContain('а в 9');

    // И рядом кнопка, которой это поправить одним нажатием.
    expect(buttons).toContain(defaultTexts.resolver.buttonEditTitle);
    expect(buttons).toContain(defaultTexts.resolver.buttonUndo);
  });

  it('«а ещё» без отсылки назад остаётся новой мыслью', async () => {
    // Перечисление — самый частый случай этой связки, и ломать его нельзя.
    const prompts = await seedPrompts();

    await queuedBatchOf([
      { kind: 'text', text: 'а ещё надо забрать вещи из химчистки', offsetMs: 0 },
    ]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm: echoingLlm() }),
      },
      userId,
    );

    const saved = await testDb().select().from(items).where(eq(items.userId, userId));

    expect(
      saved
        .filter((one) => !one.isDraft)
        .map((one) => one.text)
        .join(' '),
    ).toMatch(/химчистк/iu);
  });
});

describe('сводки веток после правок (§8)', () => {
  /**
   * Найдено ручным прогоном 31.08.2026. Обновление сводок звалось только
   * с темами **новых** записей и стояло после раннего выхода: выгрузка из
   * одной правки до него не доходила вовсе. Поправил срок — в ветке
   * старый, закрыл дело — в ветке открыто.
   *
   * §8 обещает «сводка ветки обновляется редактированием».
   */
  it('закрытие дела обновляет сводку его ветки', async () => {
    const prompts = await seedPrompts();
    const gateway = new FakeTopicGateway();

    await testDb()
      .insert(topics)
      .values([{ userId, name: 'работа', sortOrder: 0, isDefault: true }]);

    const [work] = await testDb().select().from(topics).where(eq(topics.name, 'работа'));
    await ensureThread({ db: testDb(), gateway }, { topicId: work!.id, chatId: 700 });

    const [item] = await testDb()
      .insert(items)
      .values({ userId, text: 'Сверить кассу', type: 'TASK', priority: 'SOON', topic: 'работа' })
      .returning({ id: items.id });

    // Сводка на месте до правки — дальше смотрим, изменилась ли она.
    const before = gateway.sent.length + gateway.edited.length;

    await queuedBatchOf([{ kind: 'text', text: 'кассу сверила', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'COMPLETE', text: 'кассу сверила' }],
      }),
      resolver: JSON.stringify({
        action: 'complete',
        mode: 'replace',
        itemId: '1',
        confidence: 0.95,
        changes: {
          note: '',
          text: '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'дело названо сделанным',
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
          topics: gateway,
        }),
      },
      userId,
    );

    const [closed] = await testDb().select().from(items).where(eq(items.id, item!.id));
    expect(closed?.status).toBe('done');

    // Сводка ветки тронута, и в ней больше нет закрытого дела.
    expect(gateway.sent.length + gateway.edited.length).toBeGreaterThan(before);
    expect(gateway.edited.at(-1)?.text ?? '').not.toContain('Сверить кассу');
  });
});

describe('журнал непонятого (заказчица, 16.09.2026, панель п. 3)', () => {
  /**
   * «Сколько раз бот не понял пользователя за период; по клику — что
   * написала и что ответил.» Строка пишется у самой отправки, по реплике
   * сдачи из словаря: место в коде записывать не нужно, и новое место
   * сдачи журнал не пропустит.
   */
  const NOTHING_FOUND = JSON.stringify({
    action: 'new',
    mode: 'append',
    itemId: '',
    confidence: 0.9,
    changes: {
      note: '',
      text: '',
      deadline: '',
      deadlineAccuracy: 'none',
      recurrenceKind: 'none',
      recurrenceInterval: 0,
      recurrenceText: '',
    },
    reason: 'подходящей записи нет',
  });

  async function logged(): Promise<
    { said: string; replied: string; reason: string; kind: string }[]
  > {
    const rows = await testDb()
      .select()
      .from(misunderstood)
      .where(eq(misunderstood.userId, userId));
    return rows.map((row) => ({
      said: row.said,
      replied: row.replied,
      reason: row.reason,
      kind: row.kind,
    }));
  }

  async function run(
    llm: MockLlmProvider,
    sender: StatusSender,
    embedder?: MockEmbeddingProvider,
  ): Promise<void> {
    const prompts = await seedPrompts();
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender, embedder }),
      },
      userId,
    );
  }

  it('«ничего не записано» на вопрос по бэклогу — строка с её словами и ответом', async () => {
    const { sender } = recordingSender();
    await queuedBatchOf([{ kind: 'text', text: 'что там с котом', offsetMs: 0 }]);

    await run(
      echoingLlm({
        router: JSON.stringify({
          crisis: false,
          segments: [{ intent: 'QUERY', text: 'что там с котом' }],
        }),
      }),
      sender,
      new MockEmbeddingProvider(),
    );

    expect(await logged()).toEqual([
      {
        said: 'что там с котом',
        replied: defaultTexts.backlog.nothing,
        reason: 'backlog.nothing',
        kind: 'meaning',
      },
    ]);
  });

  it('«не смогла заглянуть в записи» (вектор не посчитался) — тоже сдача, со своей причиной', async () => {
    const { sender } = recordingSender();
    await queuedBatchOf([{ kind: 'text', text: 'что там с котом', offsetMs: 0 }]);

    await run(
      echoingLlm({
        router: JSON.stringify({
          crisis: false,
          segments: [{ intent: 'QUERY', text: 'что там с котом' }],
        }),
      }),
      sender,
    );

    // Вектор не посчитался — это сбой системы, не «не поняла формулировку».
    expect((await logged()).map((row) => [row.reason, row.kind])).toEqual([
      ['backlog.unavailable', 'system'],
    ]);
  });

  it('«расскажешь, что в голове?» на пустую болтовню — тоже', async () => {
    const { sender } = recordingSender();
    await queuedBatchOf([{ kind: 'text', text: 'ну вот', offsetMs: 0 }]);

    await run(
      echoingLlm({
        router: JSON.stringify({
          crisis: false,
          segments: [{ intent: 'SMALLTALK', text: 'ну вот' }],
        }),
      }),
      sender,
    );

    expect(await logged()).toEqual([
      {
        said: 'ну вот',
        replied: defaultTexts.answer.nothingToParse,
        reason: 'answer.nothingToParse',
        kind: 'meaning',
      },
    ]);
  });

  it('«такого дела не было» — строка с выгрузкой целиком, даже когда рядом заведено дело', async () => {
    const { sender } = recordingSender();
    const SAID = 'Разобрать балкон. Мусор я уже вынес, можно убрать';
    await queuedBatchOf([{ kind: 'text', text: SAID, offsetMs: 0 }]);

    await run(
      echoingLlm({
        router: JSON.stringify({
          crisis: false,
          segments: [
            { intent: 'DUMP', text: 'Разобрать балкон' },
            { intent: 'COMPLETE', text: 'Мусор я уже вынес, можно убрать' },
          ],
        }),
        resolver: NOTHING_FOUND,
      }),
      sender,
    );

    const rows = await logged();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.said).toBe(SAID);
    expect(rows[0]?.reason).toBe('resolver.nothingToClose');
    expect(rows[0]?.kind).toBe('meaning');
    expect(rows[0]?.replied).toContain(defaultTexts.resolver.nothingToClose);
  });

  it('извлечение не ответило — «сохранила целиком» помечено сбоем, а не непониманием', async () => {
    // Та же реплика, что при нуле единиц, но причина — наш сбой: модель
    // извлечения не ответила. В «Не поняла» такому не место — во «Ошибки».
    const { sender } = recordingSender();
    await queuedBatchOf([{ kind: 'text', text: 'купить хлеб', offsetMs: 0 }]);

    await run(echoingLlm({ extractor: 'это не JSON' }), sender);

    const rows = await logged();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('system');
    expect(rows[0]?.reason).toMatch(/^answer\.savedUnparsed: извлечение/u);
    expect(rows[0]?.replied).toBe(defaultTexts.answer.savedUnparsed);
  });

  it('обычный разбор, «спасибо» и список дел строк не пишут', async () => {
    const { sender } = recordingSender();
    await testDb()
      .insert(items)
      .values({ userId, text: 'Заказать цветы', type: 'TASK', priority: 'SOON', topic: 'личное' });
    await queuedBatchOf([{ kind: 'text', text: 'Покажи все мои задачи', offsetMs: 0 }]);
    await run(
      echoingLlm({
        router: JSON.stringify({
          crisis: false,
          segments: [{ intent: 'QUERY', text: 'Покажи все мои задачи' }],
        }),
      }),
      sender,
    );

    await queuedBatchOf([{ kind: 'text', text: 'Спасибо!', offsetMs: 0 }]);
    await run(
      echoingLlm({
        router: JSON.stringify({
          crisis: false,
          segments: [{ intent: 'SMALLTALK', text: 'Спасибо!' }],
        }),
      }),
      sender,
    );

    await queuedBatchOf([{ kind: 'text', text: 'купить хлеб и молоко', offsetMs: 0 }]);
    await run(echoingLlm(), sender);

    expect(await logged()).toEqual([]);
  });
});

describe('«уже сделала» без такой записи (прогон Никиты 15.09.2026, находка 5)', () => {
  /**
   * «Мусор я уже вынес, так что это можно убрать» → бот завёл открытое дело
   * «Вынести мусор». Маршрутизатор отдал отрезок как закрытие, резолвер
   * честно ответил «подходящей записи нет» — и развилка конвейера сделала
   * из «нет записи» новую мысль. Для правки это верно («нет, в пятницу» без
   * цели — мысль), для закрытия и отмены — нет: сказанное как о сделанном
   * не имеет права стать новой задачей, что бы ни ответила модель.
   */
  const SAID = 'мусор я уже вынес, так что это можно убрать';
  const NOTHING_FOUND = JSON.stringify({
    action: 'new',
    mode: 'append',
    itemId: '',
    confidence: 0.9,
    changes: {
      note: '',
      text: '',
      deadline: '',
      deadlineAccuracy: 'none',
      recurrenceKind: 'none',
      recurrenceInterval: 0,
      recurrenceText: '',
    },
    reason: 'подходящей записи нет',
  });

  async function rowsOfUser(): Promise<{ text: string; isDraft: boolean; status: string }[]> {
    const rows = await testDb().select().from(items).where(eq(items.userId, userId));
    return rows.map((row) => ({ text: row.text, isDraft: row.isDraft, status: row.status }));
  }

  it('закрытие без цели — не задача, а «такого дела не было»; слова — в черновик', async () => {
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();
    await testDb()
      .insert(items)
      .values({ userId, text: 'Оплатить садик', type: 'TASK', priority: 'SOON', topic: 'личное' });

    await queuedBatchOf([{ kind: 'text', text: SAID, offsetMs: 0 }]);
    const llm = echoingLlm({
      router: JSON.stringify({ crisis: false, segments: [{ intent: 'COMPLETE', text: SAID }] }),
      resolver: NOTHING_FOUND,
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const rows = await rowsOfUser();
    expect(rows.filter((row) => !row.isDraft).map((row) => row.text)).toEqual(['Оплатить садик']);
    expect(rows.filter((row) => row.isDraft).map((row) => row.text)).toEqual([SAID]);
    expect(all.at(-1) ?? '').toContain(defaultTexts.resolver.nothingToClose);
  });

  it('отмена без цели — то же: «убери стоматолога» не заводит стоматолога', async () => {
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();
    await testDb()
      .insert(items)
      .values({ userId, text: 'Оплатить садик', type: 'TASK', priority: 'SOON', topic: 'личное' });

    await queuedBatchOf([{ kind: 'text', text: 'убери стоматолога', offsetMs: 0 }]);
    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'CANCEL', text: 'убери стоматолога' }],
      }),
      resolver: NOTHING_FOUND,
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const rows = await rowsOfUser();
    expect(rows.filter((row) => !row.isDraft).map((row) => row.text)).toEqual(['Оплатить садик']);
    expect(all.at(-1) ?? '').toContain(defaultTexts.resolver.nothingToClose);
  });

  it('в одной выгрузке с делами: дела заводятся, «уже вынес» — нет, ответ честный', async () => {
    // Тот самый случай с боя: «Разобрать балкон, …, выкинуть мусор» и
    // «мусор я уже вынес» в одном сообщении. Цель могла быть среди только
    // что сказанного — конвейер пробует ещё раз после сохранения; модель
    // и тут отвечает «нет записи» — значит, черновик и честное слово.
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();
    const BALCONY = 'Разобрать балкон, убрать коробки, выкинуть мусор';

    await queuedBatchOf([{ kind: 'text', text: `${BALCONY}. ${SAID}`, offsetMs: 0 }]);
    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'DUMP', text: BALCONY },
          { intent: 'COMPLETE', text: SAID },
        ],
      }),
      resolver: NOTHING_FOUND,
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const rows = await rowsOfUser();
    expect(rows.filter((row) => !row.isDraft).map((row) => row.text)).toEqual([BALCONY]);
    expect(rows.filter((row) => row.isDraft).map((row) => row.text)).toEqual([SAID]);
    expect(all.join('\n')).toContain(defaultTexts.resolver.nothingToClose);
  });

  it('правка без цели по-прежнему становится мыслью: «нет записи» для неё — новое дело', async () => {
    const prompts = await seedPrompts();
    const { sender } = recordingSender();
    await testDb()
      .insert(items)
      .values({ userId, text: 'Оплатить садик', type: 'TASK', priority: 'SOON', topic: 'личное' });
    const THOUGHT = 'ещё батарейки купить для весов';

    await queuedBatchOf([{ kind: 'text', text: THOUGHT, offsetMs: 0 }]);
    const llm = echoingLlm({
      router: JSON.stringify({ crisis: false, segments: [{ intent: 'PATCH', text: THOUGHT }] }),
      resolver: NOTHING_FOUND,
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const rows = await rowsOfUser();
    // Заголовок чистится и пишется с большой буквы — сравниваем без регистра.
    expect(rows.filter((row) => !row.isDraft).map((row) => row.text.toLowerCase())).toContain(
      THOUGHT,
    );
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
            deadlineText: '',
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

  it('модель отнесла дело в тему по умолчанию, а писали из ветки — уходит в ветку', async () => {
    /**
     * **Проверка выше зелёная, но в бою не исполняется.** Она отдаёт от
     * модели тему «выдуманная», которой у человека нет, и меряет
     * подстановку на неизвестной теме. Живая модель всегда называет тему
     * из выданного списка, поэтому та подстановка не срабатывает никогда.
     *
     * Здесь модель отвечает как настоящая — темой по умолчанию, — и это
     * тот самый случай с боевого бота 29.08.2026: «позвонить Марине
     * насчёт вторника» из ветки «здоровье» легло в «личное».
     */
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

    await queuedBatchOf([
      { kind: 'text', text: 'позвонить Марине', offsetMs: 0, threadId: thread.threadId },
    ]);

    const llm = echoingLlm({
      classifier: JSON.stringify({
        items: [
          {
            text: 'позвонить Марине',
            type: 'TASK',
            priority: 'SOON',
            topic: 'личное',
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

  it('явно названная сфера веткой не перебивается', async () => {
    // Ветка — контекст по умолчанию, а не приказ: покупки остаются
    // покупками, даже если сказаны из ветки «здоровье».
    const prompts = await seedPrompts();
    const gateway = new FakeTopicGateway();

    await testDb()
      .insert(topics)
      .values([
        { userId, name: 'здоровье', sortOrder: 0 },
        { userId, name: 'покупки', sortOrder: 1 },
        { userId, name: 'личное', sortOrder: 2, isDefault: true },
      ]);

    const [health] = await testDb().select().from(topics).where(eq(topics.name, 'здоровье'));
    const thread = await ensureThread(
      { db: testDb(), gateway },
      { topicId: health!.id, chatId: 700 },
    );

    await queuedBatchOf([
      { kind: 'text', text: 'купить корм коту', offsetMs: 0, threadId: thread.threadId },
    ]);

    const llm = echoingLlm({
      classifier: JSON.stringify({
        items: [
          {
            text: 'купить корм коту',
            type: 'TASK',
            priority: 'SOON',
            topic: 'покупки',
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
    expect(saved?.topic).toBe('покупки');
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
            deadlineText: '',
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
    expect(gateway.sent[0]?.text).toContain('К врачу');
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
    expect(all.at(-1)).toContain(defaultTexts.answer.keepOrPick);
    expect(await pickedNow()).toContain('К врачу');
  });

  it('«Какие еще 3» в ветке под сводкой — полный список дел ветки, без модели (живая проверка 24.09.2026)', async () => {
    /**
     * Сводка ветки показывает 15 дел и «И ещё N.». Никита спросил в ветке
     * «Какие еще 5» — бот ответил «Я здесь. Расскажешь, что в голове?», и
     * фраза легла в журнал непонятого: вопрос ушёл модели ответов, а она
     * о сводке не знает. Теперь — полный список этой ветки, мимо модели.
     */
    const prompts = await seedPrompts();
    const gateway = new FakeTopicGateway();
    await testDb()
      .insert(topics)
      .values([{ userId, name: 'личное', sortOrder: 0, isDefault: true }]);
    const [personal] = await testDb().select().from(topics).where(eq(topics.name, 'личное'));
    const thread = await ensureThread(
      { db: testDb(), gateway },
      { topicId: personal!.id, chatId: 700 },
    );
    const titles = Array.from({ length: 18 }, (_, index) => `Дело номер ${String(index + 1)}`);
    await testDb()
      .insert(items)
      .values(
        titles.map((text) => ({
          userId,
          text,
          type: 'TASK' as const,
          priority: 'SOON' as const,
          topic: 'личное',
        })),
      );
    const { sender, all } = recordingSender();
    const llm = echoingLlm();

    await queuedBatchOf([
      { kind: 'text', text: 'Какие еще 3', offsetMs: 0, threadId: thread.threadId },
    ]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm,
          sender,
          topics: gateway,
        }),
      },
      userId,
    );

    const reply = all.join('\n');
    for (const title of titles) expect(reply).toContain(title);
    expect(reply).not.toContain(defaultTexts.answer.nothingToParse);
    // Модель не звалась вовсе: список — из базы, кодом.
    expect(llm.callCount).toBe(0);
    const misread = await testDb()
      .select()
      .from(misunderstood)
      .where(eq(misunderstood.userId, userId));
    expect(misread).toEqual([]);
    // Новых дел из вопроса не появилось.
    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(saved).toHaveLength(titles.length);
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
/**
 * Одна реплика человеку: чем отправлена, что сказано, что под ней.
 *
 * Нужна из-за дефекта 31.08.2026: правка статусного сообщения затирала
 * предыдущую реплику вместе с кнопкой отката, а список текстов этого не
 * показывал — в нём обе строки были на месте. Проверять надо способ
 * отправки и кнопки **каждого** сообщения, а не последнего.
 */
interface Said {
  readonly kind: 'send' | 'edit';
  readonly text: string;
  readonly buttons: readonly string[];
  /** Что несут кнопки — чтобы сверить показанный вопрос с открытым в базе. */
  readonly actions: readonly string[];
}

function recordingSender(): {
  sender: StatusSender;
  sent: string[];
  edited: string[];
  all: string[];
  /** Подписи кнопок последнего сообщения: §13.2 требует их под разбором. */
  buttons: string[];
  said: Said[];
} {
  const sent: string[] = [];
  const edited: string[] = [];
  const all: string[] = [];
  const buttons: string[] = [];
  const said: Said[] = [];

  /** Кнопки запоминаются от последнего сообщения, а не копятся. */
  const remember = (labels: readonly { readonly label: string }[] | undefined): void => {
    buttons.length = 0;
    for (const button of labels ?? []) buttons.push(button.label);
  };

  const labels = (keys: readonly { readonly label: string }[] | undefined): string[] =>
    (keys ?? []).map((one) => one.label);
  const actions = (keys: readonly { readonly action: string }[] | undefined): string[] =>
    (keys ?? []).map((one) => one.action);

  return {
    sent,
    edited,
    all,
    buttons,
    said,
    sender: {
      send: ({ text, buttons: keys }) => {
        sent.push(text);
        all.push(text);
        said.push({ kind: 'send', text, buttons: labels(keys), actions: actions(keys) });
        remember(keys);
        return Promise.resolve(1000 + sent.length);
      },
      edit: ({ text, buttons: keys }) => {
        edited.push(text);
        all.push(text);
        said.push({ kind: 'edit', text, buttons: labels(keys), actions: actions(keys) });
        remember(keys);
        return Promise.resolve('edited' as const);
      },
    },
  };
}

/** Считает показанные карточки: какая, с какой подписью и кнопками. */
function recordingCards(): {
  cards: CardSender;
  shown: { card: string; caption: string; buttons: string[] }[];
} {
  const shown: { card: string; caption: string; buttons: string[] }[] = [];
  return {
    shown,
    cards: {
      send: ({ card, caption, buttons }) => {
        shown.push({ card, caption, buttons: (buttons ?? []).map((one) => one.label) });
        return Promise.resolve(5000 + shown.length);
      },
    },
  };
}

describe('бренд-карточки (ТЗ по визуалам, проджект 18.09.2026)', () => {
  it('«На сегодня всё» — карточка вечера без кнопок, без разбора и без обращения к модели', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'Ладно, на сегодня всё.', offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    const { cards, shown } = recordingCards();
    const llm = echoingLlm();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender, cards, llm }),
      },
      userId,
    );

    expect(shown).toEqual([{ card: 'evening', caption: defaultTexts.cards.evening, buttons: [] }]);
    expect(llm.requests).toHaveLength(0);
    // Записей не появилось, текстового итога тоже: карточка и есть ответ.
    expect(await testDb().select().from(items).where(eq(items.userId, userId))).toHaveLength(0);
    expect(all.filter((text) => text === defaultTexts.cards.evening)).toHaveLength(0);
  });

  it('без карточек «На сегодня всё» отвечается теми же словами текстом', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'На сегодня хватит', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender }),
      },
      userId,
    );

    expect(all.at(-1)).toBe(defaultTexts.cards.evening);
  });

  it('вопрос про неделю — карточка недели с подписью, списком и кнопками «Выбрать главное · Мои дела»', async () => {
    const prompts = await seedPrompts();
    await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Сдать отчёт',
        type: 'TASK',
        priority: 'SOON',
        topic: 'работа',
        status: 'new',
        // Часы разбора — `at(60_000)` от T0: срок через два дня от них.
        deadlineAt: new Date(T0.getTime() + 2 * 24 * 60 * 60_000),
        deadlineAccuracy: 'day',
      });
    await queuedBatchOf([{ kind: 'text', text: 'Что у меня на неделе?', offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    const { cards, shown } = recordingCards();
    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'Что у меня на неделе?' }],
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender, cards, llm }),
      },
      userId,
    );

    expect(shown).toHaveLength(1);
    expect(shown[0]?.card).toBe('week');
    expect(shown[0]?.caption.startsWith(defaultTexts.cards.week)).toBe(true);
    expect(shown[0]?.caption).toContain('Сдать отчёт');
    expect(shown[0]?.buttons).toEqual([
      defaultTexts.answer.buttonPick,
      defaultTexts.cards.buttonMyTasks,
    ]);
    // Список не дублируется текстом.
    expect(all.some((text) => text.includes('Сдать отчёт'))).toBe(false);
  });

  it('«на 3 дня» и «во вторник» — отрезки с подписью словами (21.09.2026)', async () => {
    /**
     * Никита 21.09.2026: «а на 3 дня, 7 дней, месяц отвечает?» Не отвечал
     * — уходил в поиск предмета и «не поняла». Подпись отрезка — из
     * текстов: «На 3 дня у тебя вот это:», «На вторник ничего не
     * назначено.»
     */
    const prompts = await seedPrompts();
    await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Сдать отчёт',
        type: 'TASK',
        priority: 'SOON',
        topic: 'работа',
        status: 'new',
        deadlineAt: new Date(T0.getTime() + 24 * 60 * 60_000),
        deadlineAccuracy: 'day',
      });
    await queuedBatchOf([{ kind: 'text', text: 'Что у меня на 3 дня?', offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'Что у меня на 3 дня?' }],
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender, llm }),
      },
      userId,
    );

    const reply = all.at(-1) ?? '';
    expect(reply.startsWith(defaultTexts.backlog.period('3 дня'))).toBe(true);
    expect(reply).toContain('Сдать отчёт');
  });

  it('«что у меня на завтра»: слово дня из названия срезано, час из срока виден (проверка Никиты 25.09.2026, 03:29)', async () => {
    /**
     * Бой: «На завтра у тебя вот это: — Встретить курьера послезавтра» —
     * срок 26.09 21:00, то есть завтра; «послезавтра» осталось в названии
     * со дня записи, а часа видно не было.
     */
    const prompts = await seedPrompts();
    // T0 — 24.08 13:00 МСК; завтра — 25.08, полночь по Москве.
    const tomorrow = new Date('2026-08-24T21:00:00.000Z');
    await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Встретить курьера послезавтра',
        type: 'TASK',
        priority: 'SOON',
        topic: 'дом',
        status: 'new',
        deadlineAt: tomorrow,
        deadlineAccuracy: 'day',
        deadlineTime: 21 * 60,
      });
    await queuedBatchOf([{ kind: 'text', text: 'Что у меня на завтра', offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'Что у меня на завтра' }],
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender, llm }),
      },
      userId,
    );

    const reply = all.at(-1) ?? '';
    expect(reply.startsWith(defaultTexts.backlog.period('завтра'))).toBe(true);
    expect(reply).toContain('— Встретить курьера · 21:00');
    expect(reply).not.toContain('послезавтра');
  });

  it('«что просрочено», «сколько у меня дел», «с чего начать» — списки по признаку словами (21.09.2026)', async () => {
    const prompts = await seedPrompts();
    await testDb()
      .insert(items)
      .values([
        {
          userId,
          text: 'Сдать отчёт',
          type: 'TASK',
          priority: 'SOON',
          topic: 'работа',
          status: 'new',
          deadlineAt: new Date(T0.getTime() - 3 * 24 * 60 * 60_000),
          deadlineAccuracy: 'day',
        },
        {
          userId,
          text: 'Купить хлеб',
          type: 'TASK',
          priority: 'NOW',
          topic: 'покупки',
          status: 'new',
        },
      ]);

    const ask = async (text: string): Promise<readonly string[]> => {
      await queuedBatchOf([{ kind: 'text', text, offsetMs: 0 }]);
      const { sender, all } = recordingSender();
      const llm = echoingLlm({
        router: JSON.stringify({ crisis: false, segments: [{ intent: 'QUERY', text }] }),
      });
      await processUserBatches(
        {
          db: testDb(),
          lock,
          handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender, llm }),
        },
        userId,
      );
      return all;
    };

    const overdue = (await ask('что у меня просрочено?')).at(-1) ?? '';
    expect(overdue.split(NEWLINE)).toEqual([defaultTexts.backlog.overdue, '— Сдать отчёт']);

    const count = (await ask('сколько у меня дел')).at(-1) ?? '';
    expect(count).toBe(defaultTexts.backlog.count('2 дела', 1, 1, 0));

    const pick = (await ask('с чего начать')).at(-1) ?? '';
    // Тот же выбор, что у кнопки «Выбрать главное»: просроченное и срочное.
    expect(pick).toContain('Сдать отчёт');
    expect(pick).toContain('Купить хлеб');

    const later = (await ask('что на потом')).at(-1) ?? '';
    expect(later).toBe(defaultTexts.backlog.laterEmpty);
  });
});

describe('ответ пользователю', () => {
  it('под разбором стоят две кнопки: «Оставить как есть» и «Выбрать главное» с кодом выгрузки', async () => {
    // Решение заказчицы 15.09.2026: дел под признанием нет, они по
    // кнопке. Код выгрузки в кнопке — чтобы сказанное в ней шло первым.
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'надо продукты, врача и химчистку', offsetMs: 0 }]);
    const { sender, buttons, said } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender }),
      },
      userId,
    );

    expect(buttons).toEqual([defaultTexts.answer.buttonKeep, defaultTexts.answer.buttonPick]);
    const [batch] = await testDb().select({ id: batches.id }).from(batches);
    expect(said.at(-1)?.actions).toEqual([
      ANSWER_ACTION.keep,
      `${ANSWER_ACTION.pick}:${toShortId(batch!.id)}`,
    ]);
  });
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
    expect(edited.at(-1)).toContain(defaultTexts.answer.keepOrPick);
    expect(await pickedNow()).toContain('Купить продукты');
  });

  it('отвечает по образцу 16.09.2026: «Всё, забрала…», раскладка и один вопрос — оставить или выбрать', async () => {
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
    expect(reply.startsWith('Всё, забрала.')).toBe(true);
    expect(reply).not.toContain('Записать сына к врачу');
    expect(reply).toContain(defaultTexts.answer.keepOrPick);
    expect(countQuestions(reply)).toBe(1);

    // А дела — по кнопке, сказанное в этой выгрузке первым.
    const [batch] = await testDb().select({ id: batches.id }).from(batches);
    const picked = await pickMain(testDb(), {
      userId,
      batchId: batch!.id,
      now: at(0),
      timeZone: 'Europe/Moscow',
    });
    expect(picked.actions).toEqual(['Записать сына к врачу', 'И ещё забрать вещи']);
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
      edit: () => Promise.resolve('edited' as const),
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
  it('без имени в профиле опрос спрашивает имя прямо', async () => {
    /**
     * **Раньше шаг пропускался и опрос начинался с пояса.** Довод был
     * верен для своего времени: написать своё имя было нельзя, и
     * единственным исходом оставался вопрос «Называть тебя .?» — а он
     * читается как сбой.
     *
     * С задачи 3.61 своё имя написать можно, и правило перевернулось:
     * человек без имени в профиле стал единственным, кого не спрашивают
     * никогда. Теперь спрашивают всех, только непригодное имя в вопрос
     * не подставляют.
     */
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

    expect(questions.asked).toEqual([defaultTexts.onboarding.nameUnknown]);

    const [settings] = await testDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    expect(settings?.onboardingStep).toBe(STEP.name);
  });

  it('застрявший опрос дозадаётся, а разбор своего вопроса не задаёт', async () => {
    /**
     * Человек мог наговорить ещё раз, не ответив. Прежде тот вопрос
     * «никуда не делся» лишь на словах: заново его никто не задавал, и
     * кто стал говорить дальше, оставался на своём шаге навсегда. Так
     * проджект заказчицы простоял сутки на вопросе про вечер — и без
     * последнего шага у него не появилось ни одной сферы (задача 3.43).
     *
     * §13.9 при этом цел: свой вопрос разбор не задаёт, место занимает
     * вопрос опроса — один на реплику.
     */
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
    expect(reply).not.toContain(defaultTexts.answer.keepOrPick);
    expect(countQuestions(reply)).toBe(0);
    expect(await pickedNow()).toContain('Ещё одно дело');

    // Вопрос текущего шага задан заново — тот же, про утро, а не
    // следующий: шаг человек не проходил.
    expect(questions.asked).toHaveLength(1);
    expect(questions.asked[0]).toBe(defaultTexts.onboarding.morning);

    const [settings] = await testDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    expect(settings?.onboardingStep).toBe(STEP.morning);
  });
});

describe('пустая выгрузка при открытом вопросе (прогон Никиты 17.09.2026, находка 19)', () => {
  /**
   * «Привет», написанное до кнопки «Согласна», разбирается сразу после
   * неё — поверх открытого первого вопроса опроса «Как мне тебя
   * называть?». Разбирать там нечего, и бот отвечал «Я здесь.
   * Расскажешь, что в голове?» — второй вопрос над первым, два вопроса
   * подряд разными сообщениями (§13.9: один вопрос на обмен).
   * При открытом вопросе ответ на пустую выгрузку — утверждение без «?».
   */
  it('«привет» поверх вопроса опроса — «Я здесь.» без второго вопроса', async () => {
    const prompts = await seedPrompts();
    await testDb()
      .update(userSettings)
      .set({ onboardingStep: STEP.name })
      .where(eq(userSettings.userId, userId));

    await queuedBatchOf([{ kind: 'text', text: 'привет', offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    const questions = recordingQuestions();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm({
            router: JSON.stringify({
              crisis: false,
              segments: [{ intent: 'SMALLTALK', text: 'привет' }],
            }),
          }),
          sender,
          onboarding: questions.sender,
        }),
      },
      userId,
    );

    expect(all.at(-1)).toBe(defaultTexts.answer.nothingToParseQuiet);
    expect(all).not.toContain(defaultTexts.answer.nothingToParse);
    for (const said of all) expect(countQuestions(said), said).toBe(0);
    expect(await testDb().select().from(items).where(eq(items.userId, userId))).toEqual([]);
  });

  it('опрос пройден — «привет» по-прежнему получает «Расскажешь, что в голове?»', async () => {
    const prompts = await seedPrompts();
    await testDb()
      .update(userSettings)
      .set({ onboardingStep: STEP.done })
      .where(eq(userSettings.userId, userId));

    await queuedBatchOf([{ kind: 'text', text: 'привет', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm({
            router: JSON.stringify({
              crisis: false,
              segments: [{ intent: 'SMALLTALK', text: 'привет' }],
            }),
          }),
          sender,
        }),
      },
      userId,
    );

    expect(all.at(-1)).toBe(defaultTexts.answer.nothingToParse);
  });
});

describe('сферы появляются только с содержимым (заказчица 16.09.2026)', () => {
  /**
   * Было (задача 3.43): базовый набор из пяти сфер и все пять веток на
   * первой разобранной выгрузке — «человек видит структуру целиком».
   * Заказчица по видео 15.09: «про здоровье ничего не говорила, про
   * личное тоже, а он сразу насоздавал много тем… кто не в теме — зачем
   * это?». Теперь сфера появляется вместе с первой записью в неё; базовые
   * имена остаются подсказкой модели, а не заготовкой веток.
   */

  async function topicNames(): Promise<string[]> {
    const rows = await testDb().select().from(topics).where(eq(topics.userId, userId));
    return rows.map((row) => row.name).sort();
  }

  /** Классификация кладёт всё в названную сферу. */
  const classifierInto = (topic: string) => (request: { readonly input: string }) =>
    JSON.stringify({
      items: unitsFromInput(request.input).map((text) => ({
        text,
        type: 'TASK',
        priority: 'SOON',
        topic,
        isProject: false,
        deadline: '',
        deadlineAccuracy: 'none',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
        deadlineText: '',
      })),
    });

  it('первая выгрузка заводит одну сферу — ту, куда легла запись, без пустых веток', async () => {
    const prompts = await seedPrompts();
    const gateway = new FakeTopicGateway();
    expect(await topicNames()).toEqual([]);

    // Без маркеров быстрого добавления («запиши», «ещё»): ему итог не положен.
    await queuedBatchOf([{ kind: 'text', text: 'сходить с сыном к врачу', offsetMs: 0 }]);
    const { sender, all } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm({ classifier: classifierInto('здоровье') }),
          sender,
          topics: gateway,
        }),
      },
      userId,
    );

    expect(await topicNames()).toEqual(['здоровье']);
    expect(gateway.created.map((thread) => thread.name)).toEqual(['здоровье']);
    // Итог — одним сообщением: раскладка по сферам и «Всё сохранила» (п. 3).
    const summary = all.find((text) => text.includes(defaultTexts.answer.keepOrPick)) ?? '';
    expect(summary).toContain('💊 Здоровье — 1');
    // Ни одной сводки «Пока пусто»: пустых веток нет.
    expect(gateway.sent.some((message) => message.text.includes(defaultTexts.summary.empty))).toBe(
      false,
    );

    const [saved] = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(saved?.topicId).not.toBeNull();
  });

  it('следующая выгрузка добавляет только свою сферу и трогает только своё', async () => {
    const prompts = await seedPrompts();
    const gateway = new FakeTopicGateway();

    await queuedBatchOf([{ kind: 'text', text: 'записать сына к врачу', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm({ classifier: classifierInto('здоровье') }),
          topics: gateway,
        }),
      },
      userId,
    );
    const writesAfterFirst = gateway.writes;

    await queuedBatchOf([{ kind: 'text', text: 'купить продукты', offsetMs: 120_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm({ classifier: classifierInto('покупки') }),
          topics: gateway,
          now: at(180_000),
        }),
      },
      userId,
    );

    expect(await topicNames()).toEqual(['здоровье', 'покупки']);
    expect(gateway.created.map((thread) => thread.name)).toEqual(['здоровье', 'покупки']);
    // Сводка — только у новой ветки, «здоровье» не перерисовано.
    expect(gateway.writes - writesAfterFirst).toBe(1);
  });

  it('«личное», заведённое под запись, — тема по умолчанию', async () => {
    const prompts = await seedPrompts();
    const gateway = new FakeTopicGateway();

    await queuedBatchOf([{ kind: 'text', text: 'разобрать балкон', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, topics: gateway }),
      },
      userId,
    );

    const rows = await testDb().select().from(topics).where(eq(topics.userId, userId));
    expect(rows.map((row) => [row.name, row.isDefault])).toEqual([['личное', true]]);
  });

  it('выгрузка без разбора сферы не создаёт', async () => {
    // «Привет» — не повод строить человеку структуру жизни.
    const prompts = await seedPrompts();
    const gateway = new FakeTopicGateway();

    await queuedBatchOf([{ kind: 'text', text: 'привет', offsetMs: 0 }]);
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
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, topics: gateway }),
      },
      userId,
    );

    expect(await topicNames()).toEqual([]);
    expect(gateway.created).toHaveLength(0);
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
    // Признание собирается кодом (16.09.2026): у презентера вызова нет.
    expect(byStage.get('presenter')).toBeUndefined();
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
    expect(all[0]).toContain(defaultTexts.answer.keepOrPick);
    expect(all.join(' ')).not.toMatch(/лимит|модель|дешевл|ограничен/iu);
    expect(await pickedNow()).toContain('Купить продукты');

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

describe('ответ на уточняющий вопрос голосом (§7.3, задача 3.6)', () => {
  /**
   * Связка, а не служба.
   *
   * Решение про открытый вопрос проверено своими тестами. Здесь важно
   * другое: доходит ли до него конвейер и не превращается ли «да, к
   * прошлой» в запись «да». Именно на таком разрыве — «служба работает,
   * а в боте не вызывается» — этот проект уже попадался.
   */
  /** Через неделю: заведомо будущее и заведомо ближе пяти лет. */
  function soonDate(): string {
    const at = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    return at.toISOString().slice(0, 10);
  }

  async function itemAndQuestion(segment = 'нет, в пятницу'): Promise<{ itemId: string }> {
    const [row] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Записать сына к врачу в четверг',
        type: 'TASK',
        priority: 'SOON',
        topic: 'личное',
      })
      .returning({ id: items.id });

    const [batch] = await testDb()
      .insert(batches)
      .values({ userId, status: 'done' })
      .returning({ id: batches.id });

    await askQuestion(testDb(), {
      userId,
      itemId: row!.id,
      batchId: batch!.id,
      segment,
      action: 'update',
      // Срок считается от настоящих часов: конвейер в этом тесте живёт
      // по ним, а даты дальше пяти лет разбор сроков отвергает.
      changes: {
        note: '',
        text: '',
        deadline: soonDate(),
        deadlineAccuracy: 'day',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
      },
    });

    return { itemId: row!.id };
  }

  /**
   * Разговорное согласие (проверка Никиты 24.09.2026): на «Перенести «X»?»
   * «давай» читалось непонятым ответом. Только у вопроса о переносе.
   */
  it('«давай» на «Перенести «X»?» — перенос применён', async () => {
    const prompts = await seedPrompts();
    const { itemId } = await itemAndQuestion('перенеси врача на пятницу');
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'давай', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider({}),
          prompts,
          sender,
          llmLight: echoingLlm({
            router: JSON.stringify({
              crisis: false,
              segments: [{ intent: 'ANSWER', text: 'давай' }],
            }),
          }),
        }),
      },
      userId,
    );

    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.deadlineAt).not.toBeNull();
    expect(all.some((text) => text.includes('Не разобрала ответ'))).toBe(false);
  });

  it('«давай» на «Это про «X» или отдельная история?» — по-прежнему не ответ: запись не тронута', async () => {
    const prompts = await seedPrompts();
    const { itemId } = await itemAndQuestion();

    await queuedBatchOf([{ kind: 'text', text: 'давай', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider({}),
          prompts,
          llmLight: echoingLlm({
            router: JSON.stringify({
              crisis: false,
              segments: [{ intent: 'ANSWER', text: 'давай' }],
            }),
          }),
        }),
      },
      userId,
    );

    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.deadlineAt).toBeNull();
  });

  it('«да, к прошлой» правит запись и не создаёт задачу «да»', async () => {
    const prompts = await seedPrompts();
    const { itemId } = await itemAndQuestion();

    await queuedBatchOf([{ kind: 'text', text: 'да, к прошлой', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'ANSWER', text: 'да, к прошлой' }],
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider({}), prompts, llmLight: llm }),
      },
      userId,
    );

    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.deadlineAt).not.toBeNull();

    // Ни задачи «да», ни черновика «намерение ANSWER».
    const rows = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('новая выгрузка без ответа снимает вопрос и сохраняет сказанное', async () => {
    // §7.3: бот к снятому вопросу не возвращается.
    const prompts = await seedPrompts();
    await itemAndQuestion();

    await queuedBatchOf([{ kind: 'text', text: 'купить хлеб', offsetMs: 0 }]);

    await processUserBatches(
      { db: testDb(), lock, handleBatch: handler({ speech: new MockSpeechProvider({}), prompts }) },
      userId,
    );

    const [question] = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));

    expect(question?.outcome).toBe('superseded');

    const drafts = await testDb().select().from(items).where(eq(items.isDraft, true));
    expect(drafts.map((row) => row.text)).toContain('нет, в пятницу');
  });

  it('мысль, принятая за ответ, становится записью, а не правкой (задача 3.44)', async () => {
    /**
     * Живой прогон 03.09.2026: бот спросил «это про „Купить зонт" или
     * отдельная история?», человек сказал «добавь ещё купить чехол для
     * зонта». Маршрутизатор счёл это ответом, словарь прочитал «добавь»
     * как «к прошлой»: перенос применился, а «купить чехол» пропало.
     */
    const prompts = await seedPrompts();
    const { itemId } = await itemAndQuestion();
    const { sender, all, said } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'добавь ещё купить чехол для зонта', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'ANSWER', text: 'добавь ещё купить чехол для зонта' }],
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

    // Чехол стал записью, а не пропал.
    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    const cover = saved.find((row) => row.text.toLowerCase().includes('чехол'));
    expect(cover).toBeDefined();
    expect(cover?.isDraft).toBe(false);

    // Запись, о которой спрашивали, не тронута: правки не было.
    const [asked] = saved.filter((row) => row.id === itemId);
    expect(asked?.deadlineAt).toBeNull();

    // Вопрос снят, сказанное к нему сохранено черновиком.
    const [question] = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));
    expect(question?.outcome).toBe('superseded');
    expect(saved.filter((row) => row.isDraft).map((row) => row.text)).toContain('нет, в пятницу');

    // И кнопки отката нет: отменять нечего.
    expect(said.flatMap((one) => one.buttons)).not.toContain(defaultTexts.resolver.buttonUndo);
    expect(all.join(NEWLINE)).not.toContain('Перенесла');
  });

  it('ответ с лишними словами: правка применена, лишнее сохранено и названо', async () => {
    const prompts = await seedPrompts();
    await itemAndQuestion();
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'да, к прошлой, и ещё купить чехол', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'ANSWER', text: 'да, к прошлой, и ещё купить чехол' }],
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

    const drafts = await testDb().select().from(items).where(eq(items.isDraft, true));
    expect(drafts.map((row) => row.text)).toContain('купить чехол');
    expect(all.join(NEWLINE)).toContain(defaultTexts.resolver.leftoverSaved);
  });

  it('вопрос уже снят кнопкой: лишнее сохранено и названо, «расскажешь, что в голове?» не звучит', async () => {
    /**
     * Ревизия этапов 1–2, дефект 10 (закрыт коммитом 829965d).
     *
     * Кнопку нажали, пока шла расшифровка: к разбору вопроса уже нет.
     * Саму правку применила кнопка — повторять её нельзя. А слова сверх
     * ответа раньше пропадали молча, и раз в выгрузке больше ничего не
     * было, человек получал «Я здесь. Расскажешь, что в голове?» на
     * только что сказанное — то есть «я тебя не слышала».
     *
     * Связка, а не служба: спасение проверено в pending.int.test.ts.
     * Здесь важно, что разбор его слышит — говорит про черновик и не
     * добавляет следом «не поняла».
     */
    const prompts = await seedPrompts();
    const { itemId } = await itemAndQuestion();
    const [open] = await testDb()
      .select({ id: pendingQuestions.id })
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));
    // Кнопка успела раньше разбора — той же дорогой, что и в боте.
    const pressed = await answerQuestion(testDb(), {
      questionId: open!.id,
      userId,
      outcome: 'attached',
    });
    expect(pressed.kind).toBe('answered');

    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'да, к прошлой, и ещё купить чехол', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'ANSWER', text: 'да, к прошлой, и ещё купить чехол' }],
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

    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(
      saved.filter((row) => row.isDraft).map((row) => row.text),
      'слова сверх ответа пропали',
    ).toContain('купить чехол');

    const heard = all.join(NEWLINE);
    expect(heard).toContain(defaultTexts.resolver.leftoverSaved);
    expect(heard, 'человеку сказано «не поняла» на только что сказанное').not.toContain(
      defaultTexts.answer.nothingToParse,
    );

    // Правку кнопки разбор не повторил: срок так и не поставлен.
    const [asked] = saved.filter((row) => row.id === itemId);
    expect(asked?.deadlineAt).toBeNull();
  });
});

describe('правка доходит до резолвера (§7, задача 3.6а)', () => {
  /**
   * Связка, которой не было.
   *
   * 3.1 собирает кандидатов, 3.2 решает, 3.3 применяет — а звать это
   * было некому: сегменты с намерением `PATCH` уходили в черновик и
   * ждали бы вечно. Здесь проверяется, что теперь не ждут.
   */
  async function existingItem(deadline: string | null): Promise<string> {
    const [row] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Записать сына к врачу в четверг',
        type: 'TASK',
        priority: 'SOON',
        topic: 'личное',
        deadlineAt: deadline === null ? null : new Date(`${deadline}T00:00:00.000Z`),
        deadlineAccuracy: deadline === null ? null : 'day',
      })
      .returning({ id: items.id });

    return row?.id ?? '';
  }

  /** Через неделю: заведомо будущее и ближе пяти лет. */
  function soon(): string {
    return new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  }

  it('уверенная правка меняет запись и даёт кнопку отмены', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(null);
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'хотя нет, в пятницу', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'хотя нет, в пятницу' }],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'replace',
        itemId: '1',
        confidence: 0.9,
        changes: {
          note: '',
          text: '',
          deadline: soon(),
          deadlineAccuracy: 'day',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'поправка срока',
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

    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.deadlineAt).not.toBeNull();

    // §7.3: сказать, что именно изменилось.
    expect(all.some((text) => text.includes('Перенесла'))).toBe(true);

    // И оставить, что отменять: кнопка ведёт на эту ревизию, а её работу
    // проверяет свой тест обработчика.
    const revisions = await testDb()
      .select()
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, itemId));

    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.changedBy).toBe('resolver');

    // Черновика при этом не появилось: правка разобрана, а не отложена.
    const drafts = await testDb().select().from(items).where(eq(items.isDraft, true));
    expect(drafts).toEqual([]);
  });

  it('«перенеси на пятницу в 15:00» — день от модели, час из слов, ответ называет оба (ТЗ проджекта 17.09.2026, шаг 5)', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(null);
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'перенеси врача на пятницу в 15:00', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'перенеси врача на пятницу в 15:00' }],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'replace',
        itemId: '1',
        confidence: 0.9,
        changes: {
          note: '',
          text: '',
          deadline: soon(),
          deadlineAccuracy: 'day',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'поправка срока',
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

    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.deadlineAccuracy).toBe('day');
    expect(after?.deadlineTime).toBe(15 * 60);

    // Ответ называет и день, и час — «на 25.09, 15:00».
    const reply = all.find((text) => text.includes('Перенесла'));
    expect(reply).toMatch(/на \d{2}\.\d{2}, 15:00\./u);
  });

  /**
   * Живой прогон Никиты, 03:16 23.09.2026: «Удали это дело» сразу после
   * ответа про «Забрать посылку». Модель вернула номер вне списка, бот
   * ответил «Одну правку применить не вышло». «Это» — та запись, которую
   * только что трогали, если такая одна: код знает это лучше модели, и
   * модель для отмены не зовётся вовсе.
   */
  it('«Удали это дело» — убирает только что тронутую запись, модель не спрашивая', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(null);
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'Удали это дело', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'CANCEL', text: 'Удали это дело' }],
      }),
      // Если модель всё же спросят — вернёт номер вне списка, как на бою.
      resolver: JSON.stringify({
        action: 'cancel',
        mode: 'replace',
        itemId: '0',
        confidence: 1,
        changes: {
          note: '',
          text: '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'это дело',
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

    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.status).toBe('cancelled');
    expect(all.some((text) => text.includes('Убрала «Записать сына к врачу'))).toBe(true);
    expect(all.some((text) => text.includes('применить не вышло'))).toBe(false);
  });

  /**
   * Живой прогон Никиты, 03:41 → 03:47 23.09.2026: «Перенеси посылку на
   * пол 1» — «Там уже так — менять нечего», через шесть минут «Удали это
   * дело» — «Какое дело?». «Это» считалось по изменениям записи, а
   * «менять нечего» запись не меняет. Для человека же разговор был про
   * посылку: «это» — дело, о котором бот говорил в последний раз.
   */
  it('«Удали это дело» после «менять нечего» — «это» то дело, о котором только что говорили', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(soon());
    await testDb()
      .update(items)
      .set({ deadlineTime: 12 * 60 + 30, updatedAt: at(-40 * 60_000) })
      .where(eq(items.id, itemId));
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'перенеси врача на пол 1', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({
              crisis: false,
              segments: [{ intent: 'PATCH', text: 'перенеси врача на пол 1' }],
            }),
            resolver: JSON.stringify({
              action: 'update',
              mode: 'replace',
              itemId: '1',
              confidence: 1,
              changes: {
                note: '',
                text: '',
                deadline: '',
                deadlineAccuracy: 'none',
                recurrenceKind: 'none',
                recurrenceInterval: 0,
                recurrenceText: '',
              },
              reason: 'врач',
            }),
          }),
        }),
      },
      userId,
    );
    expect(all.some((text) => text.includes('менять нечего'))).toBe(true);

    await queuedBatchOf([{ kind: 'text', text: 'Удали это дело', offsetMs: 6 * 60_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          now: at(7 * 60_000),
          llm: echoingLlm({
            router: JSON.stringify({
              crisis: false,
              segments: [{ intent: 'CANCEL', text: 'Удали это дело' }],
            }),
          }),
        }),
      },
      userId,
    );

    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.status).toBe('cancelled');
    expect(all.some((text) => text.includes('Какое дело?'))).toBe(false);
  });

  /**
   * Решение Никиты 23.09.2026: «Перенеси дело на пол 3» — модель выбрала
   * наугад («Перенести «Купить хлеб»?»). Дело не названо — значит речь о
   * последнем обсуждённом: недавно говорили — предложить его вопросом;
   * время прошло — не угадывать, а спросить «Какое дело?».
   */
  it('«Перенеси дело на пол 3» — предлагает дело из последнего разговора, а не угаданное', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(soon());
    const [bread] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Купить хлеб',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        updatedAt: at(-40 * 60_000),
      })
      .returning({ id: items.id });
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'Перенеси дело на пол 3', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'Перенеси дело на пол 3' }],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'replace',
        itemId: '1',
        confidence: 1,
        changes: {
          note: '',
          text: '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'дело',
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

    // Предложено последнее обсуждённое, и ничего не тронуто до ответа.
    expect(all.some((text) => text.includes('Перенести «Записать сына к врачу'))).toBe(true);
    expect(all.some((text) => text.includes('Купить хлеб'))).toBe(false);
    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.deadlineTime).toBeNull();
    const [open] = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));
    expect(open?.itemId).toBe(itemId);
    expect(open?.itemId).not.toBe(bread?.id);
  });

  it('«Перенеси дело на пол 3», когда давно ни о чём не говорили, — «Какое дело?», без угадывания', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(soon());
    await testDb()
      .update(items)
      .set({ updatedAt: at(-40 * 60_000) })
      .where(eq(items.id, itemId));
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'Перенеси дело на пол 3', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'Перенеси дело на пол 3' }],
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

    expect(all.some((text) => text.includes('Какое дело? Назови его — и сделаю.'))).toBe(true);
    expect(all.some((text) => text.startsWith('Перенести «'))).toBe(false);
    const questions = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));
    expect(questions).toEqual([]);
  });

  /**
   * Шаг 0 плана docs/26 (23.09.2026): напоминание — тоже разговор о деле.
   * «Через 30 минут: …» и в ответ «перенеси дело на пол 3» — человек
   * говорит о деле из напоминания, а бот спрашивал «Какое дело?»: след
   * последнего разговора брался только из выгрузок и правок записей.
   */
  async function sentReminder(itemId: string, sentAgoMs: number): Promise<void> {
    await testDb()
      .insert(reminders)
      .values({
        userId,
        itemId,
        kind: 'deadline_hour',
        dueAt: at(-sentAgoMs),
        dedupeKey: `deadline_hour:${itemId}:test:${String(sentAgoMs)}`,
        sentAt: at(-sentAgoMs),
      });
  }

  it('«Перенеси дело на пол 3» сразу после напоминания — предлагает дело из напоминания', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(soon());
    await testDb()
      .update(items)
      .set({ updatedAt: at(-40 * 60_000) })
      .where(eq(items.id, itemId));
    await sentReminder(itemId, 3 * 60_000);
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'Перенеси дело на пол 3', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'Перенеси дело на пол 3' }],
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

    expect(all.some((text) => text.includes('Перенести «Записать сына к врачу'))).toBe(true);
    expect(all.some((text) => text.includes('Какое дело?'))).toBe(false);
    const [open] = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));
    expect(open?.itemId).toBe(itemId);
  });

  it('напоминание старше четверти часа — уже не разговор: «Какое дело?»', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(soon());
    await testDb()
      .update(items)
      .set({ updatedAt: at(-40 * 60_000) })
      .where(eq(items.id, itemId));
    await sentReminder(itemId, 20 * 60_000);
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'Перенеси дело на пол 3', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'Перенеси дело на пол 3' }],
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

    expect(all.some((text) => text.includes('Какое дело? Назови его — и сделаю.'))).toBe(true);
    expect(all.some((text) => text.startsWith('Перенести «'))).toBe(false);
  });

  /**
   * Хвост разговора в конвейере (план docs/26, задача 8; решение Никиты
   * 24.09.2026). Бот запоминает реплики обеих сторон, резолвер видит их —
   * но только при включённом `DIALOG_CONTEXT`. Выключенным он всё равно
   * пишет реплику человека: так на бою можно проверить запись, не меняя
   * поведения.
   */
  function dialogMemory(options: { readonly broken?: boolean } = {}): DialogStore & {
    readonly turns: (chatId: number) => DialogTurn[];
    readonly asked: number[];
  } {
    const saved = new Map<number, DialogTurn[]>();
    const asked: number[] = [];
    return {
      asked,
      turns: (chatId) => saved.get(chatId) ?? [],
      remember: (chatId, turn) => {
        if (options.broken === true) return Promise.reject(new Error('redis down'));
        saved.set(chatId, [...(saved.get(chatId) ?? []), turn]);
        return Promise.resolve();
      },
      recent: (chatId) => {
        asked.push(chatId);
        if (options.broken === true) return Promise.reject(new Error('redis down'));
        return Promise.resolve(saved.get(chatId) ?? []);
      },
      forget: () => Promise.resolve(),
    };
  }

  /** Резолвер, который запоминает, что ему показали, и переносит на пятницу. */
  function seeingResolver(seen: string[]): MockLlmProvider {
    return echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'врача перенеси на пятницу' }],
      }),
      resolver: (request) => {
        seen.push(request.input);
        return JSON.stringify({
          action: 'update',
          mode: 'replace',
          itemId: '1',
          confidence: 0.9,
          changes: {
            note: '',
            text: '',
            deadline: soon(),
            deadlineAccuracy: 'day',
            recurrenceKind: 'none',
            recurrenceInterval: 0,
            recurrenceText: '',
          },
          reason: 'поправка срока',
        });
      },
    });
  }

  const REMINDER = 'Напомню про «Записать сына к врачу в четверг» 04.09 в 10:00';

  it('разговор включён: реплика бота доходит до резолвера, своя не дублируется, реплика человека записана', async () => {
    const prompts = await seedPrompts();
    await existingItem(null);
    const store = dialogMemory();
    await store.remember(700, { role: 'bot', text: REMINDER, at: at(0) });
    const seen: string[] = [];

    await queuedBatchOf([{ kind: 'text', text: 'врача перенеси на пятницу', offsetMs: 0 }]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: seeingResolver(seen),
          dialog: store,
          useDialog: true,
        }),
      },
      userId,
    );

    expect(seen[0]).toContain('Недавний разговор');
    expect(seen[0]).toContain(`Бот (1 мин назад, о записи 1): ${REMINDER}`);
    // Своя реплика уже стоит в «Человек сказал» — второй раз ей в хвосте не место.
    expect(seen[0]).not.toContain('Человек (');
    expect(store.asked).toEqual([700]);
    expect(store.turns(700).map((turn) => [turn.role, turn.text])).toEqual([
      ['bot', REMINDER],
      ['person', 'врача перенеси на пятницу'],
    ]);
  });

  it('разговор выключен: резолвер его не видит, но реплика человека пишется', async () => {
    const prompts = await seedPrompts();
    await existingItem(null);
    const store = dialogMemory();
    await store.remember(700, { role: 'bot', text: REMINDER, at: at(0) });
    const seen: string[] = [];

    await queuedBatchOf([{ kind: 'text', text: 'врача перенеси на пятницу', offsetMs: 0 }]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: seeingResolver(seen),
          dialog: store,
          useDialog: false,
        }),
      },
      userId,
    );

    expect(seen[0]).not.toContain('Недавний разговор');
    expect(store.asked).toEqual([]);
    expect(store.turns(700).at(-1)).toMatchObject({
      role: 'person',
      text: 'врача перенеси на пятницу',
    });
  });

  /**
   * Живая проверка Никиты 24.09.2026, 18:45: напоминание о посылке пришло в
   * 18:15, «И паспорт туда же не забыть» — через 31 минуту. Разговор уже
   * забыт (окно 15 минут), модель из 27 дел не выбрала ни одного, и бот
   * ответил «Одну правку применить не вышло — слова сохранила». По правилу
   * 65 (решение Никиты 23.09.2026): дело не названо, говорили давно —
   * «Какое дело?», а ответ доделывает дополнение.
   */
  /**
   * Проверка Никиты 24.09.2026, 16:40: «Купить сыр» записан в 16:37,
   * посылку переносили в 16:33, «Не сыр, а творог» — модель уверена и
   * права, но бот спросил кнопкой: свежих два, «сыр» короче четырёх букв.
   * Последний разговор был только о сыре — это и есть подтверждение.
   */
  it('«Не сыр, а творог» сразу после записи сыра — правка без вопроса, хоть свежих и два', async () => {
    const prompts = await seedPrompts();
    await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Забрать посылку',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        updatedAt: at(-7 * 60_000),
      });
    const [cheese] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Купить сыр',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        createdAt: at(-3 * 60_000),
        updatedAt: at(-3 * 60_000),
      })
      .returning({ id: items.id });
    await testDb()
      .insert(batches)
      .values({
        userId,
        status: 'done',
        openedAt: at(-4 * 60_000),
        closedAt: at(-3 * 60_000),
        mentionedItemIds: [cheese!.id],
      });
    const { sender, all } = recordingSender();
    const text = 'Не сыр, а творог.';

    await queuedBatchOf([{ kind: 'voice', transcript: text, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({ crisis: false, segments: [{ intent: 'PATCH', text }] }),
            // Как на бою: модель уверена и выбрала сыр — по его номеру в списке.
            resolver: (request) => {
              const number = /^(\d+)\. Купить сыр/mu.exec(request.input)?.[1] ?? '0';
              return JSON.stringify({
                action: 'update',
                mode: 'replace',
                itemId: number,
                confidence: 1,
                changes: {
                  note: '',
                  text: 'Купить творог',
                  deadline: '',
                  deadlineAccuracy: 'none',
                  recurrenceKind: 'none',
                  recurrenceInterval: 0,
                  recurrenceText: '',
                },
                reason: 'замена сыра на творог',
              });
            },
          }),
        }),
      },
      userId,
    );

    const [after] = await testDb().select().from(items).where(eq(items.id, cheese!.id));
    expect(after?.text).toBe('Купить творог');
    // Без кнопки «Перенести?» / «Это про…?»: вопроса нет.
    expect(
      all.some((line) => line.includes('отдельная история') || line.startsWith('Перенести «')),
    ).toBe(false);
    const open = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));
    expect(open).toEqual([]);
  });

  it('«И паспорт туда же» через полчаса после напоминания — «Какое дело?»; «Забрать посылку» дописывает паспорт', async () => {
    const prompts = await seedPrompts();
    const [parcel] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Забрать посылку',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        updatedAt: at(-3 * 60 * 60_000),
      })
      .returning({ id: items.id });
    await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Купить хлеб',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        updatedAt: at(-3 * 60 * 60_000),
      });
    await testDb()
      .insert(reminders)
      .values({
        userId,
        itemId: parcel!.id,
        kind: 'deadline_hour',
        dueAt: at(-31 * 60_000),
        sentAt: at(-31 * 60_000),
        dedupeKey: `test-hour:${parcel!.id}`,
      });
    const { sender, all } = recordingSender();
    const text = 'И паспорт туда же не забыть.';
    const resolverSays = JSON.stringify({
      action: 'update',
      mode: 'append',
      itemId: '1',
      confidence: 0.95,
      changes: {
        note: 'паспорт не забыть',
        text: '',
        deadline: '',
        deadlineAccuracy: 'none',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
      },
      reason: 'подробность к названному делу',
    });

    await queuedBatchOf([{ kind: 'voice', transcript: text, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({ crisis: false, segments: [{ intent: 'PATCH', text }] }),
            // Как на бою: из многих дел модель не уверена ни в одном.
            resolver: JSON.stringify({
              action: 'new',
              mode: 'replace',
              itemId: '',
              confidence: 0.3,
              changes: {
                note: '',
                text: '',
                deadline: '',
                deadlineAccuracy: 'none',
                recurrenceKind: 'none',
                recurrenceInterval: 0,
                recurrenceText: '',
              },
              reason: 'непонятно, о чём',
            }),
          }),
        }),
      },
      userId,
    );

    expect(all.some((line) => line.includes('Какое дело? Назови его — и сделаю.'))).toBe(true);
    expect(all.some((line) => line.includes('применить не вышло'))).toBe(false);

    await queuedBatchOf([{ kind: 'text', text: 'Забрать посылку', offsetMs: 60_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          now: at(2 * 60_000),
          llm: echoingLlm({ resolver: resolverSays }),
        }),
      },
      userId,
    );

    const open = await testDb()
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.isDraft, false)));
    expect(open.map((row) => row.text).sort()).toEqual(['Забрать посылку', 'Купить хлеб']);
    expect(open.find((row) => row.id === parcel?.id)?.body ?? '').toContain('паспорт');
  });

  it('«И паспорт туда же не забыть» в ответ на напоминание — к посылке, а не новое дело (живая проверка 24.09.2026, 16:45)', async () => {
    const prompts = await seedPrompts();
    const [parcel] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Забрать посылку',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        updatedAt: at(-30 * 60_000),
      })
      .returning({ id: items.id });
    const store = dialogMemory();
    await store.remember(700, {
      role: 'bot',
      text: 'Через 30 минут, в 17:13: Забрать посылку.',
      at: at(0),
    });
    const seen: string[] = [];
    const text = 'И паспорт туда же не забыть.';

    await queuedBatchOf([{ kind: 'voice', transcript: text, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          dialog: store,
          useDialog: true,
          llm: echoingLlm({
            // Как на бою: модель маршрутизатора назвала это мыслью.
            router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text }] }),
            resolver: (request) => {
              seen.push(request.input);
              return JSON.stringify({
                action: 'update',
                mode: 'append',
                itemId: '1',
                confidence: 0.9,
                changes: {
                  note: 'паспорт не забыть',
                  text: '',
                  deadline: '',
                  deadlineAccuracy: 'none',
                  recurrenceKind: 'none',
                  recurrenceInterval: 0,
                  recurrenceText: '',
                },
                reason: 'подробность к посылке из напоминания',
              });
            },
          }),
        }),
      },
      userId,
    );

    // До резолвера дошло — и с разговором.
    expect(seen[0]).toContain('Через 30 минут, в 17:13: Забрать посылку.');
    // Нового дела «Взять паспорт» нет.
    const open = await testDb()
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.isDraft, false)));
    expect(open.map((row) => row.text)).toEqual(['Забрать посылку']);
    // Паспорт к посылке — дописан или спрошен про неё.
    const [after] = open;
    const asked = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));
    expect(
      (after?.body ?? '').includes('паспорт') || asked.some((one) => one.itemId === parcel?.id),
    ).toBe(true);
  });

  it('хранилище упало — разбор идёт как без разговора, человек получает ответ', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(null);
    const seen: string[] = [];
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'врача перенеси на пятницу', offsetMs: 0 }]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: seeingResolver(seen),
          sender,
          dialog: dialogMemory({ broken: true }),
          useDialog: true,
        }),
      },
      userId,
    );

    expect(seen[0]).not.toContain('Недавний разговор');
    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.deadlineAt).not.toBeNull();
    expect(all.length).toBeGreaterThan(0);
  });

  /**
   * Живой прогон Никиты, 12:50 23.09.2026: «Перенеси дело на пол 4» —
   * «Какое дело?» — «Забрать посылку» — и бот ответил «Записала 1 дело…»:
   * о чём спрашивал, он не помнил. Теперь помнит четверть часа: ответ
   * называет дело — команда доделывается над ним.
   */
  it('«Какое дело?» → «Забрать посылку» — переносит названное, а не заводит новое', async () => {
    const prompts = await seedPrompts();
    const [parcel] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Забрать посылку',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        deadlineAt: new Date(`${soon()}T00:00:00.000Z`),
        deadlineAccuracy: 'day',
        deadlineTime: 11 * 60,
        updatedAt: at(-40 * 60_000),
      })
      .returning({ id: items.id });
    const { sender, all } = recordingSender();
    const resolverSays = JSON.stringify({
      action: 'update',
      mode: 'replace',
      itemId: '1',
      confidence: 1,
      changes: {
        note: '',
        text: '',
        deadline: '',
        deadlineAccuracy: 'none',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
      },
      reason: 'посылка',
    });

    await queuedBatchOf([{ kind: 'text', text: 'Перенеси дело на пол 4', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({
              crisis: false,
              segments: [{ intent: 'PATCH', text: 'Перенеси дело на пол 4' }],
            }),
            resolver: resolverSays,
          }),
        }),
      },
      userId,
    );
    expect(all.some((text) => text.includes('Какое дело?'))).toBe(true);

    await queuedBatchOf([{ kind: 'text', text: 'Забрать посылку', offsetMs: 60_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          now: at(2 * 60_000),
          // Маршрутизатор на ответ не зовётся: назови он его мыслью — это
          // и был бы дефект.
          llm: echoingLlm({ resolver: resolverSays }),
        }),
      },
      userId,
    );

    const rows = await testDb()
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.isDraft, false)));
    expect(rows.map((row) => row.text)).toEqual(['Забрать посылку']);
    expect(rows.find((row) => row.id === parcel?.id)?.deadlineTime).toBe(15 * 60 + 30);
    expect(all.some((text) => text.includes('15:30'))).toBe(true);
    expect(all.some((text) => text.includes('Записала'))).toBe(false);
  });

  it('«а лучше в 5» сразу после разговора о деле — предлагает его, а не выбранное наугад (решение Никиты 23.09.2026)', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(soon());
    // Обсуждали минуты назад, но не меняли: «менять нечего» запись не трогает.
    await testDb()
      .update(items)
      .set({ updatedAt: at(-40 * 60_000) })
      .where(eq(items.id, itemId));
    await testDb()
      .insert(batches)
      .values({
        userId,
        status: 'done',
        openedAt: at(-3 * 60_000),
        closedAt: at(-2 * 60_000),
        mentionedItemIds: [itemId],
      });
    await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Купить хлеб',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        updatedAt: at(-40 * 60_000),
      });
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'а лучше в 5', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({
              crisis: false,
              segments: [{ intent: 'PATCH', text: 'а лучше в 5' }],
            }),
            // Выбирать модели не из чего: в списке только обсуждённое дело.
            resolver: JSON.stringify({
              action: 'update',
              mode: 'replace',
              itemId: '1',
              confidence: 1,
              changes: {
                note: '',
                text: '',
                deadline: '',
                deadlineAccuracy: 'none',
                recurrenceKind: 'none',
                recurrenceInterval: 0,
                recurrenceText: '',
              },
              reason: 'наугад',
            }),
          }),
        }),
      },
      userId,
    );

    // Вопрос — словами ТЗ §7.3 (канонический пример «нет, в пятницу»),
    // но про последнее обсуждённое дело, а не про выбранное наугад.
    expect(
      all.some((text) => text.includes('Это про «Записать сына к врачу» или отдельная история?')),
    ).toBe(true);
    expect(all.some((text) => text.includes('Купить хлеб'))).toBe(false);
    const [open] = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));
    expect(open?.itemId).toBe(itemId);
  });

  it('«нет, в пятницу» через минуту после записи — применяется сразу, без вопроса (§7.2, канонический случай ТЗ)', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(null);
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'нет, в пятницу', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({
              crisis: false,
              segments: [{ intent: 'PATCH', text: 'нет, в пятницу' }],
            }),
            resolver: JSON.stringify({
              action: 'update',
              mode: 'replace',
              itemId: '1',
              confidence: 0.9,
              changes: {
                note: '',
                text: '',
                deadline: soon(),
                deadlineAccuracy: 'day',
                recurrenceKind: 'none',
                recurrenceInterval: 0,
                recurrenceText: '',
              },
              reason: 'врач',
            }),
          }),
        }),
      },
      userId,
    );

    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.deadlineAt).not.toBeNull();
    expect(all.some((text) => text.includes('Перенесла'))).toBe(true);
    expect(all.some((text) => text.includes('отдельная история'))).toBe(false);
  });

  /**
   * Живой прогон Никиты, 14:15 23.09.2026: посылку только что поставили на
   * 16:30, следом голосом «а лучше в без пятнадцати шесть» — распознавание
   * записало «А лучше без 15 6», и бот ответил «Там уже так — менять
   * нечего»: минуты цифрой он не читал.
   */
  it('«А лучше без 15 6», затем «а лучше на час позже» — 17:45, потом 18:45', async () => {
    const prompts = await seedPrompts();
    const [parcel] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Забрать посылку',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        deadlineAt: new Date(`${soon()}T00:00:00.000Z`),
        deadlineAccuracy: 'day',
        deadlineTime: 16 * 60 + 30,
      })
      .returning({ id: items.id });
    const { sender, all } = recordingSender();
    const say = async (text: string, offsetMs: number): Promise<void> => {
      await queuedBatchOf([{ kind: 'voice', transcript: text, offsetMs }]);
      await processUserBatches(
        {
          db: testDb(),
          lock,
          handleBatch: handler({
            speech: new MockSpeechProvider(),
            prompts,
            sender,
            now: at(offsetMs + 60_000),
            llm: echoingLlm({
              router: JSON.stringify({ crisis: false, segments: [{ intent: 'PATCH', text }] }),
              // Модель подставляет «сегодня» — как на бою в 04:26.
              resolver: JSON.stringify({
                action: 'update',
                mode: 'replace',
                itemId: '1',
                confidence: 1,
                changes: {
                  note: '',
                  text: '',
                  deadline: soon(),
                  deadlineAccuracy: 'day',
                  recurrenceKind: 'none',
                  recurrenceInterval: 0,
                  recurrenceText: '',
                },
                reason: 'посылка',
              }),
            }),
          }),
        },
        userId,
      );
    };
    const timeOf = async (): Promise<number | null | undefined> =>
      (
        await testDb()
          .select()
          .from(items)
          .where(eq(items.id, parcel?.id ?? ''))
      )[0]?.deadlineTime;

    await say('А лучше без 15 6.', 0);
    expect(await timeOf()).toBe(17 * 60 + 45);
    expect(all.some((text) => text.includes('17:45'))).toBe(true);

    await say('А лучше на час позже.', 2 * 60_000);
    expect(await timeOf()).toBe(18 * 60 + 45);
    expect(all.some((text) => text.includes('18:45'))).toBe(true);
    expect(all.some((text) => text.includes('менять нечего'))).toBe(false);
  });

  /**
   * Живой прогон Никиты, 14:57–14:58 23.09.2026: «Давай в четверть 7» и
   * «Давай через полчаса» лёгкая модель назвала мыслью — завелись «В
   * четверть седьмого что-то запланировано» и «Встретиться». Здесь
   * маршрутизатор отвечает так же, как на бою: DUMP.
   */
  it('«Давай в четверть 7», затем «Давай через полчаса» — правят посылку, новых дел нет', async () => {
    const prompts = await seedPrompts();
    const [parcel] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Забрать посылку',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        deadlineAt: new Date(`${soon()}T00:00:00.000Z`),
        deadlineAccuracy: 'day',
        deadlineTime: 18 * 60 + 45,
      })
      .returning({ id: items.id });
    const { sender, all } = recordingSender();
    const say = async (text: string, offsetMs: number): Promise<void> => {
      await queuedBatchOf([{ kind: 'voice', transcript: text, offsetMs }]);
      await processUserBatches(
        {
          db: testDb(),
          lock,
          handleBatch: handler({
            speech: new MockSpeechProvider(),
            prompts,
            sender,
            now: at(offsetMs + 60_000),
            llm: echoingLlm({
              // Как на бою: лёгкая модель назвала это мыслью.
              router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text }] }),
              resolver: JSON.stringify({
                action: 'update',
                mode: 'replace',
                itemId: '1',
                confidence: 1,
                changes: {
                  note: '',
                  text: '',
                  deadline: '',
                  deadlineAccuracy: 'none',
                  recurrenceKind: 'none',
                  recurrenceInterval: 0,
                  recurrenceText: '',
                },
                reason: 'посылка',
              }),
            }),
          }),
        },
        userId,
      );
    };
    const parcelNow = async () =>
      (
        await testDb()
          .select()
          .from(items)
          .where(eq(items.id, parcel?.id ?? ''))
      )[0];

    await say('Давай в четверть 7.', 0);
    expect((await parcelNow())?.deadlineTime).toBe(18 * 60 + 15);

    await say('Давай через полчаса', 2 * 60_000);
    const after = await parcelNow();
    // 3 минуты от T0 (10:00 UTC = 13:00 по Москве) и ещё полчаса.
    expect(after?.deadlineTime).toBe(13 * 60 + 33);

    const rows = await testDb()
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.isDraft, false)));
    expect(rows.map((row) => row.text)).toEqual(['Забрать посылку']);
    expect(all.some((text) => text.includes('Записала'))).toBe(false);
  });

  it('маршрутизатор идёт своей моделью, остальные стадии — полной (решение Никиты 23.09.2026)', async () => {
    const prompts = await seedPrompts();
    const text = 'Купить хлеб';
    const router = echoingLlm({
      router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text }] }),
    });
    const full = echoingLlm();

    await queuedBatchOf([{ kind: 'text', text, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: full,
          llmRouter: router,
        }),
      },
      userId,
    );

    const stagesOf = (provider: MockLlmProvider): string[] =>
      provider.requests.map((request) => request.stage);
    expect(stagesOf(router)).toEqual(['router']);
    expect(stagesOf(full)).not.toContain('router');
    expect(stagesOf(full)).toContain('extractor');
  });

  /**
   * Живой прогон Никиты, 15:42 23.09.2026: «Давай заберём посылку без 15
   * 6» при уже записанной «Забрать посылку» (24.09, 18:45) завело второе
   * дело «Забрать посылку без 15 6» на сегодня. Повтор с новым сроком —
   * это перенос того же дела.
   */
  const repeatWith = (text: string, unitText: string, deadline: string) =>
    echoingLlm({
      router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text }] }),
      extractor: () =>
        JSON.stringify({ units: [{ text: unitText, isProject: false, isEmotion: false }] }),
      classifier: () =>
        JSON.stringify({
          items: [
            {
              text: unitText,
              type: 'TASK',
              priority: 'SOON',
              topic: 'покупки',
              isProject: false,
              deadline,
              deadlineAccuracy: deadline === '' ? 'none' : 'day',
              deadlineText: '',
              recurrenceKind: 'none',
              recurrenceInterval: 0,
              recurrenceText: '',
            },
          ],
        }),
    });

  it('«Давай заберём посылку без 15 6» при записанной посылке — перенос на 17:45, а не второе дело', async () => {
    const prompts = await seedPrompts();
    const [parcel] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Забрать посылку',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        deadlineAt: new Date(`${soon()}T00:00:00.000Z`),
        deadlineAccuracy: 'day',
        deadlineTime: 18 * 60 + 45,
      })
      .returning({ id: items.id });
    const { sender, all } = recordingSender();
    const text = 'Давай заберем посылку без 15 6.';

    await queuedBatchOf([{ kind: 'voice', transcript: text, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          // Модель подставила «сегодня», как на бою.
          llm: repeatWith(text, 'Забрать посылку без 15 6', tomorrowIso()),
        }),
      },
      userId,
    );

    const rows = await testDb()
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.isDraft, false)));
    expect(rows.map((row) => row.text)).toEqual(['Забрать посылку']);
    const after = rows.find((row) => row.id === parcel?.id);
    expect(after?.deadlineTime).toBe(17 * 60 + 45);
    expect(after?.deadlineAt?.toISOString()).toBe(
      new Date(`${soon()}T00:00:00.000Z`).toISOString(),
    );
    expect(all.some((line) => line.includes('17:45'))).toBe(true);
    expect(all.some((line) => line.includes('Записала') || line.includes('Всё, забрала'))).toBe(
      false,
    );
  });

  /**
   * Живая проверка Никиты 24.09.2026, 15:43: «Давай заберём посылку через
   * 40 минут» при просроченной посылке (вчера, 17:00) — бот ответил «Про
   * посылку помню — запись одна» и срок не перенёс. «Через» разбирается,
   * повтор узнаётся — правка не легла и исход молча пропущен.
   */
  for (const [what, deadline] of [
    ['модель срока не назвала', ''],
    ['модель поставила «сегодня»', '2026-08-24'],
  ] as const) {
    it(`«Давай заберём посылку через 40 минут» при просроченной посылке — сегодня 13:41 (${what})`, async () => {
      const prompts = await seedPrompts();
      const [parcel] = await testDb()
        .insert(items)
        .values({
          userId,
          text: 'Забрать посылку',
          type: 'TASK',
          priority: 'SOON',
          topic: 'покупки',
          deadlineAt: new Date('2026-08-22T21:00:00.000Z'),
          deadlineAccuracy: 'day',
          deadlineTime: 17 * 60,
        })
        .returning({ id: items.id });
      const { sender, all } = recordingSender();
      const text = 'Давай заберем посылку через 40 минут.';

      await queuedBatchOf([{ kind: 'voice', transcript: text, offsetMs: 0 }]);
      await processUserBatches(
        {
          db: testDb(),
          lock,
          handleBatch: handler({
            speech: new MockSpeechProvider(),
            prompts,
            sender,
            llm: repeatWith(text, 'Забрать посылку', deadline),
          }),
        },
        userId,
      );

      const rows = await testDb()
        .select()
        .from(items)
        .where(and(eq(items.userId, userId), eq(items.isDraft, false)));
      expect(rows.map((row) => row.text)).toEqual(['Забрать посылку']);
      const after = rows.find((row) => row.id === parcel?.id);
      // Часы теста — 13:01 по Москве 24.08; через 40 минут — 13:41 того же дня.
      expect(after?.deadlineTime).toBe(13 * 60 + 41);
      expect(after?.deadlineAt?.toISOString()).toBe('2026-08-23T21:00:00.000Z');
      expect(all.some((line) => line.includes('13:41'))).toBe(true);
    });
  }

  it('время из предложения про два дела повтору не приписывается («посылку и через 40 минут позвонить маме»)', async () => {
    // Запасной поиск предложения берёт его, только если оно называет одно
    // это дело: время здесь — маме, а не посылке.
    const prompts = await seedPrompts();
    const [parcel] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Забрать посылку',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        deadlineAt: new Date('2026-08-22T21:00:00.000Z'),
        deadlineAccuracy: 'day',
        deadlineTime: 17 * 60,
      })
      .returning({ id: items.id });
    const text = 'Заберем посылку и через 40 минут позвонить маме.';
    const unit = (unitText: string) => ({
      text: unitText,
      type: 'TASK',
      priority: 'SOON',
      topic: 'покупки',
      isProject: false,
      deadline: '',
      deadlineAccuracy: 'none',
      deadlineText: '',
      recurrenceKind: 'none',
      recurrenceInterval: 0,
      recurrenceText: '',
    });

    await queuedBatchOf([{ kind: 'voice', transcript: text, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm({
            router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text }] }),
            extractor: () =>
              JSON.stringify({
                units: [
                  { text: 'Забрать посылку', isProject: false, isEmotion: false },
                  { text: 'Позвонить маме', isProject: false, isEmotion: false },
                ],
              }),
            classifier: () =>
              JSON.stringify({ items: [unit('Забрать посылку'), unit('Позвонить маме')] }),
          }),
        }),
      },
      userId,
    );

    const [after] = await testDb()
      .select()
      .from(items)
      .where(eq(items.id, parcel?.id ?? ''));
    expect(after?.deadlineTime).toBe(17 * 60);
    expect(after?.deadlineAt?.toISOString()).toBe('2026-08-22T21:00:00.000Z');
  });

  it('«Купить хлеб завтра» при записанном «Купить хлеб» без срока — перенос на завтра, а не тишина', async () => {
    const prompts = await seedPrompts();
    const [bread] = await testDb()
      .insert(items)
      .values({ userId, text: 'Купить хлеб', type: 'TASK', priority: 'SOON', topic: 'покупки' })
      .returning({ id: items.id });
    const { sender, all } = recordingSender();
    const text = 'Купить хлеб завтра';

    await queuedBatchOf([{ kind: 'text', text, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: repeatWith(text, 'Купить хлеб', tomorrowIso()),
        }),
      },
      userId,
    );

    const rows = await testDb()
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.isDraft, false)));
    expect(rows).toHaveLength(1);
    expect(rows.find((row) => row.id === bread?.id)?.deadlineAt).not.toBeNull();
    expect(all.some((line) => line.includes('Перенесла «Купить хлеб»'))).toBe(true);
  });

  it('повтор уже записанного дела — без «Записала 1 дело» (живой прогон Никиты 23.09.2026, 12:51)', async () => {
    // «Записала 1 дело… Посылку ты уже записывала — вторую не завела»:
    // одна строка противоречила другой. Счёт — только заведённое сейчас.
    const prompts = await seedPrompts();
    await testDb().insert(items).values({
      userId,
      text: 'Забрать посылку',
      type: 'TASK',
      priority: 'SOON',
      topic: 'покупки',
    });
    const { sender, all } = recordingSender();
    const text = 'Забрать посылку';

    await queuedBatchOf([{ kind: 'text', text, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text }] }),
            extractor: () =>
              JSON.stringify({ units: [{ text, isProject: false, isEmotion: false }] }),
            classifier: () =>
              JSON.stringify({
                items: [
                  {
                    text,
                    type: 'TASK',
                    priority: 'SOON',
                    topic: 'покупки',
                    isProject: false,
                    deadline: '',
                    deadlineAccuracy: 'none',
                    deadlineText: '',
                    recurrenceKind: 'none',
                    recurrenceInterval: 0,
                    recurrenceText: '',
                  },
                ],
              }),
          }),
        }),
      },
      userId,
    );

    const rows = await testDb()
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.isDraft, false)));
    expect(rows).toHaveLength(1);
    expect(all.some((line) => line.includes('Записала'))).toBe(false);
  });

  it('«Не поняла, 11:30 или 23:30?» → «утра» — ставит 11:30', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(soon());
    const { sender, all } = recordingSender();
    const resolverSays = JSON.stringify({
      action: 'update',
      mode: 'replace',
      itemId: '1',
      confidence: 1,
      changes: {
        note: '',
        text: '',
        deadline: '',
        deadlineAccuracy: 'none',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
      },
      reason: 'врач',
    });

    await queuedBatchOf([{ kind: 'text', text: 'перенеси врача на пол 12', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({
              crisis: false,
              segments: [{ intent: 'PATCH', text: 'перенеси врача на пол 12' }],
            }),
            resolver: resolverSays,
          }),
        }),
      },
      userId,
    );
    expect(all.some((text) => text.includes('Не поняла, 11:30 или 23:30?'))).toBe(true);

    await queuedBatchOf([{ kind: 'text', text: 'утра', offsetMs: 60_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          now: at(2 * 60_000),
          llm: echoingLlm({ resolver: resolverSays }),
        }),
      },
      userId,
    );

    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.deadlineTime).toBe(11 * 60 + 30);
  });

  it('«Удали это дело» при двух только что тронутых — спрашивает какое, ничего не трогая', async () => {
    const prompts = await seedPrompts();
    const first = await existingItem(null);
    const [second] = await testDb()
      .insert(items)
      .values({ userId, text: 'Забрать посылку', type: 'TASK', priority: 'SOON', topic: 'покупки' })
      .returning({ id: items.id });
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'Удали это дело', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'CANCEL', text: 'Удали это дело' }],
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

    const rows = await testDb().select().from(items).where(eq(items.userId, userId));
    for (const id of [first, second?.id ?? '']) {
      expect(rows.find((row) => row.id === id)?.status).toBe('new');
    }
    expect(all.some((text) => text.includes('Какое дело? Назови его — и сделаю.'))).toBe(true);
  });

  it('«перенеси врача на пол 12» у дела без часа — «не поняла, 11:30 или 23:30?», а не «менять нечего» (живой прогон Никиты 23.09.2026)', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(soon());
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'перенеси врача на пол 12', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'перенеси врача на пол 12' }],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'replace',
        itemId: '1',
        confidence: 0.9,
        changes: {
          note: '',
          text: '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'поправка часа',
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

    // Час не угадан: у дела своего часа нет, а у «пол 12» два чтения.
    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.deadlineTime).toBeNull();

    // И об этом сказано словами, а не «менять нечего».
    expect(all.some((text) => text.includes('Не поняла, 11:30 или 23:30?'))).toBe(true);
    expect(all.some((text) => text.includes('менять нечего'))).toBe(false);
  });

  it('средняя уверенность задаёт один вопрос с двумя кнопками', async () => {
    const prompts = await seedPrompts();
    const itemId = await existingItem(null);
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'перенеси на пятницу', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'перенеси на пятницу' }],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'replace',
        itemId: '1',
        confidence: 0.6,
        changes: {
          note: '',
          text: '',
          deadline: soon(),
          deadlineAccuracy: 'day',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'не уверен',
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

    // Запись не тронута: спросили, а не поправили.
    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.deadlineAt).toBeNull();

    // Приказ о переносе спрашивает про перенос, а не «или отдельная
    // история?» (живой прогон Никиты 23.09.2026).
    expect(all.some((text) => text.startsWith('Перенести «'))).toBe(true);
    expect(all.some((text) => text.includes('отдельная история'))).toBe(false);

    // Сказанное лежит в открытом вопросе и не потеряно.
    const [open] = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));

    expect(open?.segment).toBe('перенеси на пятницу');
  });

  it('отвергнутый срок: человеку сказано, черновик с настоящей причиной (ревизия этапа 3, A3, A4)', async () => {
    /**
     * «Перенеси врача на десятое», модель дала дату в прошлом. Раньше:
     * запись не тронута, черновик с причиной «запись уже в нужном
     * состоянии», а человеку — «Я здесь. Расскажешь, что в голове?».
     */
    const prompts = await seedPrompts();
    const itemId = await existingItem(null);
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'перенеси врача на десятое', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'PATCH', text: 'перенеси врача на десятое' }],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'replace',
        itemId: '1',
        confidence: 0.9,
        changes: {
          note: '',
          text: '',
          deadline: '2026-01-10',
          deadlineAccuracy: 'day',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'поправка срока',
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

    expect(
      (await testDb().select().from(items).where(eq(items.id, itemId)))[0]?.deadlineAt,
    ).toBeNull();
    expect(all).toContain(defaultTexts.resolver.deadlineRefused);
    expect(all).not.toContain(defaultTexts.answer.nothingToParse);

    const drafts = await testDb().select().from(items).where(eq(items.isDraft, true));
    expect(drafts.map((row) => row.draftReason)).toEqual([
      expect.stringContaining('правка отвергнута'),
    ]);
  });

  it('в смешанной выгрузке об отвергнутой правке сказано под ответом (ревизия этапа 3, A4)', async () => {
    const prompts = await seedPrompts();
    await existingItem(null);
    const { sender, all } = recordingSender();

    await queuedBatchOf([
      { kind: 'text', text: 'купить хлеб. а врача давай на десятое', offsetMs: 0 },
    ]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'DUMP', text: 'купить хлеб' },
          { intent: 'PATCH', text: 'а врача давай на десятое' },
        ],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'replace',
        itemId: '1',
        confidence: 0.9,
        changes: {
          note: '',
          text: '',
          deadline: '2026-01-10',
          deadlineAccuracy: 'day',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'поправка срока',
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

    // Обычный ответ на выгрузку пришёл — и в нём строка про правку.
    const reply = all.find((text) => text.includes(defaultTexts.answer.keepOrPick));
    expect(reply).toBeDefined();
    expect(reply).toContain(defaultTexts.resolver.deadlineRefused);
  });

  it('две неоднозначные правки: один вопрос, и открыт в базе именно он (ревизия этапа 3, A2)', async () => {
    /**
     * Второй вопрос за выгрузку не задаётся (§13.9), но раньше резолвер
     * успевал записать его в базу — и тем снять первый как
     * `superseded`. Человек видел вопрос, которого уже нет: кнопки под
     * ним вели в пустоту, а голосовой ответ применялся к невидимому
     * второму.
     */
    const prompts = await seedPrompts();
    await existingItem(null);
    const { sender, said } = recordingSender();

    await queuedBatchOf([
      { kind: 'text', text: 'перенеси на пятницу. и врача тоже на пятницу', offsetMs: 0 },
    ]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'PATCH', text: 'перенеси на пятницу' },
          { intent: 'PATCH', text: 'врача тоже на пятницу' },
        ],
      }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'replace',
        itemId: '1',
        confidence: 0.6,
        changes: {
          note: '',
          text: '',
          deadline: soon(),
          deadlineAccuracy: 'day',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'не уверен',
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

    const questions = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));
    const open = questions.filter((row) => row.outcome === null);

    // Ровно один вопрос показан, ровно один открыт — и это один и тот же.
    const shown = said.filter((one) => one.text.startsWith('Перенести «'));
    expect(shown).toHaveLength(1);
    expect(open).toHaveLength(1);
    expect(open[0]?.segment).toBe('перенеси на пятницу');
    expect(shown[0]?.actions).toContain(`${QUESTION_ACTION.attach}${toShortId(open[0]?.id ?? '')}`);

    // Вторая правка не потеряна — черновик.
    const drafts = await testDb().select().from(items).where(eq(items.isDraft, true));
    expect(drafts.map((row) => row.text)).toEqual(['врача тоже на пятницу']);
  });
});

describe('выполнение и отмена голосом (§21 п.8, задача 3.8)', () => {
  /**
   * §21 п.8 требует, чтобы отметка голосом проходила **без уточняющих
   * вопросов**. План просит на это отдельный тест — и он здесь не про
   * пороги, а про то, что человек действительно не увидел вопроса.
   */
  async function itemWith(text: string): Promise<string> {
    const [row] = await testDb()
      .insert(items)
      .values({ userId, text, type: 'TASK', priority: 'SOON', topic: 'личное' })
      .returning({ id: items.id });

    return row?.id ?? '';
  }

  it('«кассу сверила» закрывает дело и ни о чём не спрашивает', async () => {
    const prompts = await seedPrompts();
    const itemId = await itemWith('Сверить кассу');
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'кассу сверила', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'COMPLETE', text: 'кассу сверила' }],
      }),
      resolver: JSON.stringify({
        action: 'complete',
        mode: 'replace',
        itemId: '1',
        confidence: 0.9,
        changes: {
          note: '',
          text: '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'дело названо сделанным',
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

    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.status).toBe('done');

    // Ни одного уточняющего вопроса — этого и требует §21 п.8.
    expect(all.some((text) => text.includes('отдельная история'))).toBe(false);

    const open = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));

    expect(open).toEqual([]);
  });

  it('§13.6: вернувшись после паузы, человек видит выбор, а не стену дел', async () => {
    /**
     * «Если женщина не заходила дольше заданного срока, бот встречает её
     * мягче обычного и даёт выбор, вместо того чтобы вываливать
     * накопившееся.»
     *
     * Экран занимает единственный вопрос реплики: обычный ответ на эту
     * выгрузку приходит без своего «С чего начнём?» — ровно так же, как
     * это устроено у онбординга.
     */
    const prompts = await seedPrompts();
    const { sender, all, said } = recordingSender();

    // Прошлая выгрузка — три недели назад.
    await testDb()
      .insert(batches)
      .values({
        userId,
        status: 'done',
        openedAt: new Date(T0.getTime() - 21 * 24 * 60 * 60_000),
        lastMessageAt: new Date(T0.getTime() - 21 * 24 * 60 * 60_000),
      });

    const batchId = await queuedBatchOf([
      { kind: 'text', text: 'надо купить продукты', offsetMs: 0 },
    ]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm: echoingLlm(),
          sender,
        }),
      },
      userId,
    );

    expect(all.some((text) => text.includes('С возвращением'))).toBe(true);

    // Кнопка «С чистого листа» знает свою выгрузку: старое — это то, что
    // было до неё (ревизия этапа 3, H1).
    const greeting = said.find((one) => one.text.includes('С возвращением'));
    expect(greeting?.actions).toContain(`${RETURNING_ACTION.fresh}:${toShortId(batchId)}`);

    // Сказанное разобрано, а не потеряно.
    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(saved.filter((one) => !one.isDraft)).not.toHaveLength(0);

    // Один вопрос на весь обмен: экран возвращения занял его.
    const questions = all.filter((text) => text.includes('?'));
    expect(questions).toHaveLength(1);
  });

  it('пример §7.1: три намерения в одной выгрузке отрабатывают все три', async () => {
    /**
     * Дословный пример из ТЗ: «купила продукты, а врача давай перенесем на
     * пятницу, и еще надо забрать вещи из химчистки» — выполнение,
     * корректировка и новая задача.
     *
     * Маршрутизатор умеет разбирать три сегмента, это проверено у него.
     * Здесь проверяется другое: что конвейер прогоняет их **все три** за
     * один проход. Внутри это три раздельных цикла — правки, вопросы,
     * новые мысли, — и до сих пор ни один тест не сводил их вместе.
     */
    const prompts = await seedPrompts();

    /**
     * Продукты названы только что, врач — три часа назад.
     *
     * Так это и выглядит в жизни, и на этом держится решение резолвера:
     * §7.3 велит подтверждать высокую уверенность вторым сигналом.
     * Свежая запись одна — её и закрываем. У врача свежести нет, но
     * человек назвал его словом («врача» — ровно у одной записи), и с
     * 17.09.2026 это четвёртый сигнал: правка применяется без вопроса,
     * как и велит пример §7.1 («корректировка»).
     */
    const bought = await itemWith('Купить продукты');
    const doctor = await itemWith('Записать сына к врачу в четверг');
    // Часы в этих тестах заморожены на T0: старить надо от них, а не от
    // настоящего «сейчас», иначе запись окажется в будущем и будет свежей.
    const longAgo = new Date(T0.getTime() - 3 * 60 * 60_000);
    await testDb()
      .update(items)
      .set({ createdAt: longAgo, updatedAt: longAgo })
      .where(eq(items.id, doctor));

    const { sender } = recordingSender();

    await queuedBatchOf([
      {
        kind: 'text',
        text: 'купила продукты, а врача давай перенесём на пятницу, и ещё надо забрать вещи из химчистки',
        offsetMs: 0,
      },
    ]);

    let resolverCall = 0;

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'COMPLETE', text: 'купила продукты' },
          { intent: 'PATCH', text: 'врача давай перенесём на пятницу' },
          { intent: 'DUMP', text: 'надо забрать вещи из химчистки' },
        ],
      }),

      /**
       * Резолвер зовётся дважды и отвечает по-разному: первый раз про
       * продукты, второй про врача. Один ответ на оба означал бы, что
       * тест проверяет один сегмент, а не три.
       */
      resolver: (request) => {
        resolverCall += 1;
        const done = resolverCall === 1;
        const title = done ? 'Купить продукты' : 'Записать сына к врачу в четверг';

        return JSON.stringify({
          action: done ? 'complete' : 'update',
          mode: 'replace',
          itemId: String(numberOfCandidate(request.input, title)),
          confidence: 0.95,
          changes: {
            note: '',
            text: '',
            deadline: done ? '' : '2026-09-04',
            deadlineAccuracy: done ? 'none' : 'day',
            recurrenceKind: 'none',
            recurrenceInterval: 0,
            recurrenceText: '',
          },
          reason: 'сегмент разобран',
        });
      },
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    const closed = saved.find((one) => one.id === bought);
    const fresh = saved.filter((one) => !one.isDraft && one.id !== bought && one.id !== doctor);
    const open = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));

    // 1. Выполнение применено: свежая запись была одна.
    expect(closed?.status).toBe('done');

    // 2. Корректировка применена: запись названа словом, вопросов нет.
    expect(open).toHaveLength(0);
    const [movedDoctor] = await testDb()
      .select({ deadlineAt: items.deadlineAt })
      .from(items)
      .where(eq(items.id, doctor));
    // «На пятницу» — ближайшая пятница от часов теста, а не дата модели:
    // день недели пересчитывает код (правило дня недели).
    expect(movedDoctor?.deadlineAt?.toISOString()).toBe('2026-08-27T21:00:00.000Z');

    // 3. Новая мысль стала записью, и вторая запись про врача не создалась.
    expect(fresh.map((one) => one.text).join(' ')).toMatch(/химчистк/iu);
    expect(saved.filter((one) => /врач/iu.test(one.text))).toHaveLength(1);

    // Все три сегмента дошли до резолвера или разбора, ни один не потерян.
    expect(resolverCall).toBe(2);
    expect((await pickedNow()).join(NEWLINE)).toMatch(/химчистк/iu);
  });

  it('после отметки выполнения бот не добавляет «расскажешь, что в голове»', async () => {
    /**
     * Регрессия, найденная сквозным тестом этапа 3.
     *
     * Заглушка «Я здесь. Расскажешь, что в голове?» стояла под условием
     * «новых мыслей нет». Но новых мыслей нет и когда человек поправил
     * запись, и когда отметил дело сделанным, и когда задал вопрос: бот
     * отвечал по существу и следом добавлял эту фразу, то есть выглядел
     * так, будто не понял.
     */
    const prompts = await seedPrompts();
    await itemWith('Сверить кассу');
    const { sender, all, said } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'кассу сверила', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'COMPLETE', text: 'кассу сверила' }],
      }),
      resolver: JSON.stringify({
        action: 'complete',
        mode: 'replace',
        itemId: '1',
        confidence: 0.9,
        changes: {
          note: '',
          text: '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'дело названо сделанным',
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

    expect(all).not.toContain(defaultTexts.answer.nothingToParse);

    /**
     * Регрессия 31.08.2026, найденная ручным прогоном.
     *
     * Вопрос сценария 8 отправлялся правкой статусного сообщения и затирал
     * подтверждение выполнения вместе с кнопкой отката: человек не видел,
     * что закрылось, и не мог вернуть.
     *
     * Проверять надо не список текстов — в нём обе строки были и до
     * починки, — а что подтверждение **осталось отдельной репликой** и
     * сохранило кнопку.
     */
    const confirmation = said.find((one) => one.text.includes('Сверить кассу'));
    const question = said.find((one) => one.text === defaultTexts.resolver.goOn);

    expect(confirmation).toBeDefined();
    expect(confirmation?.buttons).toContain(defaultTexts.resolver.buttonUndo);
    expect(question).toBeDefined();
    expect(question?.buttons).toEqual([
      defaultTexts.resolver.buttonGoOn,
      defaultTexts.resolver.buttonEnough,
    ]);

    // Вопрос не должен править то, что уже сказано.
    expect(question?.kind).toBe('send');

    /**
     * Последним идёт вопрос сценария 8 §2 — «продолжаем или на сегодня
     * достаточно». Уточняющим он не является: §21 п.8 запрещает
     * переспрашивать, о какой записи речь, а это вопрос о том, что делать
     * дальше, и он в ТЗ прямо назван.
     */
    expect(all.at(-1)).toBe(defaultTexts.resolver.goOn);
  });

  it('«что на сегодня?» при пустом дне отвечает как кнопка «Сегодня» (ревизия этапа 3, E16)', async () => {
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'что у меня на сегодня', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'что у меня на сегодня' }],
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

    expect(all.at(-1)).toBe(defaultTexts.menu.todayEmpty);
    expect(all).not.toContain(defaultTexts.backlog.nothing);
  });

  it('«Покажи все мои задачи» при делах в базе — список, а не «ничего не записано» (её случай 16.09.2026)', async () => {
    /**
     * На бою 16.09.2026 заказчица спросила «Покажи все мои задачи» и
     * «Какие у меня есть задачи?» — и при шести делах получила «Про это у
     * меня ничего не записано»: вопрос без предмета шёл в поиск по
     * смыслу. Теперь это вопрос обо всём — список открытых дел.
     */
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();
    for (const text of ['Заказать цветы', 'Написать список продуктов мужу']) {
      await testDb()
        .insert(items)
        .values({ userId, text, type: 'TASK', priority: 'SOON', topic: 'личное' });
    }

    await queuedBatchOf([{ kind: 'text', text: 'Покажи все мои задачи', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'Покажи все мои задачи' }],
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

    const reply = all.at(-1) ?? '';
    expect(reply.startsWith(defaultTexts.backlog.myTasksHeader('2 дела'))).toBe(true);
    expect(reply).toContain('— Заказать цветы');
    expect(reply).toContain('— Написать список продуктов мужу');
    expect(all).not.toContain(defaultTexts.backlog.nothing);
  });

  it('«Покажи мои дела» — по сферам со счётчиками и иконками, только непустые, подпись и две кнопки (ТЗ 17.09.2026, 2.4)', async () => {
    /**
     * Макет заказчицы 16.09.2026, вариант 2, и ТЗ проджекта 17.09.2026
     * (2.4): «Вот что сейчас осталось — N дел.» → группы «💼 Работа — 2»
     * / «🛒 Покупки — 1» с делами, пустых сфер нет, внизу «Всё актуальное
     * сейчас здесь. Остальное я помню.» и кнопки «Выбрать главное» /
     * «Добавить ещё».
     */
    const prompts = await seedPrompts();
    const { sender, all, buttons } = recordingSender();
    for (const [text, topic] of [
      ['Съездить в офис и распечатать документы', 'работа'],
      ['Отправить Антоновой документы', 'работа'],
      ['Заказать цветы', 'покупки'],
    ] as const) {
      await testDb().insert(items).values({ userId, text, type: 'TASK', priority: 'SOON', topic });
    }

    await queuedBatchOf([{ kind: 'text', text: 'Покажи мои дела', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'Покажи мои дела' }],
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

    const reply = all.at(-1) ?? '';
    expect(reply).toBe(
      [
        defaultTexts.backlog.myTasksHeader('3 дела'),
        '',
        '💼 Работа — 2',
        '— Съездить в офис и распечатать документы',
        '— Отправить Антоновой документы',
        '',
        '🛒 Покупки — 1',
        '— Заказать цветы',
        '',
        defaultTexts.backlog.myTasksFooter,
      ].join('\n'),
    );
    expect(reply).not.toContain('Личное');
    expect(buttons).toEqual([defaultTexts.answer.buttonPick, defaultTexts.backlog.buttonAddMore]);
  });

  it('16–30 дел — вступление, 2–3 части по сферам, кнопки под последней, карточка «всё накопившееся» перед списком (ТЗ 2.4, визуал 05)', async () => {
    const prompts = await seedPrompts();
    const { sender, all, said } = recordingSender();
    const { cards, shown } = recordingCards();
    for (let index = 1; index <= 20; index += 1) {
      await testDb()
        .insert(items)
        .values({
          userId,
          text: `Дело номер ${String(index)}`,
          type: 'TASK',
          priority: 'SOON',
          topic: index <= 12 ? 'работа' : 'дом',
        });
    }

    await queuedBatchOf([{ kind: 'text', text: 'Что у меня накопилось?', offsetMs: 0 }]);
    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'Что у меня накопилось?' }],
      }),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender, cards }),
      },
      userId,
    );

    // Карточка — с числом дел, без кнопок; за ней вступление и части.
    expect(shown).toEqual([
      { card: 'all', caption: defaultTexts.cards.all('20 дел'), buttons: [] },
    ]);
    const parts = all.filter((text) => text.includes('— Дело номер'));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(
      parts
        .join('\n')
        .split('\n')
        .filter((line) => line.startsWith('— ')),
    ).toHaveLength(20);
    // Кнопки — только под последним сообщением.
    const withButtons = said.filter((one) => one.buttons.length > 0);
    expect(withButtons).toHaveLength(1);
    expect(withButtons[0]?.text).toBe(all.at(-1));
    expect(withButtons[0]?.buttons).toEqual([
      defaultTexts.answer.buttonPick,
      defaultTexts.backlog.buttonAddMore,
    ]);
  });

  it('больше 30 дел — сводка по сферам и первая страница с «Показать ещё» (ТЗ 2.4)', async () => {
    const prompts = await seedPrompts();
    const { sender, all, said } = recordingSender();
    for (let index = 1; index <= 35; index += 1) {
      await testDb()
        .insert(items)
        .values({
          userId,
          text: `Дело номер ${String(index)}`,
          type: 'TASK',
          priority: 'SOON',
          topic: index <= 20 ? 'работа' : 'дом',
        });
    }

    await queuedBatchOf([{ kind: 'text', text: 'Покажи всё незавершённое', offsetMs: 0 }]);
    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'Покажи всё незавершённое' }],
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

    const summary =
      all.find((text) =>
        text.startsWith(defaultTexts.backlog.myTasksMany('35 незавершённых дел')),
      ) ?? '';
    expect(summary).toContain('💼 Работа — 20');
    expect(summary).toContain('🏠 Дом — 15');
    const page = all.at(-1) ?? '';
    expect(page.split('\n').filter((line) => line.startsWith('— ')).length).toBeLessThanOrEqual(12);
    expect(said.at(-1)?.buttons).toEqual([
      defaultTexts.backlog.buttonShowMore,
      defaultTexts.answer.buttonPick,
    ]);
  });

  it('«что на сегодня» при пустом дне, но с открытыми делами — число дел и две кнопки (находка 21)', async () => {
    /**
     * Скрины заказчицы 16.09: «На сегодня ничего срочного.» при шести
     * открытых делах читалось как «у тебя ничего нет». Ответ верный, но
     * человеку с делами нужен выход к ним: «Открытых дел — 2.» и кнопки
     * «Все задачи» / «Выбрать главное».
     */
    const prompts = await seedPrompts();
    const { sender, all, buttons } = recordingSender();
    for (const text of ['Заказать цветы', 'Написать список продуктов мужу']) {
      await testDb()
        .insert(items)
        .values({ userId, text, type: 'TASK', priority: 'SOON', topic: 'личное' });
    }

    await queuedBatchOf([{ kind: 'text', text: 'Что у меня на сегодня?', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'Что у меня на сегодня?' }],
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

    expect(all.at(-1)).toBe(
      `${defaultTexts.menu.todayEmpty}\n${defaultTexts.menu.todayEmptyOpen('2')}`,
    );
    expect(buttons).toEqual([defaultTexts.menu.buttonAll, defaultTexts.answer.buttonPick]);
  });

  it('«что на сегодня» при длинном списке — восемь строк и «ещё N», а не тишина (ревизия этапа 3, E12)', async () => {
    /**
     * Список «на сегодня» уходил без предела; при сотне дел текст
     * пробивал 4096 знаков, Telegram отказывал, и человек получал
     * тишину. Кнопка «Сегодня» листает по восемь — голос отвечает так же.
     * Дела — со сроком **сегодня**: просроченное в «Сегодня» больше не
     * идёт (запрос №4), оно разбирается утром.
     */
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();
    for (let index = 1; index <= 10; index += 1) {
      await testDb()
        .insert(items)
        .values({
          userId,
          text: `Дело номер ${String(index)}`,
          type: 'TASK',
          priority: 'SOON',
          topic: 'дом',
          // Часы конвейера заморожены на T0 (24.08 13:00 МСК): сегодня по
          // Москве начинается в 21:00Z накануне.
          deadlineAt: new Date('2026-08-23T21:00:00.000Z'),
          deadlineAccuracy: 'day',
        });
    }

    await queuedBatchOf([{ kind: 'text', text: 'что у меня на сегодня', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'что у меня на сегодня' }],
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

    const reply = all.find((text) => text.startsWith(defaultTexts.backlog.today)) ?? '';
    expect(reply.split('\n').filter((line) => line.startsWith('— '))).toHaveLength(8);
    expect(reply).toContain(defaultTexts.backlog.more(2));
  });

  it('после ответа на вопрос по бэклогу — тоже не добавляет', async () => {
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'что там с кассой', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'что там с кассой' }],
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

    // Без провайдера векторов ответом будет «не смогла посмотреть»
    // (ревизия этапа 3, F3: «ничего не записано» без взгляда в записи —
    // ложь) — и это ответ: заглушка после него всё равно лишняя.
    expect(all).not.toContain(defaultTexts.answer.nothingToParse);
    expect(all.at(-1)).toBe(defaultTexts.backlog.unavailable);
  });

  it('отмена голосом переводит в отменённые и откатывается', async () => {
    // §13.5: без подтверждения кнопкой, запись не удаляется физически.
    const prompts = await seedPrompts();
    const itemId = await itemWith('Записаться к ортопеду');

    await queuedBatchOf([{ kind: 'text', text: 'к ортопеду уже не нужно', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'CANCEL', text: 'к ортопеду уже не нужно' }],
      }),
      resolver: JSON.stringify({
        action: 'cancel',
        mode: 'replace',
        itemId: '1',
        confidence: 0.9,
        changes: {
          note: '',
          text: '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'дело отменяется',
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

    const [after] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(after?.status).toBe('cancelled');

    // Строка на месте: физическое удаление — только через «Удалить мои
    // данные».
    expect(after).toBeDefined();

    // И отменённое можно вернуть — «готово, когда» задачи 3.8.
    const [revision] = await testDb()
      .select()
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, itemId));

    const outcome = await revertRevision(testDb(), {
      revisionId: revision?.id ?? '',
      userId,
    });

    expect(outcome.kind).toBe('reverted');

    const [restored] = await testDb().select().from(items).where(eq(items.id, itemId));
    expect(restored?.status).toBe('new');
  });
});

describe('разбор вчерашнего при следующем обращении (запрос на изменение №4)', () => {
  /**
   * Решение заказчицы 13.09.2026 (ответ 1.2 нашего письма): утренние
   * включены — разбор внутри утреннего; выключены — при следующем
   * обращении к боту, один раз. Здесь — второй случай: отдельным
   * сообщением после ответа на выгрузку.
   */
  async function overdue(text: string): Promise<string> {
    const [row] = await testDb()
      .insert(items)
      .values({
        userId,
        text,
        type: 'TASK',
        priority: 'SOON',
        topic: 'дом',
        deadlineAt: at(-2 * 24 * 60 * 60_000),
        deadlineAccuracy: 'day',
      })
      .returning({ id: items.id });
    return row?.id ?? '';
  }

  async function remindersOff(): Promise<void> {
    await testDb()
      .update(userSettings)
      .set({ notificationsOn: false })
      .where(eq(userSettings.userId, userId));
  }

  it('утренние выключены — разбор отдельным сообщением после ответа, с кнопками и отметкой', async () => {
    const prompts = await seedPrompts();
    await remindersOff();
    const id = await overdue('Оплатить садик');
    await queuedBatchOf([{ kind: 'text', text: 'купить продукты', offsetMs: 0 }]);
    const questions = recordingQuestions();
    const llm = echoingLlm();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm,
          onboarding: questions.sender,
        }),
      },
      userId,
    );

    const review = questions.asked.find((text) => text.includes(defaultTexts.review.headerEarlier));
    expect(review).toContain(defaultTexts.review.line(1, 'Оплатить садик'));

    const [after] = await testDb().select().from(items).where(eq(items.id, id));
    expect(after?.reviewedAt).not.toBeNull();
  });

  it('второй раз в тот же день не показывается', async () => {
    const prompts = await seedPrompts();
    await remindersOff();
    await overdue('Оплатить садик');
    const questions = recordingQuestions();
    const llm = echoingLlm();

    for (const text of ['купить продукты', 'позвонить маме']) {
      await queuedBatchOf([{ kind: 'text', text, offsetMs: 0 }]);
      await processUserBatches(
        {
          db: testDb(),
          lock,
          handleBatch: handler({
            speech: new MockSpeechProvider(),
            prompts,
            llm,
            onboarding: questions.sender,
          }),
        },
        userId,
      );
    }

    expect(
      questions.asked.filter((text) => text.includes(defaultTexts.review.headerEarlier)),
    ).toHaveLength(1);
  });

  it('утренние включены — при обращении разбор не показывается: его место утром', async () => {
    const prompts = await seedPrompts();
    await overdue('Оплатить садик');
    await queuedBatchOf([{ kind: 'text', text: 'купить продукты', offsetMs: 0 }]);
    const questions = recordingQuestions();
    const llm = echoingLlm();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm,
          onboarding: questions.sender,
        }),
      },
      userId,
    );

    expect(questions.asked.some((text) => text.includes(defaultTexts.review.headerEarlier))).toBe(
      false,
    );
  });
});

describe('быстрое добавление (§13.3, задача 3.9)', () => {
  /**
   * План просит интеграционные на два примера из §13.3. Здесь проверяется
   * то, чего не видно на чистой функции: реплика действительно короткая,
   * список действий не показан, а запись при этом создана.
   */
  it('«Добавь ещё купить витамины» — одна строка и никакой выдачи', async () => {
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();

    // Дело, которое бот предложил бы, будь это обычной выгрузкой.
    await testDb().insert(items).values({
      userId,
      text: 'Сверить кассу',
      type: 'TASK',
      priority: 'NOW',
      topic: 'деньги',
    });

    await queuedBatchOf([{ kind: 'text', text: 'добавь ещё купить витамины', offsetMs: 0 }]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender }),
      },
      userId,
    );

    // Запись при этом создана: короткий ответ не значит «ничего не делал».
    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(saved).toHaveLength(2);

    // Реплика называет сферу и записанное дело (проджект, бой 21.09.2026).
    const vitamins = saved.find((item) => item.text !== 'Сверить кассу');
    if (vitamins === undefined) throw new Error('ожидалась запись про витамины');
    expect(all.at(-1)).toBe(
      defaultTexts.answer.added(withCapital(vitamins.topic ?? ''), withCapital(vitamins.text)),
    );
    expect(all.at(-1)).toMatch(/^Записала в «[^»]+»: .+\.$/u);
    // Ни списка действий, ни вопроса «с чего начнём».
    expect(all.some((text) => text.includes('Сверить кассу'))).toBe(false);
    expect(all.some((text) => text.includes('С чего начнём'))).toBe(false);
  });

  it('обычная выгрузка режим не включает', async () => {
    // Без маркера добавления «купить витамины» — это мысль, и односложный
    // ответ на неё читается как «бот не понял».
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'купить витамины', offsetMs: 0 }]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender }),
      },
      userId,
    );

    expect(all.at(-1)).not.toMatch(/^Записала в «/u);
  });
});

describe('пробный период тратит только разобранная выгрузка (§14, задача 4.3)', () => {
  /**
   * §14 считает пробный период выгрузками, а план 4.3 уточняет:
   * «быстрые добавления не считаются — только выгрузки с разбором».
   *
   * Проверяется отметка в базе, а не поведение гейта: гейт проверен у
   * приёма сообщений, а здесь важно, что́ он потом посчитает. Ошибка в
   * этом месте тихая — человек просто теряет право раньше срока.
   */

  /** Отметки траты по всем выгрузкам этого человека. */
  async function trialMarks(): Promise<(Date | null)[]> {
    const rows = await testDb()
      .select({ mark: batches.trialCountedAt })
      .from(batches)
      .where(eq(batches.userId, userId))
      .orderBy(asc(batches.openedAt));

    return rows.map((row) => row.mark);
  }

  it('разобранная выгрузка тратит', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'надо продукты и врача', offsetMs: 0 }]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts }),
      },
      userId,
    );

    const marks = await trialMarks();

    expect(marks).toHaveLength(1);
    expect(marks[0]).not.toBeNull();
  });

  it('быстрое добавление тратит: оно платит четыре этапа из пяти', async () => {
    /**
     * **Посылка плана была неверной, и ревизия это доказала.**
     *
     * План 4.3 требовал прямо: «быстрые добавления не считаются — только
     * выгрузки с разбором», и обоснование звучало так: «полсекунды не
     * равны разбору». Но признак `quickAdd` вычисляется **после**
     * маршрутизатора, извлечения, классификации и векторов — из платных
     * этапов быстрое добавление пропускает единственный, презентацию.
     * Заплачено четыре из пяти.
     *
     * Цена ошибки: человек, формулирующий мысли как «добавь ещё …», не
     * кончал пробный период никогда, а в карточке панели это выглядело
     * как «потрачено 0» при десятках разобранных выгрузок.
     *
     * Правка сделана по инварианту проекта: где черта оплаты, там и
     * граница повтора. Требование плана исправлено вместе с кодом.
     */
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'добавь ещё купить витамины', offsetMs: 0 }]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender }),
      },
      userId,
    );

    // Сперва убедимся, что режим действительно включился: иначе
    // проверка прошла бы на обычной выгрузке и ничего не значила.
    expect(all.at(-1)).toMatch(/^Записала в «[^»]+»: .+\.$/u);
    expect((await trialMarks())[0]).not.toBeNull();
  });

  it('на черте оплаты кончившийся пробный останавливает разбор до модели', async () => {
    /**
     * **Одиннадцать разборов вместо десяти.** Гейт приёма спрашивает
     * «потрачено» в момент, когда человек говорит, а трата стояла в
     * конце разбора: между точками — окно тишины плюс разбор, около
     * полутора минут. Две мысли подряд, и вторая проходила гейт, пока
     * первая ещё разбиралась.
     *
     * Здесь это воспроизведено прямо: предел добит, а выгрузка уже в
     * очереди — ровно то состояние, в котором прежде платили одиннадцать
     * раз. Обращения к модели быть не должно, и слово человеку — должно.
     */
    const prompts = await seedPrompts();
    await putSetting(testDb(), { name: 'trialDumps', value: '1' });

    // Один разбор уже потрачен: предел добит.
    await testDb()
      .insert(batches)
      .values({
        userId,
        status: 'done',
        openedAt: at(-600_000),
        closedAt: at(-590_000),
        trialCountedAt: at(-590_000),
      });

    const { sender, all } = recordingSender();
    await queuedBatchOf([{ kind: 'text', text: 'надо продукты и врача', offsetMs: 0 }]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender }),
      },
      userId,
    );

    /**
     * Меряются **деньги**, а не вызовы: строка учёта появляется у
     * каждого платного обращения, и её отсутствие означает, что мы не
     * заплатили ни разу. Считать вызовы обёрткой над провайдером было бы
     * слабее — обёртка не видит расшифровку.
     */
    const paid = await testDb().select().from(aiCalls);

    expect(paid).toHaveLength(0);

    // И человеку сказано словами из словаря, а не промолчано.
    expect(all.at(-1)).toBe(defaultTexts.limits.trialOver);
  });

  it('«привет» не тратит: разбирать было нечего', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'привет', offsetMs: 0 }]);

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
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm }),
      },
      userId,
    );

    expect((await trialMarks())[0]).toBeNull();
  });

  it('сбой извлечения не тратит: человек не платит за нашу поломку', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'надо продукты', offsetMs: 0 }]);

    const llm = echoingLlm({ extractor: 'это не JSON' });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm }),
      },
      userId,
    );

    expect((await trialMarks())[0]).toBeNull();
  });

  it('повторная обработка не тратит дважды', async () => {
    /**
     * Конвейер возвращает выгрузку в очередь при временном сбое — то
     * есть повтор здесь не теоретический. Отметка идемпотентна: она
     * ставится только на пустое поле.
     */
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'надо продукты и врача', offsetMs: 0 }]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts }),
      },
      userId,
    );

    expect((await trialMarks())[0]).not.toBeNull();

    /**
     * Отметке ставится заведомо другое время, и только потом идёт второй
     * разбор.
     *
     * Первая версия проверки сравнивала время до и после — и прошла под
     * диверсией, снявшей условие `isNull`: часы разбора в тесте
     * фиксированные, поэтому перезапись давала ровно то же значение.
     * Проверка, которая не может покраснеть, годится только на то,
     * чтобы её отключили.
     */
    const stamped = new Date('2026-01-01T00:00:00.000Z');

    await testDb()
      .update(batches)
      .set({ status: 'queued', trialCountedAt: stamped })
      .where(eq(batches.userId, userId));

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts }),
      },
      userId,
    );

    const marks = await trialMarks();

    // Выгрузка одна, отметка одна, и время у неё прежнее: второй разбор
    // права человека не потратил и отметку не тронул.
    expect(marks).toHaveLength(1);
    expect(marks[0]?.getTime()).toBe(stamped.getTime());
  });
});

describe('вопрос по бэклогу ничего не создаёт (§13.4, задача 3.10)', () => {
  /**
   * План просит интеграционный тест со счётчиком созданных записей —
   * он должен быть ноль. Это и есть всё требование §13.4: человек
   * спросил, а получил три новых дела — это не ответ, а встречное
   * требование.
   */
  it('«что на сегодня» отвечает списком и не заводит ни одной записи', async () => {
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();

    await testDb().insert(items).values({
      userId,
      text: 'Сверить кассу',
      type: 'TASK',
      priority: 'NOW',
      topic: 'деньги',
    });

    const before = await testDb().select().from(items).where(eq(items.userId, userId));

    await queuedBatchOf([{ kind: 'text', text: 'что там на сегодня', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'что там на сегодня' }],
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

    expect(all.some((text) => text.includes('Сверить кассу'))).toBe(true);

    const after = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(after).toHaveLength(before.length);
  });

  it('вопрос не оседает черновиком', async () => {
    // До третьего этапа QUERY уходил в черновик с пометкой «ждёт
    // резолвера». Теперь на него отвечают, и мусора в админке не остаётся.
    const prompts = await seedPrompts();

    await queuedBatchOf([{ kind: 'text', text: 'что там с альбомом', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'что там с альбомом' }],
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

    const drafts = await testDb().select().from(items).where(eq(items.isDraft, true));
    expect(drafts).toEqual([]);
  });

  it('вопрос внутри выгрузки, на который «ничего не записано», — мысль, а не вопрос (видео заказчицы 15.09.2026)', async () => {
    /**
     * Голосовое заказчицы: «…потом заказать цветы. Вспомнить, когда мы
     * последний раз договаривались с няней на восьмичасовую работу. И
     * если что обговорить с ней новые условия». Маршрутизатор отдал
     * среднее как QUERY — бот ответил «Про это у меня ничего не
     * записано», мысль про няню пропала, а «с ней» приклеилось к
     * соседнему делу. Правило: вопрос **внутри выгрузки**, на который
     * ответить нечем, — это мысль: уходит в разбор на своём месте, ответа
     * «ничего не записано» нет. Тот же принцип, что у ответа на уточнение:
     * всё сверх ответа — в разбор, никогда в никуда.
     */
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();

    const FIRST = 'Потом заказать цветы';
    const ASKED =
      'Вспомнить, когда мы последний раз договаривались с няней на восьмичасовую работу';
    const LAST = 'И если что обговорить с ней новые условия';

    await queuedBatchOf([{ kind: 'text', text: `${FIRST}. ${ASKED}? ${LAST}.`, offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'DUMP', text: FIRST },
          { intent: 'QUERY', text: ASKED },
          { intent: 'DUMP', text: LAST },
        ],
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
          sender,
          embedder: new MockEmbeddingProvider(),
        }),
      },
      userId,
    );

    expect(all).not.toContain(defaultTexts.backlog.nothing);

    // Мысль про няню — на своём месте, между соседями: так «с ней» читается
    // про няню, а не про кого-то из другой фразы.
    const saved = await testDb()
      .select({ text: items.text })
      .from(items)
      .where(eq(items.userId, userId))
      .orderBy(items.sourceOrder);
    expect(saved.map((one) => one.text)).toEqual([FIRST, ASKED, LAST]);
  });

  it('«спасибо» — «Пожалуйста 🤍 Я всё помню.», а не «расскажешь, что в голове?»', async () => {
    /**
     * Заказчица, 16.09.2026: сердечко — редкий знак тепла; «женщина
     * поблагодарила бота» — одна из немногих ситуаций для него. Слово
     * узнаётся по закрытому списку, маршрутизатор отдаёт его как
     * SMALLTALK — прежде на такое приходило «Я здесь. Расскажешь, что в
     * голове?», будто благодарность не услышана.
     */
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'Спасибо большое!', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'SMALLTALK', text: 'Спасибо большое!' }],
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

    expect(all).toEqual([defaultTexts.answer.thanks]);
    expect(await testDb().select().from(items).where(eq(items.userId, userId))).toEqual([]);
  });

  it('«вымоталась» без дел, даже если маршрутизатор счёл это болтовнёй, — её реплика про батарейку', async () => {
    /**
     * Заказчица, 16.09.2026, про эмоции: «Я сегодня вообще вымоталась» →
     * «Похоже, батарейка на сегодня почти всё 😮‍💨 Если хочешь — просто
     * выгружай сюда всё, что ещё крутится в голове.» Слово о состоянии
     * узнаётся кодом по сказанному, а не по решению модели: SMALLTALK от
     * маршрутизатора прежде получал «Я здесь. Расскажешь, что в голове?»
     * — будто не услышал.
     */
    const prompts = await seedPrompts();
    const { sender, all, buttons } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'Я сегодня вообще вымоталась', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'SMALLTALK', text: 'Я сегодня вообще вымоталась' }],
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

    expect(all).toEqual([defaultTexts.answer.feelingsOnlyTired]);
    expect(buttons).toEqual([]);
  });

  it('«я в панике» без дел — спокойно и без эмодзи: «Вижу, сейчас тяжело…»', async () => {
    // Сильная эмоция — юмор выключается, тон бережный; кризис (§13.7)
    // сюда не относится: маршрутизатор его не поднял, маркеров нет.
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'Я в панике, всё разваливается', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'SMALLTALK', text: 'Я в панике, всё разваливается' }],
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

    expect(all).toEqual([defaultTexts.answer.feelingsOnlyHeavy]);
    expect(all[0]).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('вопрос сам по себе, без мыслей рядом, отвечается «ничего не записано» как раньше', async () => {
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'что там с няней', offsetMs: 0 }]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: 'что там с няней' }],
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
          sender,
          embedder: new MockEmbeddingProvider(),
        }),
      },
      userId,
    );

    expect(all.at(-1)).toBe(defaultTexts.backlog.nothing);
    expect(await testDb().select().from(items).where(eq(items.userId, userId))).toEqual([]);
  });

  it('ответ о проекте несёт кнопку «Шаг сделан»', async () => {
    /**
     * §21 п.6 обещает показать, что уже решено, — а закрыть шаг до
     * задачи 3.82 было нечем ни кнопкой, ни голосом: `completeStep` не
     * звал никто, `doneAt` оставался пустым, и раздел «Сделано» не мог
     * наполниться никогда.
     *
     * Проверка здесь, а не только у обработчика: сам обработчик был
     * написан и покрыт тестами, но кнопки, которая его позовёт, в ответе
     * не было. Ровно тот разрыв «модуль есть, а наверх не отдаёт».
     */
    const prompts = await seedPrompts();

    const ASKED = 'что там с днём рождения';

    /**
     * Вектор — тот же, что посчитает заглушка на вопрос: ответ про
     * проект выбирается по смысловой близости, и без вектора запись
     * просто не нашлась бы. Заглушка детерминирована, поэтому близость
     * выходит ровно единица.
     */
    const asked = await new MockEmbeddingProvider().embed({ text: ASKED, purpose: 'query' });

    const [project] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'День рождения дочки',
        type: 'TASK',
        priority: 'SOON',
        topic: 'семья',
        isProject: true,
        embedding: [...asked.vector],
      })
      .returning();

    if (!project) throw new Error('проект не создался');

    // Шаги уже есть — значит разложение не позовётся и модель не нужна.
    await testDb()
      .insert(projectSteps)
      .values([
        { itemId: project.id, userId, text: 'Позвонить в кафе', position: 0 },
        { itemId: project.id, userId, text: 'Позвать гостей', position: 1 },
      ]);

    await queuedBatchOf([{ kind: 'text', text: ASKED, offsetMs: 0 }]);
    const { sender, all, buttons } = recordingSender();

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [{ intent: 'QUERY', text: ASKED }],
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
          sender,
          // Ответ про проект выбирается по вектору: без заглушки
          // векторов вопрос не находит ничего.
          embedder: new MockEmbeddingProvider(),
        }),
      },
      userId,
    );

    expect(all.some((text) => text.includes('Позвонить в кафе'))).toBe(true);
    expect(buttons).toContain(defaultTexts.project.buttonStepDone);
  });
});

describe('жалоба с боевого 31.08.2026 (задача 3.22)', () => {
  /**
   * Проджект заказчицы назвал шесть дел и попросил разложить. В ответе
   * увидел три чужих — «сходить с собакой» и два «к врачу» из прошлых
   * выгрузок. Решил, что бот сломался, и отправил то же голосовое ещё
   * дважды: в базе стало восемнадцать записей вместо шести.
   *
   * Здесь проверяется весь путь, а не отдельный фильтр: в модульных
   * тестах порядок был верен и до починки — пометка «сказано сейчас»
   * просто не доходила из конвейера.
   */

  const SAID = [
    'съездить в магазин',
    'оплатить бухгалтеру налоги',
    'позвонить заказчику',
    'отправить ссылки на сайт',
    'купить себе витамины',
    'заплатить по учёбе',
  ];

  /** Три дела из прошлых выгрузок — те самые, что вытесняли свежие. */
  async function seedOld(): Promise<void> {
    await testDb()
      .insert(items)
      .values([
        {
          userId,
          text: 'записать к врачу в четверг',
          type: 'TASK',
          priority: 'SOON',
          topic: 'здоровье',
          deadlineAt: new Date('2026-08-27T09:00:00.000Z'),
          deadlineAccuracy: 'day',
        },
        {
          userId,
          text: 'Записаться к врачу в пятницу',
          type: 'TASK',
          priority: 'SOON',
          topic: 'здоровье',
          deadlineAt: new Date('2026-08-28T09:00:00.000Z'),
          deadlineAccuracy: 'day',
        },
        {
          userId,
          text: 'Нужно сходить с собакой погулять',
          type: 'TASK',
          priority: 'NOW',
          topic: 'личное',
        },
      ]);
  }

  async function dump(
    sender: StatusSender,
    prompts: PromptRegistry,
    embedder?: MockEmbeddingProvider,
    said: readonly string[] = SAID,
  ): Promise<void> {
    await queuedBatchOf([{ kind: 'text', text: said.join(NEWLINE), offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender, embedder }),
      },
      userId,
    );
  }

  async function openTexts(): Promise<string[]> {
    const rows = await testDb().select().from(items).where(eq(items.userId, userId));
    return rows.map((row) => row.text);
  }

  it('в ответе стоят названные сейчас дела, а не старые', async () => {
    const prompts = await seedPrompts();
    await seedOld();
    const { sender } = recordingSender();

    await dump(sender, prompts);

    // Дел под признанием нет (решение заказчицы 15.09.2026) — они по
    // «Выбрать главное», и там первыми стоят названные сейчас.
    const answer = (await pickedNow()).join('\n');

    for (const said of SAID.slice(0, 3)) {
      // Регистр здесь не проверяется — он приводится при сохранении
      // (3.25) и покрыт своими тестами.
      expect(answer.toLowerCase(), `в ответе нет «${said}»`).toContain(said);
    }
    expect(answer).not.toContain('к врачу');
    expect(answer).not.toContain('с собакой');
  });

  it('та же выгрузка второй раз не заводит вторую копию', async () => {
    const prompts = await seedPrompts();
    await seedOld();
    const { sender } = recordingSender();

    await dump(sender, prompts);
    const afterFirst = await openTexts();

    await dump(sender, prompts);
    const afterSecond = await openTexts();

    // Три засеянных плюс шесть названных — и ни одной записи больше.
    expect(afterFirst).toHaveLength(9);
    expect(afterSecond).toHaveLength(9);
  });

  it('повтор отвечает так же, а не пустотой', async () => {
    /**
     * Важнее, чем кажется. Отсев повторов не должен менять разговор:
     * человек повторил — значит он об этих делах думает, и ответ обязан
     * быть про них, а не «ничего нового».
     */
    const prompts = await seedPrompts();
    await seedOld();
    const { sender } = recordingSender();

    await dump(sender, prompts);
    const first = (await pickedNow()).join('\n');

    await dump(sender, prompts);
    const second = (await pickedNow()).join('\n');

    // Повторная выгрузка новых записей не завела — но упомянутое в ней
    // запомнено (`mentioned_item_ids`), и очередь по кнопке та же.
    for (const said of SAID.slice(0, 3)) {
      expect(second.toLowerCase(), `в повторном ответе нет «${said}»`).toContain(said);
    }
    expect(second).toBe(first);
  });

  it('новое дело в повторной выгрузке всё-таки заводится', async () => {
    // Отсев не должен глотать то, чего человек раньше не говорил.
    const prompts = await seedPrompts();
    const { sender } = recordingSender();

    await dump(sender, prompts);

    await queuedBatchOf([
      { kind: 'text', text: [...SAID, 'забрать права'].join(NEWLINE), offsetMs: 0 },
    ]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender }),
      },
      userId,
    );

    expect((await openTexts()).map((one) => one.toLowerCase())).toContain('забрать права');
    expect(await openTexts()).toHaveLength(SAID.length + 1);
  });

  it('за вектор повтора не платят: считается только то, что будет сохранено', async () => {
    /**
     * Ревизия этапов 1–2, дефект 32. Вектор считался по всем единицам
     * выгрузки, а отсев повторов шёл следующей строкой. Повтору запись не
     * нужна — значит не нужен и вектор: свежий никуда не записывался, а у
     * существующей записи он посчитан при создании или досчитывается
     * отдельно. Тот самый боевой случай — одно голосовое трижды —
     * оплачивал векторы трижды. Учёт при этом был верен, деньги просто
     * уходили в никуда: платит отправка, а не результат.
     *
     * Считаются отправки провайдеру, а не строки учёта: черта оплаты
     * проходит по отправке. Только `document`: вектор запроса (`query`)
     * считает резолвер, и к сохранению он отношения не имеет.
     */
    const prompts = await seedPrompts();
    await seedOld();
    const { sender } = recordingSender();
    const embedder = new MockEmbeddingProvider();

    const documents = (): number =>
      embedder.requests.filter((one) => one.purpose === 'document').length;

    await dump(sender, prompts, embedder);
    const paidOnce = documents();
    // Новых записей шесть — и за вектор заплачено ровно шесть раз.
    expect(paidOnce, 'первая выгрузка платит за вектор каждой новой записи').toBe(SAID.length);

    await dump(sender, prompts, embedder);
    expect(documents() - paidOnce, 'повтор оплатил векторы заново').toBe(0);

    // Одно новое дело среди повторов — один вектор, а не семь и не ноль.
    await dump(sender, prompts, embedder, [...SAID, 'забрать права']);
    expect(documents() - paidOnce, 'за новое дело среди повторов платят ровно раз').toBe(1);
  });

  it('повтор не заводит копию записи, куда модель вписала поля карточки', async () => {
    /**
     * Две боевые находки встречаются. Живой прогон 05.09.2026 (задача
     * 3.62): модель вернула «Позвонить бабушке. Срок 07.09 / Статус
     * ждет», а сохранилось «Позвонить бабушке». Отсев повторов (3.22)
     * сверял сырой текст модели с сохранённым — и на такой записи
     * промахивался: вторая выгрузка заводила ей копию, хотя остальные
     * пять узнавала. То есть починка «восемнадцать вместо шести» не
     * работала ровно там, где текст уже испортил другой дефект.
     */
    const GRANDMA = 'позвонить бабушке';
    const WITH_FIELDS = `Позвонить бабушке. Срок 07.09${NEWLINE}Статус ждет`;

    const prompts = await seedPrompts();
    await seedOld();
    const { sender } = recordingSender();

    const llm = echoingLlm({
      classifier: (request) =>
        JSON.stringify({
          items: unitsFromInput(request.input).map((text) => ({
            // Так ответила живая модель: поля карточки внутри заголовка.
            text: text === GRANDMA ? WITH_FIELDS : text,
            type: 'TASK',
            priority: 'SOON',
            topic: 'личное',
            isProject: false,
            deadline: '',
            deadlineAccuracy: 'none',
            recurrenceKind: 'none',
            recurrenceInterval: 0,
            recurrenceText: '',
            deadlineText: '',
          })),
        }),
    });

    async function dumpWithGrandma(): Promise<void> {
      await queuedBatchOf([{ kind: 'text', text: [...SAID, GRANDMA].join(NEWLINE), offsetMs: 0 }]);
      await processUserBatches(
        {
          db: testDb(),
          lock,
          handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
        },
        userId,
      );
    }

    await dumpWithGrandma();
    const afterFirst = await openTexts();

    // Поля карточки в базу не попали (3.62) — на этом и держится повтор.
    expect(afterFirst).toContain('Позвонить бабушке');
    expect(afterFirst).toHaveLength(3 + SAID.length + 1);

    await dumpWithGrandma();
    const afterSecond = await openTexts();

    expect(afterSecond.filter((text) => text === 'Позвонить бабушке')).toHaveLength(1);
    expect(afterSecond).toHaveLength(afterFirst.length);
  });
});

describe('правка к сказанному в этой же выгрузке (задача 3.24)', () => {
  /**
   * Дефект найден ручным прогоном на боевом 01.09.2026.
   *
   * Человек в одной выгрузке сказал «…приходила не в 11, а в 9», и сразу
   * «Нет, лучше не в 9, а в 9 30». Первая фраза стала записью, вторая —
   * правкой, но правки разбираются **до** сохранения, и цели для неё в
   * базе ещё не было. Поправка ушла в невидимый черновик, а в записи
   * осталось промежуточное значение: 9 вместо 9:30. Человек об этом не
   * узнал — и это хуже потери текста: запись выглядит верной.
   *
   * Здесь проверяется весь путь. Резолвер подменён так, как ответила бы
   * живая модель: увидев запись про няню среди кандидатов, она называет
   * её номер.
   */

  const NANNY = 'договориться с няней, чтобы приходила в 9';
  const FIXED = 'договориться с няней, чтобы приходила в 9 30';
  /**
   * Как запись выглядит в списке кандидатов: с заглавной.
   *
   * Регистр ставится при сохранении (задача 3.25), и резолвер видит
   * именно сохранённый текст. Литералом, а не вызовом `withCapital`:
   * тест не должен повторять реализацию, которую проверяет.
   */
  const NANNY_SAVED = 'Договориться с няней, чтобы приходила в 9';

  /** Резолвер, который находит запись про няню, когда она уже сохранена. */
  function resolverThatFindsNanny(): (request: CompletionRequest) => string {
    return (request) => {
      const known = request.input.includes('нян');

      return JSON.stringify({
        action: known ? 'update' : 'new',
        mode: 'replace',
        itemId: known ? String(numberOfCandidate(request.input, NANNY_SAVED)) : '',
        confidence: known ? 0.95 : 0.1,
        changes: {
          note: '',
          text: known ? FIXED : '',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: known ? 'поправка времени к записи про няню' : 'цели нет',
      });
    };
  }

  async function dump(sender: StatusSender, prompts: PromptRegistry): Promise<void> {
    await queuedBatchOf([
      { kind: 'text', text: `${NANNY}${NEWLINE}нет, лучше в 9 30`, offsetMs: 0 },
    ]);

    const llm = echoingLlm({
      // Так размечает живой маршрутизатор: «нет» есть в закрытом списке
      // признаков правки §7.1.
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'DUMP', text: NANNY },
          { intent: 'PATCH', text: 'нет, лучше в 9 30' },
        ],
      }),
      resolver: resolverThatFindsNanny(),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );
  }

  it('поправка доезжает до записи, а не в черновик', async () => {
    const prompts = await seedPrompts();
    const { sender } = recordingSender();

    await dump(sender, prompts);

    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    const parsed = saved.filter((one) => !one.isDraft);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.text).toBe('Договориться с няней, чтобы приходила в 9 30');
    expect(saved.filter((one) => one.isDraft)).toHaveLength(0);
  });

  it('изменение записано ревизией — значит его можно откатить', async () => {
    const prompts = await seedPrompts();
    const { sender } = recordingSender();

    await dump(sender, prompts);

    const revisions = await testDb()
      .select()
      .from(itemRevisions)
      .where(eq(itemRevisions.userId, userId));

    expect(revisions).toHaveLength(1);
  });

  it('человек видит и правку, и разбор — двумя сообщениями', async () => {
    /**
     * Вторая половина починки. Статусное сообщение одно, и `finishStatus`
     * его правит: подтверждение изменения затиралось итоговым ответом
     * §13.2 вместе с кнопкой отката. То есть правка применилась бы, а
     * человек всё равно ничего бы не заметил.
     */
    const prompts = await seedPrompts();
    const { sender, said } = recordingSender();

    await dump(sender, prompts);

    const toPerson = said.filter((one) => one.text.trim() !== '');
    const withUndo = toPerson.filter((one) =>
      one.buttons.includes(defaultTexts.resolver.buttonUndo),
    );
    const withAnswer = toPerson.filter((one) =>
      one.buttons.includes(defaultTexts.answer.buttonPick),
    );

    expect(withUndo, `реплики: ${JSON.stringify(toPerson)}`).toHaveLength(1);
    expect(withAnswer).toHaveLength(1);

    /**
     * **Проверяется способ отправки, а не наличие текста.** Первая версия
     * этого теста смотрела только на то, что реплик две, — и осталась
     * зелёной, когда я нарочно вернул затирание: фейковый отправитель
     * пишет в один список и правку, и отправку. Ровно та же ошибка, что
     * была с кнопками §13.2.
     *
     * Смотреть надо на **ответ**: он обязан уйти новым сообщением, иначе
     * затрёт подтверждение вместе с кнопкой отката. Способ отправки
     * самого подтверждения тут ни при чём — у текстовой выгрузки
     * статусного сообщения ещё нет, и первая реплика его создаёт, а у
     * голосовой оно уже есть от «Разбираю…», и та же реплика правит.
     */
    expect(withAnswer[0]?.kind, `реплики: ${JSON.stringify(toPerson)}`).toBe('send');
    expect(withUndo[0]?.text).not.toBe(withAnswer[0]?.text);
  });

  it('в подтверждении назван поправленный текст', async () => {
    const prompts = await seedPrompts();
    const { sender, said } = recordingSender();

    await dump(sender, prompts);

    const confirmation = said.find((one) => one.buttons.includes(defaultTexts.resolver.buttonUndo));

    expect(confirmation?.text).toContain('9 30');
  });
});

describe('второй проход целится в свою выгрузку (задача 3.24, боевое 02.09.2026)', () => {
  /**
   * Промах в самой починке 3.24, найденный ручным прогоном на следующий
   * день.
   *
   * Человек сказал одной фразой «Договориться с няней, чтобы приходила в
   * 10. Нет, лучше в 10 30», а поправка ушла в **другую** запись про
   * няню, заведённую утром. Она похожа сильнее — и по вектору, и по
   * свежести, — поэтому резолвер выбрал её. В итоге правка попала не туда
   * дважды: утренняя запись получила чужое время, а только что созданная
   * осталась неправленой.
   *
   * Второй проход существует ровно для случая «цель названа здесь же».
   * Первый проход уже искал по всему и не нашёл — значит расширять нечем,
   * надо сужать. Теперь он ищет только среди записей своей выгрузки.
   */

  const MORNING = 'Договориться с няней, чтобы она поменяла график работы, приходить в 9';
  const FRESH = 'Договориться с няней, чтобы приходила в 10';
  const FIXED = 'Договориться с няней, чтобы приходила в 10 30';

  /**
   * Резолвер, ведущий себя как живая модель: из двух записей про няню
   * выбирает более похожую — утреннюю.
   */
  function resolverPreferringMorning(): (request: CompletionRequest) => string {
    return (request) => {
      const target = request.input.includes(MORNING)
        ? MORNING
        : request.input.includes(FRESH)
          ? FRESH
          : undefined;

      return JSON.stringify({
        action: target === undefined ? 'new' : 'update',
        mode: 'replace',
        itemId: target === undefined ? '' : String(numberOfCandidate(request.input, target)),
        confidence: target === undefined ? 0.1 : 0.95,
        changes: {
          note: '',
          text: target === undefined ? '' : FIXED,
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'поправка времени',
      });
    };
  }

  it('правит запись этой выгрузки, а не похожую из прошлой', async () => {
    const prompts = await seedPrompts();
    const { sender } = recordingSender();

    // Утренняя запись: своей выгрузки у неё нет, как и у любой прошлой.
    await testDb().insert(items).values({
      userId,
      text: MORNING,
      type: 'TASK',
      priority: 'SOON',
      topic: 'семья',
    });

    await queuedBatchOf([
      { kind: 'text', text: `${FRESH}${NEWLINE}нет, лучше в 10 30`, offsetMs: 0 },
    ]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'DUMP', text: FRESH },
          { intent: 'PATCH', text: 'нет, лучше в 10 30' },
        ],
      }),
      resolver: resolverPreferringMorning(),
    });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    const texts = saved.filter((one) => !one.isDraft).map((one) => one.text);

    // Утренняя не тронута.
    expect(texts, `записи: ${texts.join(' | ')}`).toContain(MORNING);
    // А свежая — поправлена.
    expect(texts).toContain(FIXED);
    expect(texts).not.toContain(FRESH);
  });

  it('поправку уже учёл разбор выгрузки — правка молчит: ни «менять нечего», ни черновика (живая проверка 24.09.2026)', async () => {
    /**
     * «Купить хлеб. Не хлеб, а батон.» одной выгрузкой: модель записала
     * «Купить батон» сама, а правка на втором проходе нашла его уже таким
     * и отвечала «Там уже так — менять нечего», заводя черновик «Не хлеб,
     * а батон.». Человек читал это как «не получилось».
     */
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();
    const unit = {
      text: 'Купить батон',
      type: 'TASK',
      priority: 'SOON',
      topic: 'покупки',
      isProject: false,
      deadline: '',
      deadlineAccuracy: 'none',
      deadlineText: '',
      recurrenceKind: 'none',
      recurrenceInterval: 0,
      recurrenceText: '',
    };

    await queuedBatchOf([
      { kind: 'text', text: `Купить хлеб.${NEWLINE}Не хлеб, а батон.`, offsetMs: 0 },
    ]);

    const llm = echoingLlm({
      router: JSON.stringify({
        crisis: false,
        segments: [
          { intent: 'DUMP', text: 'Купить хлеб.' },
          { intent: 'PATCH', text: 'Не хлеб, а батон.' },
        ],
      }),
      extractor: () =>
        JSON.stringify({ units: [{ text: 'Купить батон', isProject: false, isEmotion: false }] }),
      classifier: () => JSON.stringify({ items: [unit] }),
      resolver: JSON.stringify({
        action: 'update',
        mode: 'replace',
        itemId: '1',
        confidence: 0.9,
        changes: {
          note: '',
          text: 'Купить батон',
          deadline: '',
          deadlineAccuracy: 'none',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'поправка названия',
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

    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(saved.filter((one) => !one.isDraft).map((one) => one.text)).toEqual(['Купить батон']);
    expect(saved.filter((one) => one.isDraft).map((one) => one.text)).toEqual([]);
    expect(all.some((line) => line.includes(defaultTexts.resolver.unchanged))).toBe(false);
  });
});

describe('сферы по содержанию (правка заказчицы 14.09.2026, п. 1.1)', () => {
  /**
   * §6.4 её ТЗ запрещал заводить сферы без спроса, и опрос спрашивал
   * «какие сферы важны». 14.09 она решила иначе: сферы — внутренняя
   * организация бота; есть подходящая — туда, явно нужна новая — завести
   * самому, не уверен — в общую. Промпт не меняется: модель и раньше
   * называла темы не из списка, а бот их молча заменял на общую.
   */
  const classifierNaming = (topicOf: (text: string) => string) => (request: { input: string }) =>
    JSON.stringify({
      items: unitsFromInput(request.input).map((text) => ({
        text,
        type: 'TASK',
        priority: 'SOON',
        topic: topicOf(text),
        isProject: false,
        deadline: '',
        deadlineAccuracy: 'none',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
        deadlineText: '',
      })),
    });

  async function ownTopics(names: readonly string[]): Promise<FakeTopicGateway> {
    const gateway = new FakeTopicGateway();
    await testDb()
      .insert(topics)
      .values(
        names.map((name, index) => ({ userId, name, sortOrder: index, isDefault: index === 0 })),
      );
    for (const row of await testDb().select().from(topics).where(eq(topics.userId, userId))) {
      await ensureThread({ db: testDb(), gateway }, { topicId: row.id, chatId: 700 });
    }
    return gateway;
  }

  async function run(gateway: FakeTopicGateway, topicOf: (text: string) => string): Promise<void> {
    const prompts = await seedPrompts();
    const { sender } = recordingSender();
    const llm = echoingLlm({ classifier: classifierNaming(topicOf) });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm,
          sender,
          topics: gateway,
        }),
      },
      userId,
    );
  }

  it('модель назвала сферу, которой нет, — сфера заводится, запись в ней, ветка в чате', async () => {
    const gateway = await ownTopics(['личное', 'дом']);
    await queuedBatchOf([{ kind: 'text', text: 'прочитать книгу по саморазвитию', offsetMs: 0 }]);

    await run(gateway, () => 'саморазвитие');

    const mine = await listTopics(testDb(), userId);
    expect(mine.map((topic) => topic.name)).toEqual(['личное', 'дом', 'саморазвитие']);

    const saved = await testDb().select().from(items);
    expect(saved.map((item) => item.topic)).toEqual(['саморазвитие']);

    // Ветка и сводка появились сразу — человек видит сферу, а не строку в базе.
    expect(gateway.created.map((thread) => thread.name)).toContain('саморазвитие');
    const created = mine.find((topic) => topic.name === 'саморазвитие');
    expect(created?.tgThreadId).not.toBeNull();
  });

  it('предел сфер из настроек держится: сверх него запись остаётся в общей', async () => {
    const names = Array.from({ length: MAX_TOPICS }, (_none, index) => `сфера${String(index)}`);
    const gateway = await ownTopics(['личное', ...names.slice(1)]);
    await queuedBatchOf([{ kind: 'text', text: 'прочитать книгу', offsetMs: 0 }]);

    await run(gateway, () => 'саморазвитие');

    const mine = await listTopics(testDb(), userId);
    expect(mine.map((topic) => topic.name)).not.toContain('саморазвитие');
    expect(mine).toHaveLength(MAX_TOPICS);

    const saved = await testDb().select().from(items);
    expect(saved.map((item) => item.topic)).toEqual(['личное']);
  });

  it('сфера, которую человек выключил, не возвращается сама', async () => {
    // Он снял «покупки» в настройках — это его решение, и модель, назвав
    // «покупки» для нового дела, его не отменяет: дело в общую.
    const gateway = await ownTopics(['личное']);
    await testDb()
      .insert(topics)
      .values({ userId, name: 'покупки', sortOrder: 5, isDefault: false, isArchived: true });
    await queuedBatchOf([{ kind: 'text', text: 'купить молоко', offsetMs: 0 }]);

    await run(gateway, () => 'покупки');

    const mine = await listTopics(testDb(), userId);
    expect(mine.map((topic) => topic.name)).toEqual(['личное']);

    const saved = await testDb().select().from(items);
    expect(saved.map((item) => item.topic)).toEqual(['личное']);
  });

  it('из ветки новая сфера не заводится: человек уже выбрал сферу сам', async () => {
    // «Если не уверен — лучше без новой сферы»: в ветке «дом» контекст
    // задал человек, и догадка модели о «саморазвитии» его не перебивает.
    const gateway = await ownTopics(['личное', 'дом']);
    const [home] = await testDb().select().from(topics).where(eq(topics.name, 'дом'));
    await queuedBatchOf([
      { kind: 'text', text: 'прочитать книгу', offsetMs: 0, threadId: home?.tgThreadId ?? 0 },
    ]);

    await run(gateway, () => 'саморазвитие');

    const mine = await listTopics(testDb(), userId);
    expect(mine.map((topic) => topic.name)).toEqual(['личное', 'дом']);

    const saved = await testDb().select().from(items);
    expect(saved.map((item) => item.topic)).toEqual(['дом']);
  });

  it('две записи в одну новую сферу — сфера одна', async () => {
    const gateway = await ownTopics(['личное']);
    // Две единицы: извлечение-заглушка делит по строкам.
    await queuedBatchOf([{ kind: 'text', text: 'прочитать книгу\nпройти курс', offsetMs: 0 }]);

    await run(gateway, () => 'Саморазвитие');

    const mine = await listTopics(testDb(), userId);
    expect(mine.map((topic) => topic.name)).toEqual(['личное', 'саморазвитие']);

    const saved = await testDb().select().from(items);
    expect(saved).toHaveLength(2);
    expect(saved.every((item) => item.topic === 'саморазвитие')).toBe(true);
    expect(gateway.created.filter((thread) => thread.name === 'саморазвитие')).toHaveLength(1);
  });
});

describe('наблюдатель конвейера (стенд набора, 20.09.2026)', () => {
  /**
   * Стенд контрольного набора шесть раз мерил не то, что работает в бою,
   * — всякий раз потому, что собирал вход для модели сам. Теперь стенд
   * гонит случай через этот же обработчик, а что именно дошло до каждого
   * этапа, узнаёт наблюдателем: отрезки маршрутизатора, вход извлечения
   * и его единицы, сырой ответ классификации и записи после правок кода.
   * Наблюдатель ничего не меняет — только смотрит.
   */
  async function observed(text: string): Promise<PipelineEvent[]> {
    const prompts = await seedPrompts();
    const events: PipelineEvent[] = [];
    await queuedBatchOf([{ kind: 'text', text, offsetMs: 0 }]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          observe: (event) => {
            events.push(event);
          },
        }),
      },
      userId,
    );

    return events;
  }

  it('видит отрезки маршрутизатора, вход извлечения с единицами и ответ классификации', async () => {
    const events = await observed(`купить хлеб${NEWLINE}записаться к врачу`);

    expect(events.map((event) => event.kind)).toEqual(['routed', 'extracted', 'classified']);

    const routed = events[0];
    expect(routed?.kind === 'routed' && routed.segments).toEqual([
      { intent: 'DUMP', text: `купить хлеб${NEWLINE}записаться к врачу` },
    ]);

    const extracted = events[1];
    expect(extracted?.kind === 'extracted' && extracted.dumpText).toBe(
      `купить хлеб${NEWLINE}записаться к врачу`,
    );
    expect(extracted?.kind === 'extracted' && extracted.units.map((unit) => unit.text)).toEqual([
      'купить хлеб',
      'записаться к врачу',
    ]);

    const classified = events[2];
    expect(
      classified?.kind === 'classified' && classified.fromModel.map((item) => item.text),
    ).toEqual(['купить хлеб', 'записаться к врачу']);
    // Записи после правок кода классификации; заглавная ставится позже,
    // при сохранении (задача 3.25), и наблюдателю не видна.
    expect(classified?.kind === 'classified' && classified.items.map((item) => item.text)).toEqual([
      'купить хлеб',
      'записаться к врачу',
    ]);
    expect(classified?.kind === 'classified' && classified.items[0]).toMatchObject({
      type: 'TASK',
      topic: 'личное',
    });
  });

  it('без наблюдателя обработчик работает как прежде', async () => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text: 'купить хлеб', offsetMs: 0 }]);

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts }),
      },
      userId,
    );

    const saved = await testDb().select().from(items).where(eq(items.userId, userId));
    expect(saved.map((item) => item.text)).toEqual(['Купить хлеб']);
  });
});

describe('слова к самому боту: помощь и отмена последнего (21.09.2026)', () => {
  const say = async (text: string): Promise<{ all: string[]; calls: number }> => {
    const prompts = await seedPrompts();
    await queuedBatchOf([{ kind: 'text', text, offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    const llm = echoingLlm();
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, sender, llm }),
      },
      userId,
    );
    return { all, calls: llm.callCount };
  };

  it('«что ты умеешь?» — текст помощи из меню, модель не зовётся, записей нет', async () => {
    const { all, calls } = await say('что ты умеешь?');

    expect(all.at(-1)).toBe(defaultTexts.menu.help);
    expect(calls).toBe(0);
    expect(await testDb().select().from(items).where(eq(items.userId, userId))).toHaveLength(0);
  });

  it('«отмени последнее» после правки — откат, как кнопкой «Отменить»', async () => {
    const [item] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Отвести дочку к врачу',
        type: 'TASK',
        priority: 'SOON',
        topic: 'семья',
        status: 'new',
        deadlineAt: new Date(T0.getTime() + 24 * 60 * 60_000),
        deadlineAccuracy: 'day',
      })
      .returning();
    // Правка была: срок перенесли; ревизия — как её пишет резолвер.
    const moved = { ...item!, deadlineAt: new Date(T0.getTime() + 4 * 24 * 60 * 60_000) };
    await testDb()
      .update(items)
      .set({ deadlineAt: moved.deadlineAt })
      .where(eq(items.id, item!.id));
    await recordRevision(testDb(), {
      itemId: item!.id,
      userId,
      changedBy: 'resolver',
      before: item!,
      after: moved,
    });

    const { all, calls } = await say('отмени последнее');

    expect(all.at(-1)).toBe(defaultTexts.resolver.undoneOf('Отвести дочку к врачу'));
    expect(calls).toBe(0);
    const [after] = await testDb().select().from(items).where(eq(items.id, item!.id));
    expect(after?.deadlineAt?.toISOString()).toBe(item!.deadlineAt!.toISOString());
  });

  it('«отмени последнее» после выгрузки — последнее это записи, и бот говорит, как их убрать', async () => {
    // Выгрузка с записью — последнее, что было; старая правка её старше.
    const [older] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Старое дело',
        type: 'TASK',
        priority: 'SOON',
        topic: 'дом',
        status: 'new',
      })
      .returning();
    const revision = await recordRevision(testDb(), {
      itemId: older!.id,
      userId,
      changedBy: 'resolver',
      before: older!,
      after: { ...older!, text: 'Старое дело, поправленное' },
    });
    // Часы проверки стоят на T0, а база пишет своё «сейчас»: правка — за
    // час до выгрузки, как и было бы на самом деле.
    await testDb()
      .update(itemRevisions)
      .set({ createdAt: new Date(T0.getTime() - 3_600_000) })
      .where(eq(itemRevisions.id, revision.id));
    await say('надо купить хлеб');

    const { all } = await say('верни как было');

    expect(all.at(-1)).toBe(defaultTexts.resolver.undoIsRecords);
  });

  it('вопросы между правкой и «отмени» не считаются: сравнивается с последней записью, а не с последним сообщением', async () => {
    /**
     * Бой 21.09.2026: Никита поправил дело 18.09, потом три дня только
     * спрашивал («что на 3 дня», «что ты умеешь») — и на «отмени последнее»
     * услышал «последнее — новые записи», хотя записей после правки не
     * было. Последнее — это правка или запись, а не любое сообщение.
     */
    const [item] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Сверить кассу',
        type: 'TASK',
        priority: 'SOON',
        topic: 'деньги',
        status: 'new',
      })
      .returning();
    const renamed = { ...item!, text: 'Сверить кассу и отчёт' };
    await testDb().update(items).set({ text: renamed.text }).where(eq(items.id, item!.id));
    const revision = await recordRevision(testDb(), {
      itemId: item!.id,
      userId,
      changedBy: 'user',
      before: item!,
      after: renamed,
    });
    await testDb()
      .update(itemRevisions)
      .set({ createdAt: new Date(T0.getTime() - 3_600_000) })
      .where(eq(itemRevisions.id, revision.id));
    // Вопрос между правкой и отменой — записей не создаёт.
    await say('что у меня на 3 дня');

    const { all } = await say('отмени последнее');

    expect(all.at(-1)).toBe(defaultTexts.resolver.undoneOf('Сверить кассу'));
  });

  it('отменять нечего — так и сказано', async () => {
    const { all } = await say('отмени последнее');

    expect(all.at(-1)).toBe(defaultTexts.resolver.nothingToUndo);
  });
});

describe('живая строка поверх ответа (слой A, 22.09.2026)', () => {
  /**
   * Заказчица 21.09.2026: «бот не живой, шаблонный… чтобы помнил из
   * контекста, что это за женщина». Ответ по-прежнему собирает код; модель
   * пишет одну-две фразы поверх — из фактов, которые ей дал код. Здесь
   * проверяется связка: факты доходят, строка встаёт второй, выключатель
   * и страж работают, отказ модели ответа не ломает.
   */
  async function livePrompts(): Promise<PromptRegistry> {
    const prompts = await seedPrompts();
    // Вторая версия презентера — со своей схемой; первая осталась в базе.
    await seedPrompt(testDb(), {
      stage: 'presenter',
      version: 'presenter@live',
      prompt: MARKERS.presenter,
      schemaName: PRESENTER_V2_SCHEMA_NAME,
    });
    await activatePrompt(testDb(), 'presenter', 'presenter@live');
    return prompts;
  }

  async function dumpWith(
    llm: MockLlmProvider,
    prompts: PromptRegistry,
  ): Promise<{ reply: string; presenterInputs: string[] }> {
    await queuedBatchOf([
      { kind: 'text', text: 'записаться к стоматологу', offsetMs: 0 },
      { kind: 'text', text: 'купить хлеб', offsetMs: 1_000 },
    ]);
    const { sender, all } = recordingSender();

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({ speech: new MockSpeechProvider(), prompts, llm, sender }),
      },
      userId,
    );

    return {
      reply: all.at(-1) ?? '',
      presenterInputs: llm.requests
        .filter((request) => stageOf(request) === 'presenter')
        .map((request) => request.input),
    };
  }

  it('факты о ней уходят модели, строка встаёт второй под признанием', async () => {
    const prompts = await livePrompts();
    // Выгрузка первая — строка о первой выгрузке (пример промпта). Прежняя
    // «Стоматолога помню — запись одна, срок обновила» не прошла бы сито
    // (25.09.2026): стоматолог записан только что, и срок никто не обновлял.
    const firstLine = 'Первый раз — дальше можно просто скидывать сюда, как приходит в голову.';
    const llm = echoingLlm({ presenter: JSON.stringify({ line: firstLine }) });

    const { reply, presenterInputs } = await dumpWith(llm, prompts);

    expect(reply.split(String.fromCharCode(10)).slice(0, 2)).toEqual([
      'Всё, забрала. Записала 2 дела и разложила по местам.',
      firstLine,
    ]);
    expect(presenterInputs).toHaveLength(1);
    expect(presenterInputs[0]).toContain('Имя: Аня');
    expect(presenterInputs[0]).toContain('Записано сейчас:');
    expect(presenterInputs[0]).toContain('— записаться к стоматологу (личное)');
    expect(presenterInputs[0]).toContain('Первая выгрузка');
  });

  it('выключатель в панели: 0 — модель не зовётся, ответ как прежде', async () => {
    const prompts = await livePrompts();
    await putSetting(testDb(), { name: 'contextLine', value: '0' });
    const llm = echoingLlm({ presenter: JSON.stringify({ line: 'Стоматолога помню.' }) });

    const { reply, presenterInputs } = await dumpWith(llm, prompts);

    expect(presenterInputs).toHaveLength(0);
    expect(reply.split(String.fromCharCode(10))[1]).toBe('');
  });

  it('строка не прошла стража — ответ как прежде, без неё', async () => {
    const prompts = await livePrompts();
    const llm = echoingLlm({
      presenter: JSON.stringify({ line: 'Не переживай, всё будет хорошо.' }),
    });

    const { reply, presenterInputs } = await dumpWith(llm, prompts);

    // Вторая попытка (25.09.2026): та же выгрузка, ей сказано, что не
    // подошло; заглушка отвечает так же — строки нет, ответ как прежде.
    expect(presenterInputs).toHaveLength(2);
    expect(presenterInputs[1]).toContain('Строка «Не переживай, всё будет хорошо.» не подошла');
    expect(reply).not.toContain('Не переживай');
    expect(reply.split(String.fromCharCode(10))[1]).toBe('');
  });

  it('модель не ответила — разбор и ответ целы', async () => {
    const prompts = await livePrompts();
    const llm = echoingLlm({
      presenter: () => {
        throw new Error('модель недоступна');
      },
    });

    const { reply } = await dumpWith(llm, prompts);

    expect(reply).toContain('Записала 2 дела');
    expect(reply).toContain(defaultTexts.answer.keepOrPick);
  });

  it('о ком сказала строка — три дня не повод: во второй выгрузке подряд факты без него (хвост слоя A)', async () => {
    const prompts = await livePrompts();
    // Прежнее дело с прошедшим сроком — повод для строки.
    const classified = { type: 'TASK', priority: 'SOON', topic: 'работа' } as const;
    const [report] = await testDb()
      .insert(items)
      .values({
        userId,
        ...classified,
        text: 'Сдать отчёт',
        deadlineAt: new Date(at(60_000).getTime() - 5 * 24 * 60 * 60_000),
        deadlineAccuracy: 'day',
      })
      .returning({ id: items.id });
    const llm = echoingLlm({
      presenter: JSON.stringify({ line: 'Про отчёт помню — запись никуда не делась.' }),
    });

    const first = await dumpWith(llm, prompts);
    expect(first.presenterInputs[0]).toContain('Срок прошёл: Сдать отчёт');
    expect(first.reply).toContain('Про отчёт помню');

    const [marked] = await testDb()
      .select({ at: items.lineMentionedAt })
      .from(items)
      .where(eq(items.id, report?.id ?? ''));
    expect(marked?.at).not.toBeNull();

    const second = await dumpWith(llm, prompts);
    // Запросы копятся в одной заглушке. Отчёт на паузе, прошлая выгрузка
    // сегодня — повода нет, и модель за строкой не зовётся вовсе (проверка
    // Никиты 24.09.2026). Без паузы отчёт снова стал бы поводом, и второй
    // запрос был бы.
    expect(second.presenterInputs).toHaveLength(1);
    expect(second.reply).not.toContain('Про отчёт помню');
  });

  it('активен презентер первой версии — модель за строкой не зовётся', async () => {
    // Между выкладкой кода и заливкой промпта: платить за чужую схему нельзя.
    const prompts = await seedPrompts();
    const llm = echoingLlm({ presenter: JSON.stringify({ line: 'Стоматолога помню.' }) });

    const { reply, presenterInputs } = await dumpWith(llm, prompts);

    expect(presenterInputs).toHaveLength(0);
    expect(reply).toContain('Записала 2 дела');
  });
});

describe('живой ответ на вопрос о делах (слой B, 22.09.2026)', () => {
  /**
   * §13.4 ТЗ: на «что там с…» — прозой, не списком. Записи находит код,
   * модель говорит о найденном; страж и выключатель — как у строки.
   */
  async function answeringPrompts(): Promise<PromptRegistry> {
    const prompts = await seedPrompts();
    await seedPrompt(testDb(), {
      stage: 'answerer',
      version: 'answerer@test',
      prompt: MARKERS.answerer,
      schemaName: ANSWERER_SCHEMA_NAME,
    });
    await activatePrompt(testDb(), 'answerer', 'answerer@test');
    return prompts;
  }

  async function ask(
    question: string,
    llm: MockLlmProvider,
    prompts: PromptRegistry,
    embedder: MockEmbeddingProvider = new MockEmbeddingProvider(),
  ): Promise<{ replies: string[]; answererInputs: string[] }> {
    await queuedBatchOf([{ kind: 'text', text: question, offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm,
          sender,
          embedder,
        }),
      },
      userId,
    );
    return {
      replies: all,
      answererInputs: llm.requests
        .filter((request) => stageOf(request) === 'answerer')
        .map((request) => request.input),
    };
  }

  /** Один и тот же вектор на любой текст: похожесть 1, поиск находит. */
  const oneVector = Array.from({ length: 256 }, (_, index) => (index === 0 ? 1 : 0));

  const routerQuery = (text: string): string =>
    JSON.stringify({ crisis: false, segments: [{ intent: 'QUERY', text }] });

  it('ничего не найдено — модель отвечает по обзору дел, а не «ничего не записано»', async () => {
    const prompts = await answeringPrompts();
    await testDb()
      .insert(items)
      .values({
        userId,
        type: 'TASK',
        priority: 'SOON',
        topic: 'работа',
        text: 'Сдать отчёт',
        deadlineAt: at(60_000),
        deadlineAccuracy: 'day',
        deadlineTime: 21 * 60,
      });
    const llm = echoingLlm({
      router: routerQuery('как всё успеть'),
      answerer: JSON.stringify({
        answer: 'На сегодня у тебя один отчёт к 21:00 — остальное подождёт.',
      }),
    });

    const { replies, answererInputs } = await ask('как всё успеть', llm, prompts);

    expect(answererInputs).toHaveLength(1);
    expect(answererInputs[0]).toContain('Вопрос: как всё успеть');
    expect(answererInputs[0]).toContain('На сегодня: Сдать отчёт в 21:00');
    expect(replies.at(-1)).toBe('На сегодня у тебя один отчёт к 21:00 — остальное подождёт.');
  });

  it('проза про одну-две записи идёт без списка под ней (бой 22.09.2026)', async () => {
    // На бою «Что там со стоматологом?» получило прозу и следом строку
    // «— Записаться к стоматологу»: то же самое дважды.
    const prompts = await answeringPrompts();
    const classified = { type: 'TASK', priority: 'SOON', topic: 'здоровье' } as const;
    // С вектором: поиск по смыслу ищет по нему, а не по словам.
    await testDb()
      .insert(items)
      .values({ userId, ...classified, text: 'Записаться к стоматологу', embedding: oneVector });
    const llm = echoingLlm({
      router: routerQuery('что там со стоматологом'),
      answerer: JSON.stringify({
        answer: 'Ты хотела записаться к стоматологу — запись всё ещё открыта.',
      }),
    });

    // Один вектор на всё: поиск по смыслу находит запись, и ветка — «about».
    const same = new MockEmbeddingProvider({ vectorFor: () => oneVector });
    const { replies, answererInputs } = await ask('что там со стоматологом', llm, prompts, same);

    // Ветка именно «нашлось»: иначе проверка мерила бы другой путь.
    expect(answererInputs[0]).toContain('Найдено по вопросу:');
    expect(replies.at(-1)).toBe('Ты хотела записаться к стоматологу — запись всё ещё открыта.');
  });

  it('ответ не прошёл стража или пуст — словарный ответ, как раньше', async () => {
    const prompts = await answeringPrompts();
    const llm = echoingLlm({
      router: routerQuery('что там с котом'),
      answerer: JSON.stringify({ answer: 'Не переживай, всё будет хорошо.' }),
    });

    const { replies } = await ask('что там с котом', llm, prompts);

    expect(replies.at(-1)).toBe(defaultTexts.backlog.nothing);
  });

  it('выключатель в панели: 0 — модель не зовётся', async () => {
    const prompts = await answeringPrompts();
    await putSetting(testDb(), { name: 'liveAnswers', value: '0' });
    const llm = echoingLlm({
      router: routerQuery('что там с котом'),
      answerer: JSON.stringify({ answer: 'Про кота у тебя ничего нет.' }),
    });

    const { replies, answererInputs } = await ask('что там с котом', llm, prompts);

    expect(answererInputs).toHaveLength(0);
    expect(replies.at(-1)).toBe(defaultTexts.backlog.nothing);
  });

  it('без промпта ответа (первая выкладка кода) — модель не зовётся, ответ словарный', async () => {
    const prompts = await seedPrompts();
    const llm = echoingLlm({
      router: routerQuery('что там с котом'),
      answerer: JSON.stringify({ answer: 'что-то' }),
    });

    const { replies, answererInputs } = await ask('что там с котом', llm, prompts);

    expect(answererInputs).toHaveLength(0);
    expect(replies.at(-1)).toBe(defaultTexts.backlog.nothing);
  });
});

describe('сказать нечего — последняя попытка моделью (22.09.2026)', () => {
  /**
   * Заказчица 21.09: «Напиши мне все, что накопилось» → «Я здесь.
   * Расскажешь, что в голове?». Слово добавили в рамку вопроса в тот же
   * вечер, но так чинится по одной фразе. Общий слой: когда разбирать
   * нечего и отвечать нечем, спрашиваем модель по обзору дел — она же
   * отвечает на вопросы (слой B). Не про дела — пустая строка, и реплика
   * словаря остаётся.
   */
  async function answeringPrompts(): Promise<PromptRegistry> {
    const prompts = await seedPrompts();
    await seedPrompt(testDb(), {
      stage: 'answerer',
      version: 'answerer@test',
      prompt: MARKERS.answerer,
      schemaName: ANSWERER_SCHEMA_NAME,
    });
    await activatePrompt(testDb(), 'answerer', 'answerer@test');
    return prompts;
  }

  async function say(
    text: string,
    llm: MockLlmProvider,
    prompts: PromptRegistry,
  ): Promise<{ replies: string[]; inputs: string[] }> {
    await queuedBatchOf([{ kind: 'text', text, offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          llm,
          sender,
          embedder: new MockEmbeddingProvider(),
        }),
      },
      userId,
    );
    return {
      replies: all,
      inputs: llm.requests
        .filter((request) => stageOf(request) === 'answerer')
        .map((request) => request.input),
    };
  }

  const smalltalk = (text: string): string =>
    JSON.stringify({ crisis: false, segments: [{ intent: 'SMALLTALK', text }] });

  async function withOpenItem(): Promise<void> {
    await testDb()
      .insert(items)
      .values({
        userId,
        type: 'TASK',
        priority: 'SOON',
        topic: 'дом',
        text: 'Пересадить цветы',
        deadlineAt: at(60_000),
        deadlineAccuracy: 'day',
      });
  }

  it('«напиши мне всё, что накопилось» — ответ по делам вместо «Я здесь»', async () => {
    const prompts = await answeringPrompts();
    await withOpenItem();
    const llm = echoingLlm({
      router: smalltalk('Напиши мне все, что накопилось'),
      extractor: JSON.stringify({ units: [] }),
      answerer: JSON.stringify({ answer: 'На сегодня у тебя одно дело: пересадить цветы.' }),
    });

    const { replies, inputs } = await say('Напиши мне все, что накопилось', llm, prompts);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('Вопрос: Напиши мне все, что накопилось');
    expect(replies.at(-1)).toBe('На сегодня у тебя одно дело: пересадить цветы.');
  });

  it('модель молчит (не про дела) — прежняя реплика словаря', async () => {
    const prompts = await answeringPrompts();
    await withOpenItem();
    const llm = echoingLlm({
      router: smalltalk('ну вот'),
      extractor: JSON.stringify({ units: [] }),
      answerer: JSON.stringify({ answer: '' }),
    });

    const { replies } = await say('ну вот', llm, prompts);

    expect(replies.at(-1)).toBe(defaultTexts.answer.nothingToParse);
  });

  it('«спасибо» и состояние моделью не переспрашиваются', async () => {
    const prompts = await answeringPrompts();
    await withOpenItem();
    const llm = echoingLlm({
      router: smalltalk('спасибо'),
      extractor: JSON.stringify({ units: [] }),
      answerer: JSON.stringify({ answer: 'что-то про дела' }),
    });

    const { replies, inputs } = await say('спасибо', llm, prompts);

    expect(inputs).toHaveLength(0);
    expect(replies.at(-1)).toBe(defaultTexts.answer.thanks);
  });

  it('без открытых дел модель не зовётся: отвечать нечем', async () => {
    const prompts = await answeringPrompts();
    const llm = echoingLlm({
      router: smalltalk('напиши всё'),
      extractor: JSON.stringify({ units: [] }),
      answerer: JSON.stringify({ answer: 'что-то' }),
    });

    const { replies, inputs } = await say('напиши всё', llm, prompts);

    expect(inputs).toHaveLength(0);
    expect(replies.at(-1)).toBe(defaultTexts.answer.nothingToParse);
  });
});

/**
 * Вариант Б (решение Никиты 24.09.2026). Живая проверка: «надо будет
 * поехать за ребёнком в 4 часа» записалось без часа — у четырёх два
 * чтения, — а в названии осталось «в 4 часа», и казалось, что бот
 * напомнит к четырём. Теперь голый час с 1 до 6 — день, а с 7 до 11 бот
 * спрашивает сразу при записи и помнит вопрос четверть часа.
 */
describe('час нового дела — утро или вечер (вариант Б, 24.09.2026)', () => {
  const resolverPicksFirst = JSON.stringify({
    action: 'update',
    mode: 'replace',
    itemId: '1',
    confidence: 1,
    changes: {
      note: '',
      text: '',
      deadline: '',
      deadlineAccuracy: 'none',
      recurrenceKind: 'none',
      recurrenceInterval: 0,
      recurrenceText: '',
    },
    reason: 'час по переспросу',
  });

  /**
   * Модель резолвера, как на бою 24.09.2026 в 19:01: не уверена и просит
   * подтвердить. Ответ на переспрос о часе до неё доходить не должен.
   */
  const unsureResolver = (calls: string[]) => (request: { readonly input: string }) => {
    calls.push(request.input);
    return JSON.stringify({
      action: 'update',
      mode: 'replace',
      itemId: '1',
      confidence: 0.6,
      changes: {
        note: '',
        text: '',
        deadline: '',
        deadlineAccuracy: 'none',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
      },
      reason: 'не уверена',
    });
  };

  const tomorrowDump = (spoken: string, title: string, topic = 'семья') =>
    echoingLlm({
      router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: spoken }] }),
      extractor: () =>
        JSON.stringify({ units: [{ text: title, isProject: false, isEmotion: false }] }),
      classifier: () =>
        JSON.stringify({
          items: [
            {
              text: title,
              type: 'TASK',
              priority: 'SOON',
              topic,
              isProject: false,
              deadline: tomorrowIso(),
              deadlineAccuracy: 'day',
              deadlineText: 'завтра',
              recurrenceKind: 'none',
              recurrenceInterval: 0,
              recurrenceText: '',
            },
          ],
        }),
      resolver: resolverPicksFirst,
    });

  async function liveItems(): Promise<(typeof items.$inferSelect)[]> {
    return await testDb()
      .select()
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.isDraft, false)));
  }

  it('«Завтра поехать за ребёнком в 4 часа» — 16:00 без вопроса, в названии часа нет', async () => {
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();
    const spoken = 'Завтра надо будет поехать за ребёнком в 4 часа.';

    await queuedBatchOf([{ kind: 'text', text: spoken, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: tomorrowDump(spoken, 'Поехать за ребёнком в 4 часа'),
        }),
      },
      userId,
    );

    const rows = await liveItems();
    expect(rows.map((row) => [row.text, row.deadlineTime])).toEqual([
      ['Поехать за ребёнком', 16 * 60],
    ]);
    expect(all.some((text) => text.includes('Во сколько'))).toBe(false);
  });

  it('«Завтра забрать ребёнка в 7» — вопрос сразу при записи; «Вечером» ставит 19:00, второго дела нет', async () => {
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();
    const spoken = 'Завтра забрать ребёнка в 7.';

    await queuedBatchOf([{ kind: 'text', text: spoken, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: tomorrowDump(spoken, 'Забрать ребёнка в 7'),
        }),
      },
      userId,
    );

    const [saved] = await liveItems();
    expect(saved?.deadlineTime).toBeNull();
    const asked = all.filter((text) =>
      text.includes('Во сколько «Забрать ребёнка» — 07:00 или 19:00?'),
    );
    expect(asked).toHaveLength(1);
    // Один вопрос на обмен (§13.9): свой вопрос разбора уступает.
    expect(asked[0]).toContain('Записала');
    expect(asked[0]).not.toContain('выбрать главное?');

    const resolverCalls: string[] = [];
    await queuedBatchOf([{ kind: 'text', text: 'Вечером', offsetMs: 60_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          now: at(2 * 60_000),
          llm: echoingLlm({ resolver: unsureResolver(resolverCalls) }),
        }),
      },
      userId,
    );
    // Бот спросил про это дело сам — модель не зовётся, «Перенести?» нет.
    expect(resolverCalls).toEqual([]);
    expect(all.some((text) => text.startsWith('Перенести «'))).toBe(false);

    const rows = await liveItems();
    expect(rows.map((row) => [row.id, row.deadlineTime])).toEqual([[saved?.id, 19 * 60]]);
    expect(all.some((text) => text.includes('19:00'))).toBe(true);
  });

  it('повтор дела с «в 7» — вопрос помнится: «Вечером» ставит 19:00 у прежнего дела', async () => {
    const prompts = await seedPrompts();
    const [child] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Забрать ребёнка',
        type: 'TASK',
        priority: 'SOON',
        topic: 'семья',
        deadlineAt: new Date(`${tomorrowIso()}T00:00:00.000Z`),
        deadlineAccuracy: 'day',
        updatedAt: at(-40 * 60_000),
      })
      .returning({ id: items.id });
    const { sender, all } = recordingSender();
    const spoken = 'Забрать ребёнка в 7.';

    await queuedBatchOf([{ kind: 'text', text: spoken, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: tomorrowDump(spoken, 'Забрать ребёнка'),
        }),
      },
      userId,
    );
    expect(all.some((text) => text.includes('07:00 или 19:00'))).toBe(true);

    const resolverCalls: string[] = [];
    await queuedBatchOf([{ kind: 'text', text: 'Вечером', offsetMs: 60_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          now: at(2 * 60_000),
          llm: echoingLlm({ resolver: unsureResolver(resolverCalls) }),
        }),
      },
      userId,
    );
    // Бот спросил про это дело сам — модель не зовётся, «Перенести?» нет.
    expect(resolverCalls).toEqual([]);
    expect(all.some((text) => text.startsWith('Перенести «'))).toBe(false);

    const rows = await liveItems();
    expect(rows.map((row) => [row.id, row.deadlineTime])).toEqual([[child?.id, 19 * 60]]);
  });

  /**
   * Проверка Никиты 24.09.2026, 19:00: поездка за ребёнком на завтра уже
   * была записана («Поехать за ребёнком в 4 часа», без часа), а «Завтра
   * поехать за ребёнком в 4 часа» завело второе дело — модель оставила в
   * заголовке «завтра», и повтор не узнался. Это перенос: час — старому.
   */
  it('«Завтра поехать за ребёнком в 4 часа» при записанной поездке — час старому делу, второго нет', async () => {
    const prompts = await seedPrompts();
    const [trip] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Поехать за ребёнком в 4 часа',
        type: 'TASK',
        priority: 'SOON',
        topic: 'семья',
        deadlineAt: new Date(`${tomorrowIso()}T00:00:00.000Z`),
        deadlineAccuracy: 'day',
        updatedAt: at(-2 * 60 * 60_000),
      })
      .returning({ id: items.id });
    const { sender, all } = recordingSender();
    const spoken = 'Завтра надо будет поехать за ребёнком в 4 часа.';

    await queuedBatchOf([{ kind: 'text', text: spoken, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: tomorrowDump(spoken, 'Поехать за ребёнком завтра'),
        }),
      },
      userId,
    );

    const rows = await liveItems();
    expect(rows.map((row) => [row.id, row.deadlineTime])).toEqual([[trip?.id, 16 * 60]]);
    expect(all.some((text) => text.includes('16:00'))).toBe(true);
    expect(all.some((text) => text.includes('Записала 1 дело'))).toBe(false);
  });

  /**
   * Проверка Никиты 24.09.2026, 19:46: «Послезавтра забрать ребенка в 8» при
   * записанном «Забрать ребенка в 7» без часа — «Перенесла «Забрать ребенка
   * в 7» на 26.09.», про час ни слова; вопрос пришёл только на повтор.
   */
  it('повтор с новым днём и «в 8» — перенос и вопрос о часе в одном ответе; «вечером» ставит 20:00', async () => {
    const prompts = await seedPrompts();
    const [child] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Забрать ребенка в 7',
        type: 'TASK',
        priority: 'SOON',
        topic: 'семья',
        deadlineAt: new Date(`${tomorrowIso()}T00:00:00.000Z`),
        deadlineAccuracy: 'day',
        updatedAt: at(-2 * 60 * 60_000),
      })
      .returning({ id: items.id });
    const afterTomorrow = new Date(`${tomorrowIso()}T12:00:00.000Z`);
    afterTomorrow.setUTCDate(afterTomorrow.getUTCDate() + 1);
    const dayAfter = afterTomorrow.toISOString().slice(0, 10);
    const { sender, all } = recordingSender();
    const spoken = 'Послезавтра забрать ребенка в 8.';

    await queuedBatchOf([{ kind: 'text', text: spoken, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: spoken }] }),
            extractor: () =>
              JSON.stringify({
                units: [{ text: 'Забрать ребенка в 8', isProject: false, isEmotion: false }],
              }),
            classifier: () =>
              JSON.stringify({
                items: [
                  {
                    text: 'Забрать ребенка в 8',
                    type: 'TASK',
                    priority: 'SOON',
                    topic: 'семья',
                    isProject: false,
                    deadline: dayAfter,
                    deadlineAccuracy: 'day',
                    deadlineText: 'послезавтра',
                    recurrenceKind: 'none',
                    recurrenceInterval: 0,
                    recurrenceText: '',
                  },
                ],
              }),
          }),
        }),
      },
      userId,
    );

    const moved = all.find((text) => text.includes('Перенесла'));
    expect(moved).toBeDefined();
    expect(moved).toContain('Во сколько «Забрать ребенка» — 08:00 или 20:00?');
    // Ближний день — словом, а не «26.09» (проверка Никиты 24.09.2026).
    expect(moved).toContain('на послезавтра');

    const resolverCalls: string[] = [];
    await queuedBatchOf([{ kind: 'text', text: 'вечером', offsetMs: 60_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          now: at(2 * 60_000),
          llm: echoingLlm({ resolver: unsureResolver(resolverCalls) }),
        }),
      },
      userId,
    );

    expect(resolverCalls).toEqual([]);
    const rows = await liveItems();
    expect(rows.map((row) => [row.id, row.text, row.deadlineTime])).toEqual([
      [child?.id, 'Забрать ребенка', 20 * 60],
    ]);
  });

  it('правка «перенеси ребёнка на послезавтра в 8» — перенос и вопрос о часе в одном ответе', async () => {
    const prompts = await seedPrompts();
    await testDb()
      .insert(items)
      .values({
        userId,
        // День в заголовке — как оставляет модель: в вопросе его быть не должно.
        text: 'Забрать ребенка завтра',
        type: 'TASK',
        priority: 'SOON',
        topic: 'семья',
        deadlineAt: new Date(`${tomorrowIso()}T00:00:00.000Z`),
        deadlineAccuracy: 'day',
        updatedAt: at(-2 * 60 * 60_000),
      });
    const afterTomorrow = new Date(`${tomorrowIso()}T12:00:00.000Z`);
    afterTomorrow.setUTCDate(afterTomorrow.getUTCDate() + 1);
    const { sender, all } = recordingSender();
    const text = 'перенеси ребёнка на послезавтра в 8';

    await queuedBatchOf([{ kind: 'text', text, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({ crisis: false, segments: [{ intent: 'PATCH', text }] }),
            resolver: JSON.stringify({
              action: 'update',
              mode: 'replace',
              itemId: '1',
              confidence: 0.95,
              changes: {
                note: '',
                text: '',
                deadline: afterTomorrow.toISOString().slice(0, 10),
                deadlineAccuracy: 'day',
                recurrenceKind: 'none',
                recurrenceInterval: 0,
                recurrenceText: '',
              },
              reason: 'перенос',
            }),
          }),
        }),
      },
      userId,
    );

    const moved = all.find((line) => line.includes('Перенесла'));
    expect(moved).toBeDefined();
    expect(moved).toContain('Во сколько «Забрать ребенка» — 08:00 или 20:00?');
  });

  /**
   * Проверка Никиты 24.09.2026, 21:36: модель оставила день в заголовке, и
   * вопрос вышел «Во сколько «Встретить курьера послезавтра» — …». В
   * списках и в «Напомню про …» день уже срезается — в вопросе тоже.
   */
  it('в вопросе о часе название без дня: «Встретить курьера», а не «… послезавтра»', async () => {
    const prompts = await seedPrompts();
    const { sender, all } = recordingSender();
    const spoken = 'Послезавтра встретить курьера в 9.';
    const afterTomorrow = new Date(`${tomorrowIso()}T12:00:00.000Z`);
    afterTomorrow.setUTCDate(afterTomorrow.getUTCDate() + 1);

    await queuedBatchOf([{ kind: 'text', text: spoken, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: spoken }] }),
            extractor: () =>
              JSON.stringify({
                units: [
                  { text: 'Встретить курьера послезавтра', isProject: false, isEmotion: false },
                ],
              }),
            classifier: () =>
              JSON.stringify({
                items: [
                  {
                    text: 'Встретить курьера послезавтра',
                    type: 'TASK',
                    priority: 'SOON',
                    topic: 'дом',
                    isProject: false,
                    deadline: afterTomorrow.toISOString().slice(0, 10),
                    deadlineAccuracy: 'day',
                    deadlineText: 'послезавтра',
                    recurrenceKind: 'none',
                    recurrenceInterval: 0,
                    recurrenceText: '',
                  },
                ],
              }),
          }),
        }),
      },
      userId,
    );

    expect(
      all.some((text) => text.includes('Во сколько «Встретить курьера» — 09:00 или 21:00?')),
    ).toBe(true);

    await queuedBatchOf([{ kind: 'text', text: 'Вечерком', offsetMs: 60_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          now: at(2 * 60_000),
          llm: echoingLlm(),
        }),
      },
      userId,
    );
    const rows = await liveItems();
    expect(rows.map((row) => row.deadlineTime)).toEqual([21 * 60]);
  });

  it('«вечерком» на «Во сколько … 07:00 или 19:00?» — 19:00 без модели (разговорный ответ, 24.09.2026)', async () => {
    const prompts = await seedPrompts();
    const { sender } = recordingSender();
    const spoken = 'Завтра забрать ребёнка в 7.';

    await queuedBatchOf([{ kind: 'text', text: spoken, offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: tomorrowDump(spoken, 'Забрать ребёнка в 7'),
        }),
      },
      userId,
    );

    const resolverCalls: string[] = [];
    await queuedBatchOf([{ kind: 'text', text: 'Ну давай вечерком', offsetMs: 60_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          now: at(2 * 60_000),
          llm: echoingLlm({ resolver: unsureResolver(resolverCalls) }),
        }),
      },
      userId,
    );

    expect(resolverCalls).toEqual([]);
    const rows = await liveItems();
    expect(rows.map((row) => row.deadlineTime)).toEqual([19 * 60]);
  });

  it('перенос «на пол 12» у дела без часа — «Не поняла, 11:30 или 23:30?»; «вечером» ставит 23:30 без модели', async () => {
    const prompts = await seedPrompts();
    const [parcel] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Забрать посылку',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
        deadlineAt: new Date(`${tomorrowIso()}T00:00:00.000Z`),
        deadlineAccuracy: 'day',
        updatedAt: at(-2 * 60 * 60_000),
      })
      .returning({ id: items.id });
    const { sender, all } = recordingSender();

    await queuedBatchOf([{ kind: 'text', text: 'перенеси посылку на пол 12', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: JSON.stringify({
              crisis: false,
              segments: [{ intent: 'PATCH', text: 'перенеси посылку на пол 12' }],
            }),
            resolver: resolverPicksFirst,
          }),
        }),
      },
      userId,
    );
    expect(all.some((text) => text.includes('Не поняла, 11:30 или 23:30?'))).toBe(true);

    const resolverCalls: string[] = [];
    await queuedBatchOf([{ kind: 'text', text: 'вечером', offsetMs: 60_000 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          now: at(2 * 60_000),
          llm: echoingLlm({ resolver: unsureResolver(resolverCalls) }),
        }),
      },
      userId,
    );

    expect(resolverCalls).toEqual([]);
    const rows = await liveItems();
    expect(rows.map((row) => [row.id, row.deadlineTime])).toEqual([[parcel?.id, 23 * 60 + 30]]);
  });
});

/**
 * «Напомнишь?» сразу после записи (живая проверка Никиты 24.09.2026,
 * 17:03): вопрос уходил модели ответов, и та пересказала день, назвав
 * открытые дела сделанными. Про одно дело и про напоминание отвечает код —
 * по плану планировщика, без модели.
 */
describe('«Напомнишь?» о только что обсуждённом деле (24.09.2026)', () => {
  async function discussed(text: string): Promise<string> {
    const [row] = await testDb()
      .insert(items)
      .values({
        userId,
        text,
        type: 'TASK',
        priority: 'SOON',
        topic: 'семья',
        deadlineAt: new Date(`${tomorrowIso()}T00:00:00.000Z`),
        deadlineAccuracy: 'day',
        updatedAt: at(-40 * 60_000),
      })
      .returning({ id: items.id });
    await testDb()
      .insert(batches)
      .values({
        userId,
        status: 'done',
        openedAt: at(-3 * 60_000),
        closedAt: at(-2 * 60_000),
        mentionedItemIds: [row!.id],
      });
    return row!.id;
  }

  it('после записи «Поехать за ребёнком» — когда напомню, словами кода; модель не зовётся', async () => {
    const prompts = await seedPrompts();
    await discussed('Поехать за ребёнком');
    const { sender, all } = recordingSender();
    const stages: string[] = [];
    const counting = (stage: string) => () => {
      stages.push(stage);
      return '{}';
    };

    await queuedBatchOf([{ kind: 'text', text: 'Напомнишь ?', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: counting('router'),
            answerer: counting('answerer'),
          }),
        }),
      },
      userId,
    );

    expect(stages).toEqual([]);
    const reply = all.find((text) => text.startsWith('Да, напомню про «Поехать за ребёнком»'));
    expect(reply).toBeDefined();
    expect(reply).toContain('завтра в');
    // Новой записи «Напомнишь» нет.
    const rows = await testDb()
      .select({ text: items.text })
      .from(items)
      .where(and(eq(items.userId, userId), eq(items.isDraft, false)));
    expect(rows.map((row) => row.text)).toEqual(['Поехать за ребёнком']);
  });

  it('давно ни о чём не говорили — обычный путь, через маршрутизатор', async () => {
    const prompts = await seedPrompts();
    const { sender } = recordingSender();
    const stages: string[] = [];

    await queuedBatchOf([{ kind: 'text', text: 'Напомнишь ?', offsetMs: 0 }]);
    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: handler({
          speech: new MockSpeechProvider(),
          prompts,
          sender,
          llm: echoingLlm({
            router: () => {
              stages.push('router');
              return JSON.stringify({
                crisis: false,
                segments: [{ intent: 'SMALLTALK', text: 'Напомнишь ?' }],
              });
            },
          }),
        }),
      },
      userId,
    );

    expect(stages).toEqual(['router']);
  });
});
