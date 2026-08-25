import { describe, expect, it } from 'vitest';

import { toVectorLiteral } from './embedder.service.js';
import { MockEmbeddingProvider } from './providers/mock.js';
import { PermanentEmbeddingError, TransientEmbeddingError } from './providers/types.js';
import { YANDEX_EMBEDDING_DIMENSIONS, YandexEmbeddingProvider } from './providers/yandex.js';

/**
 * Провайдер проверяется на подменённом fetch. Размерность и форма ответа
 * взяты из настоящего вызова 25.08.2026: 256 измерений, счётчик токенов
 * строкой.
 */

const options = { apiKey: 'ключ', folderId: 'b1g-каталог' };

const fullVector = (fill = 0.1): number[] =>
  Array.from({ length: YANDEX_EMBEDDING_DIMENSIONS }, () => fill);

function answering(vector: readonly number[], tokens = '10'): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ embedding: vector, numTokens: tokens }), { status: 200 }),
    );
}

describe('провайдер Yandex', () => {
  it('отдаёт вектор и число токенов', async () => {
    const provider = new YandexEmbeddingProvider({
      ...options,
      fetchImpl: answering(fullVector()),
    });

    const result = await provider.embed({ text: 'записаться к врачу', purpose: 'document' });

    expect(result.vector).toHaveLength(256);
    expect(result.tokens).toBe(10);
    expect(result.model).toBe('text-search-doc');
  });

  it('для записи и для поиска берёт разные модели', async () => {
    // У Яндекса это разные пространства. Перепутать их означает поиск,
    // который не падает, а тихо возвращает случайное.
    const captured: string[] = [];

    const provider = new YandexEmbeddingProvider({
      ...options,
      fetchImpl: ((_url: string, init: RequestInit) => {
        const body = typeof init.body === 'string' ? init.body : '{}';
        captured.push((JSON.parse(body) as { modelUri: string }).modelUri);
        return Promise.resolve(
          new Response(JSON.stringify({ embedding: fullVector(), numTokens: '1' }), {
            status: 200,
          }),
        );
      }) as unknown as typeof fetch,
    });

    await provider.embed({ text: 'дело', purpose: 'document' });
    await provider.embed({ text: 'дело', purpose: 'query' });

    expect(captured[0]).toBe('emb://b1g-каталог/text-search-doc/latest');
    expect(captured[1]).toBe('emb://b1g-каталог/text-search-query/latest');
  });

  it('размерность сверяется явно', async () => {
    // Разойдись она с колонкой — вставка упала бы уже в базе, невнятно
    // и посреди обработки чужой выгрузки.
    const provider = new YandexEmbeddingProvider({
      ...options,
      fetchImpl: answering([0.1, 0.2, 0.3]),
    });

    await expect(provider.embed({ text: 'дело', purpose: 'document' })).rejects.toThrow(
      /длиной 3, а колонка на 256/u,
    );
  });

  it('пустой текст не отправляется вовсе', async () => {
    // Смыслового представления у пустоты нет, а вызов оплачивается.
    let called = false;
    const provider = new YandexEmbeddingProvider({
      ...options,
      fetchImpl: () => {
        called = true;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });

    await expect(provider.embed({ text: '   ', purpose: 'document' })).rejects.toBeInstanceOf(
      PermanentEmbeddingError,
    );
    expect(called).toBe(false);
  });

  it('429 считается временной, 401 постоянной', async () => {
    const transient = new YandexEmbeddingProvider({
      ...options,
      fetchImpl: () => Promise.resolve(new Response('busy', { status: 429 })),
    });
    const permanent = new YandexEmbeddingProvider({
      ...options,
      fetchImpl: () => Promise.resolve(new Response('bad key', { status: 401 })),
    });

    await expect(transient.embed({ text: 'дело', purpose: 'document' })).rejects.toBeInstanceOf(
      TransientEmbeddingError,
    );
    await expect(permanent.embed({ text: 'дело', purpose: 'document' })).rejects.toBeInstanceOf(
      PermanentEmbeddingError,
    );
  });

  it('обрыв сети считается временной', async () => {
    const provider = new YandexEmbeddingProvider({
      ...options,
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    });

    await expect(provider.embed({ text: 'дело', purpose: 'document' })).rejects.toBeInstanceOf(
      TransientEmbeddingError,
    );
  });

  it('ответ без вектора и вектор не из чисел отвергаются', async () => {
    const noVector = new YandexEmbeddingProvider({
      ...options,
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ numTokens: '1' }))),
    });
    const notNumbers = new YandexEmbeddingProvider({
      ...options,
      fetchImpl: answering(['a', 'b'] as unknown as number[]),
    });

    await expect(noVector.embed({ text: 'д', purpose: 'document' })).rejects.toBeInstanceOf(
      PermanentEmbeddingError,
    );
    await expect(notNumbers.embed({ text: 'д', purpose: 'document' })).rejects.toBeInstanceOf(
      PermanentEmbeddingError,
    );
  });

  it('конструктор требует ключ и каталог', () => {
    expect(() => new YandexEmbeddingProvider({ apiKey: ' ', folderId: 'x' })).toThrow(/ключ/u);
    expect(() => new YandexEmbeddingProvider({ apiKey: 'k', folderId: ' ' })).toThrow(/каталог/u);
  });
});

describe('заглушка', () => {
  it('одинаковый текст даёт одинаковый вектор', async () => {
    const provider = new MockEmbeddingProvider();

    const first = await provider.embed({ text: 'купить кофе', purpose: 'document' });
    const second = await provider.embed({ text: 'купить кофе', purpose: 'document' });

    expect(first.vector).toEqual(second.vector);
  });

  it('разный текст даёт разный вектор', async () => {
    const provider = new MockEmbeddingProvider();

    const first = await provider.embed({ text: 'купить кофе', purpose: 'document' });
    const second = await provider.embed({ text: 'записаться к врачу', purpose: 'document' });

    expect(first.vector).not.toEqual(second.vector);
  });

  it('вектор нужной длины и нормированный', async () => {
    const provider = new MockEmbeddingProvider();

    const { vector } = await provider.embed({ text: 'дело', purpose: 'document' });
    const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

    expect(vector).toHaveLength(256);
    expect(length).toBeCloseTo(1, 6);
  });

  it('называет разные модели для записи и поиска', async () => {
    const provider = new MockEmbeddingProvider();

    expect((await provider.embed({ text: 'д', purpose: 'document' })).model).toBe('mock-doc');
    expect((await provider.embed({ text: 'д', purpose: 'query' })).model).toBe('mock-query');
  });
});

describe('toVectorLiteral', () => {
  it('собирает литерал для pgvector', () => {
    expect(toVectorLiteral([0.5, -0.25, 0])).toBe('[0.5,-0.25,0]');
  });

  it('не пропускает не-числа', () => {
    // Строка, попавшая в вектор, стала бы инъекцией в SQL: сам вектор
    // параметризовать нельзя, драйвер не знает типа vector.
    expect(() => toVectorLiteral(['0); drop table items;--'])).toThrow(/не число/u);
    expect(() => toVectorLiteral([null])).toThrow(/не число/u);
    expect(() => toVectorLiteral([Number.NaN])).toThrow(/не число/u);
    expect(() => toVectorLiteral([Number.POSITIVE_INFINITY])).toThrow(/не число/u);
  });
});
