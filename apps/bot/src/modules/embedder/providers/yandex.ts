import { ACCESS_DENIED_STATUSES, AccessDeniedError } from '../../../infra/failures.js';

import {
  PermanentEmbeddingError,
  TransientEmbeddingError,
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingProvider,
} from './types.js';

/**
 * Смысловые представления через Yandex Foundation Models (задача 2.9).
 *
 * Проверено живым вызовом 25.08.2026: 256 измерений, и у двух моделей
 * векторы для одного и того же текста разные — это и подтверждает, что
 * пространства разные и путать их нельзя.
 *
 * В плане изначально стояла модель OpenAI с 1536 измерениями. Колонка с
 * такой размерностью не сошлась бы с ответом, и выяснилось бы это на
 * первой же записи.
 */

export interface YandexEmbeddingOptions {
  readonly apiKey: string;
  /** Каталог обязателен: из него собирается modelUri. */
  readonly folderId: string;
  readonly baseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

const DEFAULT_BASE_URL = 'https://llm.api.cloud.yandex.net';

/** Столько измерений отдаёт Yandex. Совпадает с колонкой `items.embedding`. */
export const YANDEX_EMBEDDING_DIMENSIONS = 256;

/** Модель для записи и модель для поискового запроса — разные. */
const MODEL_BY_PURPOSE = {
  document: 'text-search-doc',
  query: 'text-search-query',
} as const;

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Счётчик токенов приходит строкой, как и у языковой модели. */
function toCount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class YandexEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'yandex:text-search';
  readonly dimensions = YANDEX_EMBEDDING_DIMENSIONS;

  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: YandexEmbeddingOptions) {
    if (options.apiKey.trim() === '') {
      throw new Error('YandexEmbeddingProvider: пустой ключ доступа');
    }
    if (options.folderId.trim() === '') {
      throw new Error('YandexEmbeddingProvider: не задан каталог, без него не собрать modelUri');
    }

    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
    this.doFetch = options.fetchImpl ?? fetch;
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const model = MODEL_BY_PURPOSE[request.purpose];

    if (request.text.trim() === '') {
      // Пустой текст не имеет смыслового представления, а вызов за него
      // всё равно оплачивается.
      throw new PermanentEmbeddingError('нечего представлять: пустой текст');
    }

    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}/foundationModels/v1/textEmbedding`, {
        method: 'POST',
        headers: {
          authorization: `Api-Key ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          modelUri: `emb://${this.options.folderId}/${model}/latest`,
          text: request.text,
        }),
      });
    } catch (error) {
      throw new TransientEmbeddingError('не удалось достучаться до модели представлений', error);
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw new TransientEmbeddingError('ответ модели представлений не дочитан', error);
    }

    if (!response.ok) {
      const message = `модель представлений ответила ${String(response.status)}: ${raw.slice(0, 300)}`;

      /**
       * Отказ в доступе — не про запрос, а про нас (задача 3.72).
       *
       * Тот же запрос с живым ключом пройдёт, поэтому хоронить из-за
       * него слова человека нельзя: выгрузка ждёт возвращения доступа.
       */
      if (ACCESS_DENIED_STATUSES.has(response.status)) {
        throw new AccessDeniedError(message);
      }

      throw TRANSIENT_STATUSES.has(response.status)
        ? new TransientEmbeddingError(message)
        : new PermanentEmbeddingError(message);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new PermanentEmbeddingError('модель представлений вернула не JSON', error);
    }

    const embedding = asRecord(payload)?.['embedding'];
    if (!Array.isArray(embedding)) {
      throw new PermanentEmbeddingError('в ответе нет вектора');
    }

    const vector = embedding.map((value) => Number(value));
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new PermanentEmbeddingError('вектор содержит не числа');
    }

    // Размерность сверяется явно. Разойдись она с колонкой — вставка
    // упала бы уже в базе, невнятно и посреди обработки чужой выгрузки.
    if (vector.length !== this.dimensions) {
      throw new PermanentEmbeddingError(
        `вектор длиной ${String(vector.length)}, а колонка на ${String(this.dimensions)}`,
      );
    }

    return {
      vector,
      model,
      tokens: toCount(asRecord(payload)?.['numTokens']),
    };
  }
}
