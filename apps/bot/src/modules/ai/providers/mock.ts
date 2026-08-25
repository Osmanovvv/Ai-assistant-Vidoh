import type { CompletionRequest, CompletionResult, LlmProvider } from './types.js';

/**
 * Заглушка языковой модели для тестов и разработки без ключа (задача 2.3).
 *
 * Не мелочь: без неё интеграционные тесты разбора недетерминированы и
 * жгут бюджет заказчика на каждом прогоне. Ответы задаются списком или
 * функцией, поэтому воспроизводимы и успех, и невалидный ответ, и отказ.
 */

export interface MockLlmOptions {
  /** Готовые ответы по порядку вызовов. Строка — это то, что «сказала» модель. */
  readonly responses?: readonly string[];
  /** Или произвольная логика, если ответ зависит от запроса. */
  readonly respond?: (request: CompletionRequest, callIndex: number) => string;
  /** Сколько первых вызовов должны упасть заданной ошибкой. */
  readonly failFirst?: { readonly times: number; readonly error: Error };
  readonly model?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

export class MockLlmProvider implements LlmProvider {
  readonly name: string;
  private calls = 0;
  private readonly seen: CompletionRequest[] = [];

  constructor(private readonly options: MockLlmOptions = {}) {
    this.name = options.model ?? 'mock-llm';
  }

  /** Сколько раз обращались к модели. Нужно тестам на повторы. */
  get callCount(): number {
    return this.calls;
  }

  /** Запросы целиком: тесты проверяют, что промпт и схема доехали. */
  get requests(): readonly CompletionRequest[] {
    return this.seen;
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    const index = this.calls;
    this.calls++;
    this.seen.push(request);

    const { failFirst } = this.options;
    if (failFirst && index < failFirst.times) {
      return Promise.reject(failFirst.error);
    }

    const text =
      this.options.respond?.(request, index) ??
      this.options.responses?.[index] ??
      // Пустой разбор — безопасное поведение по умолчанию: тест, который
      // не задал ответ, не должен случайно получить осмысленные данные.
      '{"units":[]}';

    return Promise.resolve({
      text,
      model: this.name,
      tokensIn: this.options.tokensIn ?? 100,
      tokensOut: this.options.tokensOut ?? 50,
    });
  }
}
