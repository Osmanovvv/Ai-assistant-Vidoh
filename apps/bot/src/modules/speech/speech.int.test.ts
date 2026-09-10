import { SpendCeilingError } from '../../infra/failures.js';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, messagesRaw } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { run } from './ffmpeg.js';
import { MockSpeechProvider } from './providers/mock.js';
import { PermanentSpeechError, TransientSpeechError } from './providers/types.js';
import { transcribeMessage } from './speech.service.js';

/**
 * Расшифровка проверяется целиком: настоящий ffmpeg режет настоящий файл,
 * подменён только провайдер. Живой вызов требовал бы ключа заказчика и
 * делал бы тесты недетерминированными.
 */

const pricing = { mock: { kind: 'audio', currency: 'usd', perMinute: 0.006 } } as const;

let fixtureDir = '';
let shortAudio = '';
let longAudio = '';
let userId: string;
let messageId: string;

async function makeAudio(
  path: string,
  blocks: readonly { readonly kind: 'tone' | 'silence'; readonly sec: number }[],
): Promise<void> {
  const inputs: string[] = [];
  for (const block of blocks) {
    inputs.push(
      '-f',
      'lavfi',
      '-t',
      String(block.sec),
      '-i',
      block.kind === 'tone' ? 'sine=frequency=440:sample_rate=16000' : 'anullsrc=r=16000:cl=mono',
    );
  }
  const filter = `${blocks.map((_, i) => `[${String(i)}:a]`).join('')}concat=n=${String(blocks.length)}:v=0:a=1[out]`;

  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    ...inputs,
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-ac',
    '1',
    '-ar',
    '16000',
    path,
  ]);
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'vydoh-speech-fixture-'));
  shortAudio = join(fixtureDir, 'short.wav');
  longAudio = join(fixtureDir, 'long.wav');
  await makeAudio(shortAudio, [{ kind: 'tone', sec: 3 }]);
  await makeAudio(longAudio, [
    { kind: 'tone', sec: 6 },
    { kind: 'silence', sec: 1 },
    { kind: 'tone', sec: 6 },
  ]);
}, 120_000);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 500, firstName: 'Аня' });
  userId = user.id;

  const [message] = await testDb()
    .insert(messagesRaw)
    .values({
      userId,
      updateId: 1,
      tgChatId: 500,
      tgMessageId: 1,
      kind: 'voice',
      fileId: 'voice-file-1',
      audioDurationSec: 3,
    })
    .returning({ id: messagesRaw.id });
  messageId = message!.id;
});

/** Скачивание подменяется копированием готового файла. */
const downloadFrom = (source: string) => async (_fileId: string, dest: string) => {
  await copyFile(source, dest);
};

describe('transcribeMessage', () => {
  it('расшифровывает короткую запись одной частью', async () => {
    const provider = new MockSpeechProvider({ responses: ['купить продукты'] });

    const outcome = await transcribeMessage(
      { db: testDb(), provider, download: downloadFrom(shortAudio), pricing },
      { messageId, fileId: 'voice-file-1', userId },
    );

    expect(outcome.text).toBe('купить продукты');
    expect(outcome.parts).toBe(1);
    expect(outcome.truncated).toBe(false);
  }, 60_000);

  it('сохраняет расшифровку в сообщение', async () => {
    const provider = new MockSpeechProvider({ responses: ['записать к врачу'] });

    await transcribeMessage(
      { db: testDb(), provider, download: downloadFrom(shortAudio), pricing },
      { messageId, fileId: 'voice-file-1', userId },
    );

    const [row] = await testDb().select().from(messagesRaw).where(eq(messagesRaw.id, messageId));
    expect(row?.transcript).toBe('записать к врачу');
  }, 60_000);

  it('очищает ссылку на файл: она больше не нужна (§16 ТЗ)', async () => {
    const provider = new MockSpeechProvider({ responses: ['текст'] });

    await transcribeMessage(
      { db: testDb(), provider, download: downloadFrom(shortAudio), pricing },
      { messageId, fileId: 'voice-file-1', userId },
    );

    const [row] = await testDb().select().from(messagesRaw).where(eq(messagesRaw.id, messageId));
    expect(row?.fileId).toBeNull();
  }, 60_000);

  it('склеивает части длинной записи в один текст', async () => {
    const provider = new MockSpeechProvider({ responses: ['первая часть', 'вторая часть'] });

    const outcome = await transcribeMessage(
      {
        db: testDb(),
        provider,
        download: downloadFrom(longAudio),
        limits: { maxSegmentSec: 7, maxSingleDurationSec: 600 },
        pricing,
      },
      { messageId, fileId: 'voice-file-1', userId },
    );

    expect(outcome.parts).toBeGreaterThan(1);
    expect(outcome.text).toBe('первая часть вторая часть');
    expect(provider.callCount).toBe(outcome.parts);
  }, 120_000);

  it('сообщает об обрезке записи сверх потолка', async () => {
    const provider = new MockSpeechProvider({ responses: ['часть'] });

    const outcome = await transcribeMessage(
      {
        db: testDb(),
        provider,
        download: downloadFrom(longAudio),
        limits: { maxSegmentSec: 5, maxSingleDurationSec: 6 },
        pricing,
      },
      { messageId, fileId: 'voice-file-1', userId },
    );

    expect(outcome.truncated).toBe(true);
  }, 120_000);
});

describe('учёт расхода', () => {
  it('записывает вызов провайдера с секундами аудио', async () => {
    const provider = new MockSpeechProvider({ responses: ['текст'] });

    await transcribeMessage(
      { db: testDb(), provider, download: downloadFrom(shortAudio), pricing },
      { messageId, fileId: 'voice-file-1', userId },
    );

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.stage).toBe('speech');
    expect(call?.model).toBe('mock');
    expect(call?.ok).toBe(true);
    expect(call?.audioSeconds).toBeGreaterThan(0);
    expect(call?.costMicros).toBeGreaterThan(0);
  }, 60_000);

  it('перейдённый потолок расхода останавливает расшифровку до провайдера', async () => {
    /**
     * **Задача 3.79, находка встречной проверки 06.09.2026.** Сперва
     * страж стоял только на пути модели, и выходило хуже, чем кажется:
     * при перейдённом потолке голосовое сперва **оплачивалось**, а потом
     * падало на разборе — деньги ушли, ответа нет. А съешь голосовые
     * потолок сами — страж выключил бы модель, то есть единственное, что
     * даёт человеку пользу, и оставил включённой речь, то есть расход.
     */
    const provider = new MockSpeechProvider({ responses: ['текст'] });

    await expect(
      transcribeMessage(
        {
          db: testDb(),
          provider,
          download: downloadFrom(shortAudio),
          pricing,
          spendGuard: {
            beforeCall: () => Promise.reject(new SpendCeilingError('потолок за сутки перейдён')),
            noteSpent: () => undefined,
            report: () => Promise.resolve([]),
          },
        },
        { messageId, fileId: 'voice-file-1', userId },
      ),
    ).rejects.toBeInstanceOf(SpendCeilingError);

    // Ни одного платного обращения и ни одной строки учёта.
    expect(provider.callCount).toBe(0);
    expect(await testDb().select().from(aiCalls)).toHaveLength(0);
  }, 60_000);

  it('записывает по одному вызову на часть', async () => {
    const provider = new MockSpeechProvider({ responses: ['раз', 'два'] });

    await transcribeMessage(
      {
        db: testDb(),
        provider,
        download: downloadFrom(longAudio),
        limits: { maxSegmentSec: 7, maxSingleDurationSec: 600 },
        pricing,
      },
      { messageId, fileId: 'voice-file-1', userId },
    );

    const calls = await testDb().select().from(aiCalls);
    expect(calls.length).toBeGreaterThan(1);
  }, 120_000);

  it('записывает неуспешный вызов', async () => {
    // §10.5 ТЗ: учёт ведётся и по сбоям, иначе расход на повторах невидим.
    const provider = new MockSpeechProvider({
      failFirst: { times: 10, error: new PermanentSpeechError('файл повреждён') },
    });

    await expect(
      transcribeMessage(
        { db: testDb(), provider, download: downloadFrom(shortAudio), pricing },
        { messageId, fileId: 'voice-file-1', userId },
      ),
    ).rejects.toThrow('файл повреждён');

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.ok).toBe(false);
    expect(call?.error).toContain('файл повреждён');
  }, 60_000);
});

describe('оплаченная отправка', () => {
  /**
   * Ревизия этапов 1–2, молчаливые отказы 7 и 8.
   *
   * Распознавание платит **отправкой**: как только провайдер принял звук,
   * секунды списаны, что бы ни случилось дальше. Своим отказам провайдер
   * ставил пометку «уже заплачено», но таймаут стоит снаружи и в гонке
   * отдавал наверх свой, чужой отказ — без пометки. Повтор отправлял ту
   * же минуту записи второй и третий раз.
   *
   * А в учёте у сорвавшегося вызова стоял пустой расход. Панель при этом
   * не показывала «не смогли посчитать»: оговорка «расход не меньше
   * показанного» намеренно считала только удавшиеся вызовы. Секунды
   * оплачены, в сумму не вошли, оговорка не горит — ноль вместо «не
   * смогли», самая дорогая из лжей.
   */

  it('звук принят, а результата нет: отправкой не повторяем', async () => {
    const provider = new MockSpeechProvider({
      acceptsBeforeFailure: true,
      failFirst: { times: 3, error: new TransientSpeechError('сеть моргнула после приёма') },
    });

    await expect(
      transcribeMessage(
        { db: testDb(), provider, download: downloadFrom(shortAudio), pricing },
        { messageId, fileId: 'voice-paid-1', userId },
      ),
    ).rejects.toThrow();

    expect(provider.callCount, 'за одну и ту же запись заплатили дважды').toBe(1);
  }, 60_000);

  it('оплаченные секунды доезжают до учёта и до цены', async () => {
    const provider = new MockSpeechProvider({
      acceptsBeforeFailure: true,
      failFirst: { times: 3, error: new TransientSpeechError('результат не доехал') },
    });

    await expect(
      transcribeMessage(
        { db: testDb(), provider, download: downloadFrom(shortAudio), pricing },
        { messageId, fileId: 'voice-paid-2', userId },
      ),
    ).rejects.toThrow();

    const [call] = await testDb().select().from(aiCalls);

    expect(call?.ok).toBe(false);
    expect(call?.audioSeconds, 'оплаченные секунды записаны нулём').toBeGreaterThan(0);
    expect(call?.costMicros, 'ушедшие деньги не попали в счёт').toBeGreaterThan(0);
  }, 60_000);

  it('звук не приняли — повтор остаётся', async () => {
    /**
     * Обратная сторона: запретить повтор сетевому обрыву значило бы
     * разучиться переживать моргнувшую сеть, а это куда более частый
     * случай, чем отказ после приёма.
     */
    const provider = new MockSpeechProvider({
      failFirst: { times: 1, error: new TransientSpeechError('не достучались') },
      responses: ['', 'текст со второй попытки'],
    });

    const outcome = await transcribeMessage(
      {
        db: testDb(),
        provider,
        download: downloadFrom(shortAudio),
        pricing,
        retry: { attempts: 2, sleep: () => Promise.resolve() },
      },
      { messageId, fileId: 'voice-retry-ok', userId },
    );

    expect(outcome.text).toContain('второй попытки');
    expect(provider.callCount).toBe(2);
  }, 60_000);
});

describe('устойчивость', () => {
  it('повторяет временную ошибку и доводит дело до конца', async () => {
    const provider = new MockSpeechProvider({
      failFirst: { times: 2, error: new TransientSpeechError('провайдер занят') },
      responses: [],
      respond: () => 'получилось со третьей попытки',
    });

    const outcome = await transcribeMessage(
      {
        db: testDb(),
        provider,
        download: downloadFrom(shortAudio),
        retry: { sleep: () => Promise.resolve() },
        pricing,
      },
      { messageId, fileId: 'voice-file-1', userId },
    );

    expect(outcome.text).toBe('получилось со третьей попытки');
    expect(provider.callCount).toBe(3);
  }, 60_000);

  it('не повторяет постоянную ошибку', async () => {
    const provider = new MockSpeechProvider({
      failFirst: { times: 10, error: new PermanentSpeechError('неверный ключ') },
    });

    await expect(
      transcribeMessage(
        {
          db: testDb(),
          provider,
          download: downloadFrom(shortAudio),
          retry: { sleep: () => Promise.resolve() },
          pricing,
        },
        { messageId, fileId: 'voice-file-1', userId },
      ),
    ).rejects.toThrow('неверный ключ');

    expect(provider.callCount).toBe(1);
  }, 60_000);

  it('сбой скачивания не оставляет расшифровку наполовину', async () => {
    const provider = new MockSpeechProvider();

    await expect(
      transcribeMessage(
        {
          db: testDb(),
          provider,
          download: () => Promise.reject(new Error('файл недоступен')),
          pricing,
        },
        { messageId, fileId: 'voice-file-1', userId },
      ),
    ).rejects.toThrow('файл недоступен');

    const [row] = await testDb().select().from(messagesRaw).where(eq(messagesRaw.id, messageId));
    // Сообщение на месте, ссылка на файл цела: расшифровку можно повторить.
    expect(row?.transcript).toBeNull();
    expect(row?.fileId).toBe('voice-file-1');
  }, 60_000);
});
