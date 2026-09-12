import { describe, expect, it } from 'vitest';

import { YandexEmbeddingProvider, YANDEX_EMBEDDING_DIMENSIONS } from './yandex.js';

/**
 * Провайдер проверяется на подменённом fetch: живой вызов стоит денег.
 */
const options = { apiKey: 'ключ', folderId: 'b1g-каталог' };

function embeddingOf(length: number): Record<string, unknown> {
  return { embedding: Array.from({ length }, () => 0.1), numTokens: '7' };
}

describe('запрос к Yandex', () => {
  it('просит Yandex не сохранять содержание запроса (x-data-logging-enabled: false)', async () => {
    /**
     * В запросе на вектор — заголовок записи, то есть слова человека. По
     * умолчанию Yandex сохраняет данные запросов; заказчица 12.09.2026
     * решила логирование отключить, и политика конфиденциальности это
     * обещает.
     */
    let headers: Record<string, string> = {};

    const provider = new YandexEmbeddingProvider({
      ...options,
      fetchImpl: ((_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        return Promise.resolve(
          new Response(JSON.stringify(embeddingOf(YANDEX_EMBEDDING_DIMENSIONS)), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    });

    await provider.embed({ text: 'записать сына к врачу', purpose: 'document' });

    expect(headers['x-data-logging-enabled']).toBe('false');
  });
});
