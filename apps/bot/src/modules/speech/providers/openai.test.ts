import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OpenAiSpeechProvider } from './openai.js';
import { PermanentSpeechError, TransientSpeechError } from './types.js';

/**
 * Провайдер проверяется на подменённом fetch: живой вызов требует ключа
 * заказчика и стоит денег, а разбор ответов и классификация ошибок
 * от сети не зависят.
 */

let dir = '';
let filePath = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vydoh-openai-test-'));
  filePath = join(dir, 'part-00.wav');
  await writeFile(filePath, Buffer.from([0x52, 0x49, 0x46, 0x46]));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const request = () => ({ filePath, durationSec: 47.4, language: 'ru' });

function fetchReturning(status: number, body: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
}

describe('успешная расшифровка', () => {
  it('возвращает текст, модель и секунды аудио', async () => {
    const provider = new OpenAiSpeechProvider({
      apiKey: 'test-key',
      model: 'speech-model',
      fetchImpl: fetchReturning(200, { text: 'записать сына к врачу' }),
    });

    const result = await provider.transcribe(request());

    expect(result.text).toBe('записать сына к врачу');
    expect(result.model).toBe('speech-model');
    // Секунды округляются: расход считается по ним (§10.5 ТЗ).
    expect(result.audioSeconds).toBe(47);
  });

  it('отправляет ключ, модель, язык и файл', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const provider = new OpenAiSpeechProvider({
      apiKey: 'секретный-ключ',
      baseUrl: 'https://relay.example.test/v1/',
      model: 'speech-model',
      fetchImpl: ((url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return Promise.resolve(new Response(JSON.stringify({ text: 'ок' }), { status: 200 }));
      }) as unknown as typeof fetch,
    });

    await provider.transcribe(request());

    // Лишний слэш в baseUrl не должен превращаться в двойной в пути.
    expect(capturedUrl).toBe('https://relay.example.test/v1/audio/transcriptions');
    expect((capturedInit?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer секретный-ключ',
    );

    const form = capturedInit?.body as FormData;
    expect(form.get('model')).toBe('speech-model');
    expect(form.get('language')).toBe('ru');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('не отправляет язык, если он не задан', async () => {
    let form: FormData | undefined;
    const provider = new OpenAiSpeechProvider({
      apiKey: 'k',
      fetchImpl: ((_url: string, init: RequestInit) => {
        form = init.body as FormData;
        return Promise.resolve(new Response(JSON.stringify({ text: 'ок' }), { status: 200 }));
      }) as unknown as typeof fetch,
    });

    await provider.transcribe({ filePath, durationSec: 3 });

    expect(form?.get('language')).toBeNull();
  });
});

describe('классификация ошибок', () => {
  it('429 считается временной: повтор имеет смысл', async () => {
    const provider = new OpenAiSpeechProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning(429, { error: { message: 'rate limit' } }),
    });

    await expect(provider.transcribe(request())).rejects.toBeInstanceOf(TransientSpeechError);
  });

  it('503 считается временной', async () => {
    const provider = new OpenAiSpeechProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning(503, 'service unavailable'),
    });

    await expect(provider.transcribe(request())).rejects.toBeInstanceOf(TransientSpeechError);
  });

  it('401 считается постоянной: повтор не исправит ключ', async () => {
    const provider = new OpenAiSpeechProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning(401, { error: { message: 'invalid api key' } }),
    });

    await expect(provider.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });

  it('403 считается постоянной: регион не изменится от повтора', async () => {
    // Ровно тот случай, о котором предупреждали: OpenAI не работает
    // в юрисдикции заказчика, и ретраить это бессмысленно.
    const provider = new OpenAiSpeechProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning(403, { error: { message: 'country not supported' } }),
    });

    await expect(provider.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });

  it('400 считается постоянной', async () => {
    const provider = new OpenAiSpeechProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning(400, { error: { message: 'invalid file format' } }),
    });

    await expect(provider.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });

  it('обрыв сети считается временной', async () => {
    const provider = new OpenAiSpeechProvider({
      apiKey: 'k',
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    });

    await expect(provider.transcribe(request())).rejects.toBeInstanceOf(TransientSpeechError);
  });

  it('ответ без текста считается постоянной ошибкой', async () => {
    const provider = new OpenAiSpeechProvider({
      apiKey: 'k',
      fetchImpl: fetchReturning(200, { unexpected: true }),
    });

    await expect(provider.transcribe(request())).rejects.toBeInstanceOf(PermanentSpeechError);
  });
});

describe('конструктор', () => {
  it('отвергает пустой ключ', () => {
    expect(() => new OpenAiSpeechProvider({ apiKey: '   ' })).toThrow(/пустой ключ/u);
  });
});
