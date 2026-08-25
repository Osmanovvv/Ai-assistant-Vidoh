import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PermanentSpeechError, TransientSpeechError } from './types.js';
import { YandexSpeechProvider, parseRecognition, toYandexLanguage } from './yandex.js';

/**
 * Провайдер проверяется на подменённом fetch: живой вызов стоит денег и
 * зависит от сети, а разбор ответов и классификация ошибок — нет.
 *
 * Образцы ответов взяты из настоящих вызовов SpeechKit 24.08.2026,
 * а не придуманы: в документации форма ответа getRecognition описана
 * неполно, и тест на выдуманном образце проверял бы не тот формат.
 */

const AUDIO = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x2a, 0x00]);

let dir = '';
let filePath = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vydoh-yandex-test-'));
  filePath = join(dir, 'part-00.wav');
  await writeFile(filePath, AUDIO);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

const request = () => ({ filePath, durationSec: 14.45, language: 'ru' });

/** Строка события `final`: текст без знаков препинания. */
const finalLine = (index: number, text: string) =>
  JSON.stringify({
    result: {
      audioCursors: { finalTimeMs: '14400', finalIndex: String(index) },
      final: { alternatives: [{ words: [], text, startTimeMs: '0', endTimeMs: '14400' }] },
      channelTag: '0',
    },
  });

/** Строка события `finalRefinement`: тот же текст, но нормализованный. */
const refinementLine = (index: number, text: string) =>
  JSON.stringify({
    result: {
      audioCursors: { finalTimeMs: '14400', finalIndex: String(index) },
      finalRefinement: {
        finalIndex: String(index),
        normalizedText: { alternatives: [{ words: [], text }] },
      },
      channelTag: '0',
    },
  });

const eouLine = () => JSON.stringify({ result: { eouUpdate: { timeMs: '14400' } } });

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** Тело отправленного запроса. Мы всегда посылаем строку JSON. */
function jsonBody(call: Call | undefined): Record<string, unknown> {
  const body = call?.init.body;
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>;
}

interface StubOptions {
  /** Сколько первых опросов операции ответят «ещё не готово». */
  readonly pendingPolls?: number;
  readonly operationError?: unknown;
  readonly recognition?: string;
  readonly startStatus?: number;
  readonly startBody?: unknown;
  readonly recognitionStatus?: number;
}

/** Заглушка трёх обращений: запуск, опрос операции, выдача результата. */
function stub(options: StubOptions = {}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let polls = 0;

  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });

    if (url.includes('recognizeFileAsync')) {
      const body = options.startBody ?? { id: 'op-1', done: false };
      return Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status: options.startStatus ?? 200,
        }),
      );
    }

    if (url.includes('/operations/')) {
      polls++;
      if (options.operationError !== undefined) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'op-1', done: true, error: options.operationError }), {
            status: 200,
          }),
        );
      }
      const done = polls > (options.pendingPolls ?? 0);
      return Promise.resolve(new Response(JSON.stringify({ id: 'op-1', done }), { status: 200 }));
    }

    return Promise.resolve(
      new Response(options.recognition ?? '', { status: options.recognitionStatus ?? 200 }),
    );
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const provider = (options: StubOptions & { folderId?: string; model?: string } = {}) => {
  const { fetchImpl, calls } = stub(options);
  const instance = new YandexSpeechProvider({
    apiKey: 'секретный-ключ',
    folderId: options.folderId,
    model: options.model,
    fetchImpl,
    sleep: () => Promise.resolve(),
  });
  return { instance, calls };
};

describe('успешная расшифровка', () => {
  it('предпочитает нормализованный текст: он с пунктуацией', async () => {
    // Ровно то, ради чего взят v3 вместо v1.
    const recognition = [
      finalLine(0, 'надо записать сына к врачу купить продукты'),
      refinementLine(0, 'Надо записать сына к врачу, купить продукты.'),
      eouLine(),
      '',
    ].join('\n');

    const { instance } = provider({ recognition });

    const result = await instance.transcribe(request());

    expect(result.text).toBe('Надо записать сына к врачу, купить продукты.');
    expect(result.model).toBe('general');
    // Секунды округляются: по ним считается расход (§10.5 ТЗ).
    expect(result.audioSeconds).toBe(14);
  });

  it('берёт текст без пунктуации, если нормализованного не пришло', async () => {
    const { instance } = provider({ recognition: finalLine(0, 'купить продукты') });

    const result = await instance.transcribe(request());

    expect(result.text).toBe('купить продукты');
  });

  it('склеивает отрезки по номеру, а не по порядку строк', async () => {
    // Длинная запись распознаётся отрезками, и порядок строк в потоке
    // не обязан совпадать с порядком речи.
    const recognition = [
      refinementLine(1, 'Второй отрезок.'),
      finalLine(0, 'первый отрезок'),
      refinementLine(0, 'Первый отрезок.'),
      finalLine(1, 'второй отрезок'),
    ].join('\n');

    const { instance } = provider({ recognition });

    const result = await instance.transcribe(request());

    expect(result.text).toBe('Первый отрезок. Второй отрезок.');
  });

  it('тишина даёт пустой текст, а не ошибку', async () => {
    // Проверено живым вызовом: SpeechKit отвечает 200 с пустым текстом.
    // Голосовое без речи — не сбой, и валить обработку из-за него нельзя.
    const recognition = [finalLine(0, ''), refinementLine(0, ''), eouLine()].join('\n');

    const { instance } = provider({ recognition });

    await expect(instance.transcribe(request())).resolves.toMatchObject({ text: '' });
  });
});

describe('форма запроса', () => {
  it('отправляет ключ, каталог, аудио в base64 и просит нормализацию', async () => {
    const { instance, calls } = provider({
      recognition: finalLine(0, 'ок'),
      folderId: 'b1g-folder',
    });

    await instance.transcribe(request());

    const start = calls[0];
    expect(start?.url).toBe('https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync');

    const headers = start?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Api-Key секретный-ключ');
    expect(headers['x-folder-id']).toBe('b1g-folder');
    expect(headers['content-type']).toBe('application/json');

    const body = jsonBody(start) as unknown as {
      content: string;
      recognitionModel: {
        model: string;
        audioFormat: { containerAudio: { containerAudioType: string } };
        textNormalization: { textNormalization: string; profanityFilter: boolean };
        languageRestriction: { languageCode: string[] };
      };
    };

    expect(Buffer.from(body.content, 'base64')).toEqual(AUDIO);
    expect(body.recognitionModel.model).toBe('general');
    expect(body.recognitionModel.audioFormat.containerAudio.containerAudioType).toBe('WAV');
    expect(body.recognitionModel.textNormalization.textNormalization).toBe(
      'TEXT_NORMALIZATION_ENABLED',
    );
    // Человек выговаривается — подменять его слова звёздочками нельзя.
    expect(body.recognitionModel.textNormalization.profanityFilter).toBe(false);
    // «ru» превращается в «ru-RU»: SpeechKit понимает только полный код.
    expect(body.recognitionModel.languageRestriction.languageCode).toEqual(['ru-RU']);
  });

  it('не посылает заголовок каталога, если он не задан', async () => {
    const { instance, calls } = provider({ recognition: finalLine(0, 'ок') });

    await instance.transcribe(request());

    expect(calls[0]?.init.headers).not.toHaveProperty('x-folder-id');
  });

  it('без языка не ограничивает распознавание', async () => {
    const { instance, calls } = provider({ recognition: finalLine(0, 'ок') });

    await instance.transcribe({ filePath, durationSec: 3 });

    expect(jsonBody(calls[0])).not.toHaveProperty('recognitionModel.languageRestriction');
  });

  it('незнакомый код языка не превращается в выдуманный', async () => {
    // Выдуманный код привёл бы к отказу, а без ограничения SpeechKit
    // определит язык сам.
    const { instance, calls } = provider({ recognition: finalLine(0, 'ок') });

    await instance.transcribe({ filePath, durationSec: 3, language: 'xx' });

    const body = jsonBody(calls[0]) as unknown as { recognitionModel: object };
    expect(body.recognitionModel).not.toHaveProperty('languageRestriction');
  });

  it('название модели попадает в имя провайдера: цены у моделей разные', () => {
    const general = new YandexSpeechProvider({ apiKey: 'k' });
    const deluxe = new YandexSpeechProvider({ apiKey: 'k', model: 'deluxe' });

    expect(general.name).toBe('yandex:general');
    expect(deluxe.name).toBe('yandex:deluxe');
  });

  it('лишний слэш в адресе не превращается в двойной', async () => {
    const { fetchImpl, calls } = stub({ recognition: finalLine(0, 'ок') });
    const instance = new YandexSpeechProvider({
      apiKey: 'k',
      baseUrl: 'https://stt.example.test/',
      fetchImpl,
      sleep: () => Promise.resolve(),
    });

    await instance.transcribe(request());

    expect(calls[0]?.url).toBe('https://stt.example.test/stt/v3/recognizeFileAsync');
  });
});

describe('ожидание результата', () => {
  it('опрашивает операцию, пока она не готова', async () => {
    const { instance, calls } = provider({
      pendingPolls: 2,
      recognition: finalLine(0, 'готово'),
    });

    const result = await instance.transcribe(request());

    expect(result.text).toBe('готово');
    // Запуск, три опроса (два «не готово» и один «готово»), выдача.
    expect(calls.filter((call) => call.url.includes('/operations/'))).toHaveLength(3);
  });

  it('пауза между опросами растёт и упирается в потолок', async () => {
    const pauses: number[] = [];
    const { fetchImpl } = stub({ pendingPolls: 5, recognition: finalLine(0, 'ок') });

    const instance = new YandexSpeechProvider({
      apiKey: 'k',
      pollIntervalMs: 700,
      fetchImpl,
      sleep: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
    });

    await instance.transcribe(request());

    // Частый опрос длинной записи ничем не помогает, а квоту расходует.
    expect(pauses).toEqual([700, 1_400, 2_800, 3_000, 3_000]);
  });

  it('не дождавшись результата, сообщает о временной ошибке', async () => {
    // Распознавание не сломалось, а не успело — повтор осмыслен.
    vi.useFakeTimers();

    const { fetchImpl } = stub({ pendingPolls: 100 });
    const instance = new YandexSpeechProvider({
      apiKey: 'k',
      pollIntervalMs: 700,
      maxPollMs: 2_000,
      fetchImpl,
      sleep: (ms) => {
        vi.advanceTimersByTime(ms);
        return Promise.resolve();
      },
    });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(TransientSpeechError);
  });
});

describe('классификация ошибок', () => {
  it('429 считается временной', async () => {
    const { instance } = provider({ startStatus: 429, startBody: 'too many requests' });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(TransientSpeechError);
  });

  it('503 считается временной', async () => {
    const { instance } = provider({ startStatus: 503, startBody: 'unavailable' });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(TransientSpeechError);
  });

  it('401 считается постоянной: повтор не исправит ключ', async () => {
    // Проверено живым вызовом с испорченным ключом: SpeechKit
    // отвечает именно 401 и кодом 16.
    const { instance } = provider({
      startStatus: 401,
      startBody: { error: 'Unknown api key', code: 16 },
    });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });

  it('404 считается постоянной', async () => {
    const { instance } = provider({ recognitionStatus: 404, recognition: 'not found' });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });

  it('обрыв сети считается временной', async () => {
    const instance = new YandexSpeechProvider({
      apiKey: 'k',
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(TransientSpeechError);
  });

  it('внутренняя ошибка распознавания считается временной', async () => {
    // Код 13 — INTERNAL: у них не получилось, у нас может получиться.
    const { instance } = provider({ operationError: { code: 13, message: 'internal error' } });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(TransientSpeechError);
  });

  it('битый файл считается постоянной ошибкой', async () => {
    // Код 3 — INVALID_ARGUMENT: файл не станет целым от повтора.
    const { instance } = provider({ operationError: { code: 3, message: 'invalid audio' } });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });

  it('отказ в доступе считается постоянной ошибкой', async () => {
    const { instance } = provider({ operationError: { code: 7, message: 'permission denied' } });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });

  it('ошибка операции без кода считается постоянной', async () => {
    const { instance } = provider({ operationError: { message: 'что-то не так' } });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });

  it('ответ без идентификатора операции считается постоянной ошибкой', async () => {
    const { instance } = provider({ startBody: { description: 'без id' } });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });

  it('ответ не в JSON считается постоянной ошибкой', async () => {
    const { instance } = provider({ startBody: '<html>прокси вернул страницу</html>' });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });

  it('неразбираемая строка результата считается постоянной ошибкой', async () => {
    const { instance } = provider({ recognition: '{это не json}' });

    await expect(instance.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });
});

describe('конструктор', () => {
  it('отвергает пустой ключ', () => {
    expect(() => new YandexSpeechProvider({ apiKey: '   ' })).toThrow(/пустой ключ/u);
  });
});

describe('parseRecognition', () => {
  it('пропускает пустые строки и незнакомые события', () => {
    const body = ['', eouLine(), finalLine(0, 'текст'), '  ', '{"result":{}}'].join('\n');

    expect(parseRecognition(body)).toBe('текст');
  });

  it('пустой ответ даёт пустую строку', () => {
    expect(parseRecognition('')).toBe('');
  });
});

describe('toYandexLanguage', () => {
  it('дополняет короткий код', () => {
    expect(toYandexLanguage('ru')).toBe('ru-RU');
  });

  it('английскому соответствует en-US, а не en-EN', () => {
    expect(toYandexLanguage('en')).toBe('en-US');
  });

  it('полный код пропускает как есть', () => {
    expect(toYandexLanguage('kk-KK')).toBe('kk-KK');
  });

  it('незнакомый код не выдумывает', () => {
    expect(toYandexLanguage('xx')).toBeUndefined();
  });
});
