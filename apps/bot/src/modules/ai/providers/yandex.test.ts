import { describe, expect, it } from 'vitest';

import { PermanentLlmError, TransientLlmError } from './types.js';
import { YandexLlmProvider } from './yandex.js';

/**
 * Провайдер проверяется на подменённом fetch: живой вызов стоит денег и
 * зависит от сети, а форма запроса и разбор ответа — нет.
 *
 * Образец ответа взят из настоящего вызова 25.08.2026: счётчики токенов
 * там приходят строками, и на выдуманном образце эта деталь потерялась бы.
 */

const request = () => ({
  prompt: 'Разбери поток мыслей на дела.',
  input: 'надо к врачу и купить продукты',
  jsonSchema: { type: 'object', properties: { units: { type: 'array' } } },
});

function answering(text: string, extra: Record<string, unknown> = {}) {
  return {
    result: {
      alternatives: [
        { message: { role: 'assistant', text }, status: 'ALTERNATIVE_STATUS_FINAL', ...extra },
      ],
      usage: { inputTextTokens: '247', completionTokens: '582', totalTokens: '829' },
      modelVersion: '25.08.2026',
    },
  };
}

function fetchReturning(status: number, body: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
}

const options = { apiKey: 'ключ', folderId: 'b1g-каталог' };

/** Тело отправленного запроса. Мы всегда посылаем строку JSON. */
function sentBody(init: RequestInit): Record<string, unknown> {
  const body = init.body;
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>;
}

describe('успешный вызов', () => {
  it('отдаёт текст ответа и счётчики токенов', async () => {
    const provider = new YandexLlmProvider({
      ...options,
      fetchImpl: fetchReturning(200, answering('{"units":[]}')),
    });

    const result = await provider.complete(request());

    expect(result.text).toBe('{"units":[]}');
    // Счётчики приходят строками — если не преобразовать, себестоимость
    // посчитается по строке и даст ноль.
    expect(result.tokensIn).toBe(247);
    expect(result.tokensOut).toBe(582);
    expect(result.model).toBe('yandexgpt/latest');
  });

  it('собирает modelUri из каталога и модели', async () => {
    let captured: Record<string, unknown> = {};

    const provider = new YandexLlmProvider({
      ...options,
      model: 'yandexgpt-lite/latest',
      fetchImpl: ((url: string, init: RequestInit) => {
        captured = sentBody(init);
        expect(url).toBe('https://llm.api.cloud.yandex.net/foundationModels/v1/completion');
        return Promise.resolve(new Response(JSON.stringify(answering('{}')), { status: 200 }));
      }) as unknown as typeof fetch,
    });

    await provider.complete(request());

    expect(captured['modelUri']).toBe('gpt://b1g-каталог/yandexgpt-lite/latest');
  });

  it('передаёт схему полем jsonSchema в корне запроса', async () => {
    // Не внутри completionOptions: на этом легко споткнуться, и тогда
    // модель отвечает свободным текстом, а схема молча не действует.
    let captured: Record<string, unknown> = {};

    const provider = new YandexLlmProvider({
      ...options,
      fetchImpl: ((_url: string, init: RequestInit) => {
        captured = sentBody(init);
        return Promise.resolve(new Response(JSON.stringify(answering('{}')), { status: 200 }));
      }) as unknown as typeof fetch,
    });

    await provider.complete(request());

    expect(captured['jsonSchema']).toEqual({ schema: request().jsonSchema });
    expect(captured['completionOptions']).not.toHaveProperty('jsonSchema');
  });

  it('температура по умолчанию близка к нулю: нужен разбор, а не творчество', async () => {
    let captured: Record<string, unknown> = {};

    const provider = new YandexLlmProvider({
      ...options,
      fetchImpl: ((_url: string, init: RequestInit) => {
        captured = sentBody(init);
        return Promise.resolve(new Response(JSON.stringify(answering('{}')), { status: 200 }));
      }) as unknown as typeof fetch,
    });

    await provider.complete(request());

    const opts = captured['completionOptions'] as { temperature: number; stream: boolean };
    expect(opts.temperature).toBeLessThanOrEqual(0.2);
    expect(opts.stream).toBe(false);
  });

  it('передаёт промпт системным сообщением, а выгрузку — пользовательским', async () => {
    let captured: Record<string, unknown> = {};

    const provider = new YandexLlmProvider({
      ...options,
      fetchImpl: ((_url: string, init: RequestInit) => {
        captured = sentBody(init);
        return Promise.resolve(new Response(JSON.stringify(answering('{}')), { status: 200 }));
      }) as unknown as typeof fetch,
    });

    await provider.complete(request());

    expect(captured['messages']).toEqual([
      { role: 'system', text: 'Разбери поток мыслей на дела.' },
      { role: 'user', text: 'надо к врачу и купить продукты' },
    ]);
  });

  it('название модели попадает в имя провайдера: модели стоят по-разному', () => {
    expect(new YandexLlmProvider(options).name).toBe('yandex:yandexgpt/latest');
    expect(new YandexLlmProvider({ ...options, model: 'yandexgpt-lite/latest' }).name).toBe(
      'yandex:yandexgpt-lite/latest',
    );
  });
});

describe('классификация ошибок', () => {
  it('429 считается временной', async () => {
    const provider = new YandexLlmProvider({
      ...options,
      fetchImpl: fetchReturning(429, 'too many requests'),
    });

    await expect(provider.complete(request())).rejects.toBeInstanceOf(TransientLlmError);
  });

  it('503 считается временной', async () => {
    const provider = new YandexLlmProvider({
      ...options,
      fetchImpl: fetchReturning(503, 'unavailable'),
    });

    await expect(provider.complete(request())).rejects.toBeInstanceOf(TransientLlmError);
  });

  it('401 считается постоянной: повтор не исправит ключ', async () => {
    const provider = new YandexLlmProvider({
      ...options,
      fetchImpl: fetchReturning(401, { code: 16, message: 'Unknown api key' }),
    });

    await expect(provider.complete(request())).rejects.toBeInstanceOf(PermanentLlmError);
  });

  it('обрыв сети считается временной', async () => {
    const provider = new YandexLlmProvider({
      ...options,
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    });

    await expect(provider.complete(request())).rejects.toBeInstanceOf(TransientLlmError);
  });

  it('обрезанный по лимиту токенов ответ отвергается сразу', async () => {
    // Такой JSON заведомо не разберётся. Повтор не поможет — поможет
    // только больший лимит, и об этом надо сказать прямо.
    const provider = new YandexLlmProvider({
      ...options,
      fetchImpl: fetchReturning(
        200,
        answering('{"units":[{"text":"нед', { status: 'ALTERNATIVE_STATUS_TRUNCATED_FINAL' }),
      ),
    });

    await expect(provider.complete(request())).rejects.toThrow(/обрезан по лимиту токенов/u);
  });

  it('ответ без текста считается постоянной ошибкой', async () => {
    const provider = new YandexLlmProvider({
      ...options,
      fetchImpl: fetchReturning(200, { result: { alternatives: [] } }),
    });

    await expect(provider.complete(request())).rejects.toBeInstanceOf(PermanentLlmError);
  });

  it('ответ не в JSON считается постоянной ошибкой', async () => {
    // Так выглядит страница-заглушка от посредника вместо ответа модели.
    const provider = new YandexLlmProvider({
      ...options,
      fetchImpl: fetchReturning(200, '<html>прокси</html>'),
    });

    await expect(provider.complete(request())).rejects.toBeInstanceOf(PermanentLlmError);
  });
});

describe('конструктор', () => {
  it('отвергает пустой ключ', () => {
    expect(() => new YandexLlmProvider({ apiKey: '   ', folderId: 'x' })).toThrow(/пустой ключ/u);
  });

  it('отвергает пустой каталог: без него не собрать modelUri', () => {
    expect(() => new YandexLlmProvider({ apiKey: 'k', folderId: '  ' })).toThrow(/каталог/u);
  });
});
