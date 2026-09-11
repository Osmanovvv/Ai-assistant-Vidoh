import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, batches, messagesRaw, type Batch } from '../../db/schema.js';
import { makeAudio } from '../../test/audio.js';
import { testDb } from '../../test/db.js';
import { attachMessageToBatch } from '../buffer/buffer.service.js';
import { transcribeBatch } from '../pipeline/transcribe.js';
import { upsertUser } from '../users/users.repo.js';
import { GLUE_PAUSE_SEC } from './audio.service.js';
import { probeDurationSec } from './ffmpeg.js';
import type {
  RecognizedUtterance,
  SpeechProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from './providers/types.js';
import { transcribeVoices } from './speech.service.js';

/**
 * Склейка голосовых выгрузки в один запрос (задача 1.14, дополнено
 * 27.08.2026).
 *
 * Живая выгрузка 27.08.2026: девять голосовых, 172 секунды речи и
 * семнадцать оплаченных блоков по 15 секунд вместо двенадцати — каждая
 * запись округлялась вверх сама по себе. Склейка убирает восемь округлений
 * из девяти.
 *
 * Проверяется не экономия — она арифметика, — а то, что за неё не
 * заплачено правдой: каждая расшифровка обязана вернуться в своё
 * сообщение. На ней держатся выгрузка данных по §16, повторный заход
 * после сбоя и порядок текста выгрузки.
 */

/** Длительности трёх записей, из которых считаются границы внутри склейки. */
const SECONDS = [2, 3, 4] as const;

/** Долгая запись для проверки обрезки: имя файла и её настоящая длина. */
const LONG_FILE_ID = 'long';
const LONG_FILE_SEC = 20;

function intervals(): readonly { readonly startSec: number; readonly endSec: number }[] {
  const result: { startSec: number; endSec: number }[] = [];
  let cursor = 0;

  for (const seconds of SECONDS) {
    result.push({ startSec: cursor, endSec: cursor + seconds });
    cursor += seconds + GLUE_PAUSE_SEC;
  }

  return result;
}

/** Провайдер, возвращающий заранее заданные фразы со временами. */
class TimedProvider implements SpeechProvider {
  readonly name = 'fake-timed';
  readonly timeline = true;
  calls = 0;

  constructor(private readonly utterances: readonly RecognizedUtterance[]) {}

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    this.calls++;

    return Promise.resolve({
      text: this.utterances.map((utterance) => utterance.text).join(' '),
      model: 'fake',
      audioSeconds: Math.round(request.durationSec),
      utterances: this.utterances,
    });
  }
}

/** Провайдер без времён: склейка к нему не применяется. */
class PlainProvider implements SpeechProvider {
  readonly name = 'fake-plain';
  calls = 0;

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    this.calls++;

    return Promise.resolve({
      text: `запись ${String(this.calls)}`,
      model: 'fake',
      audioSeconds: Math.round(request.durationSec),
    });
  }
}

/** Провайдер, отдающий текст без времён: раскладке не поддаётся. */
class NoTimesProvider implements SpeechProvider {
  readonly name = 'fake-no-times';
  readonly timeline = true;
  calls = 0;

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    this.calls++;

    return Promise.resolve({
      text: 'что-то сказано',
      model: 'fake',
      audioSeconds: Math.round(request.durationSec),
      utterances: [{ text: 'что-то сказано', words: [] }],
    });
  }
}

/**
 * Провайдер, который меряет присланный ему файл.
 *
 * Нужен потому, что до сих пор ни одна проверка не открывала то, что
 * уезжает в распознаватель. Обрезку по потолку выгрузки подтверждали
 * флагом `truncated` и непустой расшифровкой — а и то и другое остаётся
 * правдой, даже если в запрос ушла вся запись целиком. Платим мы за
 * секунды звука в отправленном файле, значит и мерить надо его.
 */
class MeasuringProvider implements SpeechProvider {
  readonly name = 'fake-measuring';
  readonly timeline = true;
  calls = 0;
  /** Длительности отправленных файлов, снятые ffprobe. */
  readonly sentSec: number[] = [];

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    this.calls++;
    this.sentSec.push(await probeDurationSec(request.filePath));

    const text = `часть ${String(this.calls)}`;
    return {
      text,
      model: 'fake',
      audioSeconds: Math.round(request.durationSec),
      utterances: [{ text, words: [{ text, startMs: 300, endMs: 700 }] }],
    };
  }
}

let dir = '';
let userId = '';
let batch: Batch;
let messageIds: string[] = [];
let seq = 0;

afterAll(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  if (dir === '') {
    dir = await mkdtemp(join(tmpdir(), 'glue-int-'));
    for (const [index, seconds] of SECONDS.entries()) {
      await makeAudio(join(dir, `v${String(index)}.wav`), [{ kind: 'tone', sec: seconds }]);
    }
    // Запись, которая заведомо не влезает в остаток потолка выгрузки:
    // на коротких файлах обрезку нечем отличить от её отсутствия.
    await makeAudio(join(dir, `${LONG_FILE_ID}.wav`), [{ kind: 'tone', sec: LONG_FILE_SEC }]);
  }

  seq++;
  const user = await upsertUser(testDb(), { tgId: 9100 + seq, firstName: 'Аня' });
  userId = user.id;
  messageIds = [];

  for (const [index] of SECONDS.entries()) {
    const [row] = await testDb()
      .insert(messagesRaw)
      .values({
        userId,
        updateId: 9_100_000 + seq * 100 + index,
        tgChatId: 9100 + seq,
        tgMessageId: index + 1,
        kind: 'voice',
        fileId: `v${String(index)}`,
        audioDurationSec: SECONDS[index] ?? 0,
      })
      .returning({ id: messagesRaw.id });

    messageIds.push(row?.id ?? '');
    await attachMessageToBatch(testDb(), { userId, messageId: row?.id ?? '' });
  }

  const [row] = await testDb().select().from(batches).where(eq(batches.userId, userId));
  if (!row) throw new Error('выгрузка не создалась');
  batch = row;
});

/** Скачивание подменено копированием: fileId — имя файла в папке. */
async function download(fileId: string, destPath: string): Promise<void> {
  await copyFile(join(dir, `${fileId}.wav`), destPath);
}

/** Одно слово в начале своей записи: этого хватает, чтобы проверить адрес. */
function utteranceAt(text: string, startSec: number): RecognizedUtterance {
  const startMs = Math.round((startSec + 0.3) * 1000);
  return { text, words: [{ text: text.toLowerCase(), startMs, endMs: startMs + 400 }] };
}

function voices(durations: readonly number[] = SECONDS): readonly {
  readonly messageId: string;
  readonly fileId: string;
  readonly durationSec: number;
}[] {
  return messageIds.map((id, index) => ({
    messageId: id,
    fileId: `v${String(index)}`,
    durationSec: durations[index] ?? 0,
  }));
}

async function transcriptsInOrder(): Promise<readonly (string | null)[]> {
  const rows = await testDb()
    .select({ transcript: messagesRaw.transcript })
    .from(messagesRaw)
    .where(eq(messagesRaw.userId, userId))
    .orderBy(asc(messagesRaw.tgMessageId));

  return rows.map((row) => row.transcript);
}

describe('расшифровка выгрузки одним запросом', () => {
  it('каждая расшифровка возвращается в своё сообщение', async () => {
    const bounds = intervals();
    const provider = new TimedProvider([
      utteranceAt('Первое.', bounds[0]?.startSec ?? 0),
      utteranceAt('Второе.', bounds[1]?.startSec ?? 0),
      utteranceAt('Третье.', bounds[2]?.startSec ?? 0),
    ]);

    const outcome = await transcribeVoices(
      { db: testDb(), provider, download },
      { messages: voices(), userId, batchId: batch.id },
    );

    expect(outcome.requests).toBe(1);
    expect(outcome.split).toBe(0);
    expect(await transcriptsInOrder()).toEqual(['Первое.', 'Второе.', 'Третье.']);
  });

  it('запрос один, и в учёте расхода одна строка на всю склейку', async () => {
    const bounds = intervals();
    const provider = new TimedProvider([utteranceAt('Одна фраза.', bounds[0]?.startSec ?? 0)]);

    await transcribeVoices(
      { db: testDb(), provider, download },
      { messages: voices(), userId, batchId: batch.id },
    );

    expect(provider.calls).toBe(1);

    // Именно на этом держится экономия: одна строка на одиннадцать секунд
    // вместо трёх по две, три и четыре, каждая округлённая вверх.
    const calls = await testDb().select().from(aiCalls).where(eq(aiCalls.userId, userId));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.audioSeconds).toBe(11);
  });

  it('ссылка на файл снимается: держать её дольше обработки нельзя', async () => {
    // §16 ТЗ. Раньше это делала расшифровка по одному сообщению, и при
    // переходе на склейку легко было потерять.
    const bounds = intervals();
    const provider = new TimedProvider([utteranceAt('Первое.', bounds[0]?.startSec ?? 0)]);

    await transcribeVoices(
      { db: testDb(), provider, download },
      { messages: voices(), userId, batchId: batch.id },
    );

    const rows = await testDb()
      .select({ fileId: messagesRaw.fileId })
      .from(messagesRaw)
      .where(eq(messagesRaw.userId, userId));

    expect(rows.map((row) => row.fileId)).toEqual([null, null, null]);
  });

  it('запись без речи получает пустую расшифровку, а не чужую', async () => {
    const bounds = intervals();
    const provider = new TimedProvider([
      utteranceAt('Первое.', bounds[0]?.startSec ?? 0),
      utteranceAt('Третье.', bounds[2]?.startSec ?? 0),
    ]);

    await transcribeVoices(
      { db: testDb(), provider, download },
      { messages: voices(), userId, batchId: batch.id },
    );

    expect(await transcriptsInOrder()).toEqual(['Первое.', '', 'Третье.']);
  });
});

describe('когда склейка не применяется', () => {
  it('провайдер без времён расшифровывает по одному сообщению', async () => {
    const provider = new PlainProvider();

    const result = await transcribeBatch(testDb(), batch, { provider, download });

    expect(provider.calls).toBe(3);
    expect(result.requests).toBe(3);
    expect(await transcriptsInOrder()).toEqual(['запись 1', 'запись 2', 'запись 3']);
  });

  it('фраза без времён — откат на расшифровку по одному, а не догадка', async () => {
    // Приписать текст наугад значило бы тихо соврать о том, кто что
    // сказал. Дороже, зато честно.
    const provider = new NoTimesProvider();
    const result = await transcribeBatch(testDb(), batch, { provider, download });

    // Один заход склейкой плюс три по одному: деньги за склеенный запрос
    // уже потрачены, поэтому такой откат обязан быть виден в журнале.
    expect(provider.calls).toBe(4);
    expect(result.requests).toBe(3);
    expect(await transcriptsInOrder()).toEqual([
      'что-то сказано',
      'что-то сказано',
      'что-то сказано',
    ]);
  });
});

describe('склейка длиннее потолка запроса', () => {
  /** Возвращает одну фразу в начале каждой части: проверка сдвига времён. */
  class PerPartProvider implements SpeechProvider {
    readonly name = 'fake-per-part';
    readonly timeline = true;
    calls = 0;

    transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
      this.calls++;
      const text = `часть ${String(this.calls)}`;

      return Promise.resolve({
        text,
        model: 'fake',
        audioSeconds: Math.round(request.durationSec),
        utterances: [{ text, words: [{ text, startMs: 300, endMs: 700 }] }],
      });
    }
  }

  it('части считаются от своего начала, а не от начала склейки', async () => {
    // Telegram округляет длительности до секунды, и на десятке записей
    // склейка выходит длиннее, чем ожидала раскладка. Тогда она режется
    // на части — и если забыть сдвинуть времена, всё уедет в первое
    // сообщение. Здесь длительности намеренно занижены до секунды.
    const provider = new PerPartProvider();

    const outcome = await transcribeVoices(
      {
        db: testDb(),
        provider,
        download,
        limits: { maxSegmentSec: 5, maxSingleDurationSec: 600 },
      },
      { messages: voices([1, 1, 1]), userId, batchId: batch.id },
    );

    // Одна группа по расчёту, но настоящие одиннадцать секунд не влезают
    // в потолок пяти: получилось несколько частей.
    expect(outcome.requests).toBeGreaterThan(1);

    const transcripts = await transcriptsInOrder();
    expect(transcripts.filter((text) => text !== '' && text !== null).length).toBeGreaterThan(1);
    expect(transcripts[0]).toBe('часть 1');
  });
});

describe('потолок на выгрузку (§10.5 ТЗ)', () => {
  it('записи за потолком не расшифровываются, и это видно', async () => {
    // Потолка на выгрузку в коде не было — нашлось аудитом 27.08.2026.
    // Без него потолок в тридцать выгрузок за сутки ничего не ограничивает.
    const bounds = intervals();
    const provider = new TimedProvider([
      utteranceAt('Первое.', bounds[0]?.startSec ?? 0),
      utteranceAt('Второе.', bounds[1]?.startSec ?? 0),
    ]);

    const outcome = await transcribeVoices(
      {
        db: testDb(),
        provider,
        download,
        limits: { maxSegmentSec: 82, maxSingleDurationSec: 600, maxDumpDurationSec: 5 },
      },
      { messages: voices(), userId, batchId: batch.id },
    );

    // Две записи по две и три секунды укладываются ровно в потолок,
    // третья — уже нет.
    expect(outcome.truncated).toBe(true);
    expect(await transcriptsInOrder()).toEqual(['Первое.', 'Второе.', '']);
  });

  it('нерасшифрованной записи ставится пустая расшифровка, а не ничего', async () => {
    // Иначе повторный заход брался бы за неё снова и снова: он ищет
    // сообщения с непустой ссылкой на файл и пустой расшифровкой.
    const provider = new TimedProvider([utteranceAt('Первое.', 0)]);

    await transcribeVoices(
      {
        db: testDb(),
        provider,
        download,
        limits: { maxSegmentSec: 82, maxSingleDurationSec: 600, maxDumpDurationSec: 2 },
      },
      { messages: voices(), userId, batchId: batch.id },
    );

    const rows = await testDb()
      .select({ transcript: messagesRaw.transcript, fileId: messagesRaw.fileId })
      .from(messagesRaw)
      .where(eq(messagesRaw.userId, userId))
      .orderBy(asc(messagesRaw.tgMessageId));

    expect(rows.every((row) => row.transcript !== null)).toBe(true);
    expect(rows.every((row) => row.fileId === null)).toBe(true);
  });

  it('запись, упёршаяся в потолок, слушается до остатка, а не выбрасывается', async () => {
    // Человек говорил, и услышать его надо настолько, насколько мы
    // обещали. Остаток пятнадцать секунд — как раз блок оплаты.
    //
    // **Здесь мерится отправленный файл, а не флаг.** Прежде проверка
    // смотрела только на `truncated` и на «расшифровка непустая», а
    // третья запись лежала на диске четырьмя секундами — то есть в
    // остаток укладывалась и без всякой обрезки. Отличить «услышали
    // ровно остаток» от «отправили всё целиком» было нечем: и то и
    // другое даёт непустой текст и поднятый флаг. Теперь запись
    // настоящая, двадцатисекундная, и длина снимается с того файла,
    // который уехал в распознаватель.
    const provider = new MeasuringProvider();

    // Потолок выгрузки 17 секунд, первые две записи заявлены по одной:
    // третьей остаётся ровно пятнадцать — блок оплаты, ниже которого
    // остаток уже не берётся.
    const remainderSec = 15;

    const outcome = await transcribeVoices(
      {
        db: testDb(),
        provider,
        download,
        limits: { maxSegmentSec: 82, maxSingleDurationSec: 600, maxDumpDurationSec: 17 },
      },
      {
        messages: [
          { messageId: messageIds[0] ?? '', fileId: 'v0', durationSec: 1 },
          { messageId: messageIds[1] ?? '', fileId: 'v1', durationSec: 1 },
          { messageId: messageIds[2] ?? '', fileId: LONG_FILE_ID, durationSec: LONG_FILE_SEC },
        ],
        userId,
        batchId: batch.id,
      },
    );

    // Третья заявлена на 20 секунд, а остатка 15: она обрезается, но
    // расшифровывается.
    expect(outcome.truncated).toBe(true);
    const transcripts = await transcriptsInOrder();
    expect(transcripts[2]).not.toBe('');

    // Ни один отправленный файл не вправе быть длиннее остатка: сверх
    // него мы платим за секунды, которые сами же назвали запретными
    // (§10.5), а тело запроса перерастает потолок, на котором SpeechKit
    // обрывает соединение.
    expect(
      Math.max(...provider.sentSec),
      `отправлены файлы длиной ${provider.sentSec.map((sec) => sec.toFixed(2)).join(', ')} с`,
    ).toBeLessThanOrEqual(remainderSec + 0.2);

    // И не короче: обрезка не повод потерять почти весь остаток.
    expect(Math.max(...provider.sentSec)).toBeGreaterThan(remainderSec - 0.5);
  });

  it('обрезка доходит до расшифровки выгрузки, а не теряется по пути', async () => {
    // Именно здесь ломался бы разрыв «модуль есть, а наверх не отдаёт»:
    // ответ человеку строится по этому признаку.
    const provider = new PlainProvider();

    const result = await transcribeBatch(testDb(), batch, {
      provider,
      download,
      limits: { maxSegmentSec: 82, maxSingleDurationSec: 1 },
    });

    expect(result.truncated).toBe(true);
  });
});

describe('откат от склейки после сорвавшейся группы', () => {
  /**
   * Провайдер, у которого времена слов есть только в первом ответе.
   *
   * Первая группа раскладывается и записывается; вторая приходит без
   * времён, и раскладка отказывается от неё. Дальше — запросы по одному
   * сообщению, в которых времена не нужны.
   */
  class TimesOnceProvider implements SpeechProvider {
    readonly name = 'fake-times-once';
    readonly timeline = true;
    calls = 0;

    constructor(private readonly first: readonly RecognizedUtterance[]) {}

    transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
      this.calls++;

      const utterances = this.calls === 1 ? this.first : [{ text: 'по одному', words: [] }];

      return Promise.resolve({
        text: utterances.map((utterance) => utterance.text).join(' '),
        model: 'fake',
        audioSeconds: Math.round(request.durationSec),
        utterances,
      });
    }
  }

  /** Длительность четвёртой записи: файл тот же, что у второй. */
  const FOURTH_SEC = SECONDS[1];

  beforeEach(async () => {
    // Четвёртая запись — чтобы групп вышло две и обе клеились: на трёх
    // записях вторая группа всегда одиночная, а одиночная не срывается.
    const [row] = await testDb()
      .insert(messagesRaw)
      .values({
        userId,
        updateId: 9_100_000 + seq * 100 + SECONDS.length,
        tgChatId: 9100 + seq,
        tgMessageId: SECONDS.length + 1,
        kind: 'voice',
        fileId: 'v1',
        audioDurationSec: FOURTH_SEC,
      })
      .returning({ id: messagesRaw.id });

    messageIds.push(row?.id ?? '');
    await attachMessageToBatch(testDb(), { userId, messageId: row?.id ?? '' });
  });

  it('уже записанные группы второй раз не оплачиваются и не переписываются', async () => {
    // Склейка пишет расшифровки в базу группа за группой — нарочно,
    // чтобы повторный заход добирал только нерасшифрованное. Откат по
    // списку, снятому до склейки, этого не знал: качал и оплачивал все
    // записи заново, а верную расшифровку первой группы затирал новым
    // распознаванием того же звука.
    const bounds = intervals();
    const provider = new TimesOnceProvider([
      utteranceAt('Первое.', bounds[0]?.startSec ?? 0),
      utteranceAt('Второе.', bounds[1]?.startSec ?? 0),
    ]);

    // Потолок запроса девять секунд: 2 + 3 + пауза влезают, 4 + 3 + пауза
    // влезают, все четыре — нет. Две группы, обе склеиваются.
    await transcribeBatch(testDb(), batch, {
      provider,
      download,
      limits: { maxSegmentSec: 9, maxSingleDurationSec: 600 },
    });

    // Первая группа осталась тем, что дала склейка; по одному
    // расшифрованы только две записи сорвавшейся группы.
    expect(await transcriptsInOrder()).toEqual(['Первое.', 'Второе.', 'по одному', 'по одному']);

    // Счёт: удавшаяся склейка, сорвавшаяся и две по одному. Каждая
    // отправка — строка учёта, и лишних строк быть не должно: до починки
    // их выходило шесть.
    const calls = await testDb().select().from(aiCalls).where(eq(aiCalls.userId, userId));
    expect(calls, 'строк учёта').toHaveLength(4);
    expect(provider.calls).toBe(4);
  });
});
