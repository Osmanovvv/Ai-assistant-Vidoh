import {
  PermanentLlmError,
  TransientLlmError,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
} from './types.js';

/**
 * Языковая модель через Yandex Foundation Models (задача 2.3).
 *
 * Форма запроса и ответа снята живыми вызовами 25.08.2026, а не взята из
 * документации. Проверялось главное: модель соблюдает строгую схему.
 * На трудном случае из контрольного набора — человек передумал в
 * следующем сообщении — она вернула одну задачу вместо двух
 * противоречащих, то есть на этой архитектуре можно строить разбор.
 *
 * Две особенности API, на которых легко споткнуться:
 *
 * 1. Схема передаётся полем `jsonSchema` в корне запроса, а не внутри
 *    `completionOptions`.
 * 2. Счётчики токенов приходят строками, а не числами.
 */

export interface YandexLlmOptions {
  readonly apiKey: string;
  /** Каталог обязателен: из него собирается modelUri. */
  readonly folderId: string;
  readonly model?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

const DEFAULT_BASE_URL = 'https://llm.api.cloud.yandex.net';
const DEFAULT_MODEL = 'yandexgpt/latest';
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_TOKENS = 4_000;

/** Коды HTTP, при которых повтор имеет смысл. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Счётчики токенов приходят строками: "inputTextTokens": "247". */
function toCount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class YandexLlmProvider implements LlmProvider {
  readonly name: string;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: YandexLlmOptions) {
    if (options.apiKey.trim() === '') {
      throw new Error('YandexLlmProvider: пустой ключ доступа');
    }
    if (options.folderId.trim() === '') {
      throw new Error('YandexLlmProvider: не задан каталог, без него не собрать modelUri');
    }

    this.model = options.model ?? DEFAULT_MODEL;
    // В учёте расхода это поле становится названием модели. Полная модель
    // и лёгкая стоят по-разному, и различать их обязательно.
    this.name = `yandex:${this.model}`;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
    this.doFetch = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body = {
      modelUri: `gpt://${this.options.folderId}/${this.model}`,
      completionOptions: {
        stream: false,
        temperature: request.temperature ?? DEFAULT_TEMPERATURE,
        maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
      // Схема в корне запроса, а не внутри completionOptions.
      jsonSchema: { schema: request.jsonSchema },
      messages: [
        { role: 'system', text: request.prompt },
        { role: 'user', text: request.input },
      ],
    };

    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}/foundationModels/v1/completion`, {
        method: 'POST',
        headers: {
          authorization: `Api-Key ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new TransientLlmError('не удалось достучаться до языковой модели', error);
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw new TransientLlmError('ответ модели не дочитан', error);
    }

    if (!response.ok) {
      const message = `модель ответила ${String(response.status)}: ${raw.slice(0, 300)}`;
      throw TRANSIENT_STATUSES.has(response.status)
        ? new TransientLlmError(message)
        : new PermanentLlmError(message);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new PermanentLlmError('модель вернула не JSON', error);
    }

    const result = asRecord(asRecord(payload)?.['result']);
    const alternatives = result?.['alternatives'];
    const first = Array.isArray(alternatives) ? asRecord(alternatives[0]) : undefined;
    const text = asRecord(first?.['message'])?.['text'];

    if (typeof text !== 'string') {
      throw new PermanentLlmError('в ответе модели нет текста');
    }

    // Обрезанный по лимиту токенов ответ — это заведомо неразбираемый
    // JSON. Повтор не поможет, помогает только больший лимит, поэтому
    // ошибка постоянная и с внятным текстом.
    const status = first?.['status'];
    if (status === 'ALTERNATIVE_STATUS_TRUNCATED_FINAL') {
      throw new PermanentLlmError(
        `ответ модели обрезан по лимиту токенов (${String(request.maxTokens ?? DEFAULT_MAX_TOKENS)})`,
      );
    }

    const usage = asRecord(result?.['usage']);

    return {
      text,
      model: this.model,
      tokensIn: toCount(usage?.['inputTextTokens']),
      tokensOut: toCount(usage?.['completionTokens']),
    };
  }
}
