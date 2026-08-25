import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, batches, messagesRaw } from '../../db/schema.js';
import { RedisLock } from '../../infra/lock.js';
import { createRedis } from '../../infra/redis.js';
import { testDb } from '../../test/db.js';
import { attachMessageToBatch, closeBatchOnSilence } from '../buffer/buffer.service.js';
import type { StatusSender } from '../presenter/status.service.js';
import { run } from '../speech/ffmpeg.js';
import { MockSpeechProvider } from '../speech/providers/mock.js';
import { PermanentSpeechError } from '../speech/providers/types.js';
import { upsertUser } from '../users/users.repo.js';
import { processUserBatches } from './pipeline.service.js';
import { createStage1Handler } from './stage1.handler.js';

/**
 * Обработка выгрузки на первом этапе целиком: настоящая база, настоящий
 * ffmpeg, настоящий замок. Подменены только провайдер расшифровки и
 * скачивание из Telegram — живой вызов стоил бы денег и сделал бы
 * тесты недетерминированными.
 *
 * Это и есть проверка того, что модуль speech подключён к потоку
 * сообщений, а не просто существует: до задачи 1.15 склейка выдавала
 * пустую строку на голосовом.
 */

const redis: Redis = createRedis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379', {
  maxReconnectAttempts: 3,
});
const lock = new RedisLock(redis, 'test-stage1:');

const pricing = { mock: { kind: 'audio', currency: 'usd', perMinute: 0.006 } } as const;

const T0 = new Date('2026-08-24T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

let fixtureDir = '';
let audioPath = '';
let userId: string;
let seq = 0;

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'vydoh-stage1-'));
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
  const keys = await redis.keys('test-stage1:*');
  if (keys.length > 0) await redis.del(...keys);

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

describe('createStage1Handler', () => {
  it('расшифровывает голосовые и склеивает их с текстом в порядке получения', async () => {
    // §9.1 правило 2 ТЗ: серия сообщений — это одна мысль.
    const batchId = await queuedBatchOf([
      { kind: 'voice', offsetMs: 0 },
      { kind: 'text', text: 'и ещё забрать вещи', offsetMs: 5_000 },
      { kind: 'voice', offsetMs: 10_000 },
    ]);

    const provider = new MockSpeechProvider({
      responses: ['записать сына к врачу', 'купить продукты'],
    });

    const result = await processUserBatches(
      { db: testDb(), lock, handleBatch: createStage1Handler({ provider, download, pricing }) },
      userId,
    );

    expect(result.processed).toBe(1);
    expect(await combinedTextOf(batchId)).toBe(
      'записать сына к врачу\nи ещё забрать вещи\nкупить продукты',
    );
  });

  it('доводит выгрузку до состояния «готово»', async () => {
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const provider = new MockSpeechProvider({ responses: ['текст'] });

    await processUserBatches(
      { db: testDb(), lock, handleBatch: createStage1Handler({ provider, download, pricing }) },
      userId,
    );

    const [batch] = await testDb().select().from(batches);
    expect(batch?.status).toBe('done');
    expect(batch?.error).toBeNull();
  });

  it('убирает ссылку на аудио: §16 ТЗ запрещает хранить файл после обработки', async () => {
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const provider = new MockSpeechProvider({ responses: ['текст'] });

    await processUserBatches(
      { db: testDb(), lock, handleBatch: createStage1Handler({ provider, download, pricing }) },
      userId,
    );

    const [row] = await testDb().select().from(messagesRaw);
    expect(row?.transcript).toBe('текст');
    expect(row?.fileId).toBeNull();
  });

  it('не расшифровывает заново то, что уже расшифровано', async () => {
    // Повторный заход бывает после сбоя посреди выгрузки, и платить
    // за одну и ту же секунду дважды нельзя — это чужие деньги.
    const batchId = await queuedBatchOf([
      { kind: 'voice', offsetMs: 0, transcript: 'уже расшифровано' },
      { kind: 'voice', offsetMs: 5_000 },
    ]);

    const provider = new MockSpeechProvider({ responses: ['новое'] });

    await processUserBatches(
      { db: testDb(), lock, handleBatch: createStage1Handler({ provider, download, pricing }) },
      userId,
    );

    expect(provider.callCount).toBe(1);
    expect(await combinedTextOf(batchId)).toBe('уже расшифровано\nновое');
  });

  it('не трогает провайдера, если голосовых в выгрузке нет', async () => {
    await queuedBatchOf([{ kind: 'text', text: 'просто текст', offsetMs: 0 }]);
    const provider = new MockSpeechProvider();

    await processUserBatches(
      { db: testDb(), lock, handleBatch: createStage1Handler({ provider, download, pricing }) },
      userId,
    );

    expect(provider.callCount).toBe(0);
  });

  it('пишет расход на каждое голосовое', async () => {
    // §10.5 ТЗ: без этого к концу второго этапа мы не будем знать
    // себестоимость выгрузки.
    const batchId = await queuedBatchOf([
      { kind: 'voice', offsetMs: 0 },
      { kind: 'voice', offsetMs: 5_000 },
    ]);
    const provider = new MockSpeechProvider({ responses: ['раз', 'два'] });

    await processUserBatches(
      { db: testDb(), lock, handleBatch: createStage1Handler({ provider, download, pricing }) },
      userId,
    );

    const calls = await testDb().select().from(aiCalls).orderBy(asc(aiCalls.createdAt));
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.stage === 'speech' && call.ok)).toBe(true);
    expect(calls.every((call) => call.batchId === batchId)).toBe(true);
    expect(calls.every((call) => call.costCurrency === 'usd')).toBe(true);
  });

  it('сбойную выгрузку помечает сбойной, а не теряет', async () => {
    // §9 ТЗ запрещает терять сообщения. Пропустить нерасшифрованное
    // голосовое и склеить остальное было бы тише, но молча съело бы
    // часть сказанного.
    const batchId = await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);

    const provider = new MockSpeechProvider({
      failFirst: { times: 1, error: new PermanentSpeechError('битый файл') },
    });

    await expect(
      processUserBatches(
        { db: testDb(), lock, handleBatch: createStage1Handler({ provider, download, pricing }) },
        userId,
      ),
    ).rejects.toThrow(/битый файл/u);

    const [batch] = await testDb().select().from(batches).where(eq(batches.id, batchId));
    expect(batch?.status).toBe('failed');
    expect(batch?.error).toContain('битый файл');

    // Сообщение осталось на месте вместе со ссылкой на файл: выгрузку
    // можно перезапустить.
    const [row] = await testDb().select().from(messagesRaw);
    expect(row?.fileId).not.toBeNull();

    // Неуспешный вызов тоже записан — прямое требование §10.5 ТЗ.
    const [call] = await testDb().select().from(aiCalls);
    expect(call?.ok).toBe(false);
    expect(call?.error).toContain('битый файл');
  });
});

describe('ответ пользователю', () => {
  /** Считает отправки и правки вместо обращений к Telegram. */
  function recordingSender(): {
    sender: StatusSender;
    sent: string[];
    edited: string[];
    /** Все реплики по порядку: последняя из них и есть ответ человеку. */
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

  it('правит статусное сообщение, а не шлёт новое', async () => {
    // §9.2 ТЗ: одна реплика на выгрузку. Подтверждение приёма уже ушло
    // из обработчика входящих, конвейер только правит его.
    const batchId = await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const { sender, sent, edited } = recordingSender();

    // Сообщение о приёме, как его отправил бы обработчик входящих.
    await testDb()
      .update(batches)
      .set({ statusMessageId: 777, statusUpdatedAt: at(-60_000) })
      .where(eq(batches.id, batchId));

    const provider = new MockSpeechProvider({ responses: ['купить продукты'] });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: createStage1Handler({ provider, download, pricing, sender }),
      },
      userId,
    );

    expect(sent).toEqual([]);
    // Промежуточная реплика на время расшифровки и итоговая с текстом.
    expect(edited).toHaveLength(2);
    expect(edited.at(-1)).toContain('купить продукты');
  });

  it('показывает склеенный текст всей выгрузки, а не последнего сообщения', async () => {
    await queuedBatchOf([
      { kind: 'voice', offsetMs: 0 },
      { kind: 'text', text: 'и ещё забрать вещи', offsetMs: 5_000 },
    ]);
    const { sender, all } = recordingSender();
    const provider = new MockSpeechProvider({ responses: ['записать сына к врачу'] });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: createStage1Handler({ provider, download, pricing, sender }),
      },
      userId,
    );

    const last = all.at(-1) ?? '';
    expect(last).toContain('записать сына к врачу');
    expect(last).toContain('и ещё забрать вещи');
  });

  it('на пустой расшифровке честно говорит, что не разобрала', async () => {
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const { sender, all } = recordingSender();
    const provider = new MockSpeechProvider({ responses: [''] });

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: createStage1Handler({ provider, download, pricing, sender }),
      },
      userId,
    );

    expect(all.at(-1)).toContain('Не разобрала');
  });

  it('несостоявшийся ответ не мешает разбору', async () => {
    // Человек мог заблокировать бота, пока шла расшифровка. Ответ важен,
    // но выгрузка важнее: её терять нельзя из-за недоставленной реплики.
    const batchId = await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const provider = new MockSpeechProvider({ responses: ['текст'] });

    const silentSender: StatusSender = {
      // Ноль означает «отправить не удалось».
      send: () => Promise.resolve(0),
      edit: () => Promise.resolve(),
    };

    await processUserBatches(
      {
        db: testDb(),
        lock,
        handleBatch: createStage1Handler({ provider, download, pricing, sender: silentSender }),
      },
      userId,
    );

    const [batch] = await testDb().select().from(batches).where(eq(batches.id, batchId));
    expect(batch?.status).toBe('done');
    expect(batch?.combinedText).toBe('текст');
    // Несуществующее сообщение не запомнено: следующая попытка отправит заново.
    expect(batch?.statusMessageId).toBeNull();
  });

  it('без отправителя работает молча и не падает', async () => {
    await queuedBatchOf([{ kind: 'voice', offsetMs: 0 }]);
    const provider = new MockSpeechProvider({ responses: ['текст'] });

    await expect(
      processUserBatches(
        { db: testDb(), lock, handleBatch: createStage1Handler({ provider, download, pricing }) },
        userId,
      ),
    ).resolves.toMatchObject({ processed: 1 });
  });
});
