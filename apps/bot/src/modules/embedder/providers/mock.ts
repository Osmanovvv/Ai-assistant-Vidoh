import type { EmbedRequest, EmbedResult, EmbeddingProvider } from './types.js';
import { YANDEX_EMBEDDING_DIMENSIONS } from './yandex.js';

/**
 * Заглушка смысловых представлений для тестов и разработки (задача 2.9).
 *
 * Вектор считается детерминированно из текста: одинаковый текст даёт
 * одинаковый вектор, разный — разный. Этого достаточно, чтобы проверить
 * запись, чтение и поиск, не тратя чужие деньги на каждом прогоне.
 *
 * Осмысленной близости здесь нет и быть не может — её проверяет живая
 * модель на контрольном наборе. Тесты, которым нужна заданная близость,
 * передают векторы сами.
 */

export interface MockEmbeddingOptions {
  /** Своя логика, если тесту нужна заданная близость векторов. */
  readonly vectorFor?: (request: EmbedRequest) => readonly number[];
  readonly failFirst?: { readonly times: number; readonly error: Error };
  readonly dimensions?: number;
}

/**
 * Детерминированный вектор из текста.
 *
 * Простая свёртка по кодам символов, разнесённая по измерениям, затем
 * нормировка. Нормировка важна: косинусная близость в pgvector считается
 * по ненормированным векторам тоже, но с нормированными числа читаемые.
 */
function hashVector(text: string, dimensions: number): number[] {
  const raw = new Array<number>(dimensions).fill(0);

  for (let index = 0; index < text.length; index++) {
    const code = text.codePointAt(index) ?? 0;
    const slot = (code + index * 31) % dimensions;
    raw[slot] = (raw[slot] ?? 0) + ((code % 17) + 1);
  }

  const length = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  if (length === 0) return raw.map(() => 1 / Math.sqrt(dimensions));

  return raw.map((value) => value / length);
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock-embedding';
  readonly dimensions: number;

  private calls = 0;
  private readonly seen: EmbedRequest[] = [];

  constructor(private readonly options: MockEmbeddingOptions = {}) {
    this.dimensions = options.dimensions ?? YANDEX_EMBEDDING_DIMENSIONS;
  }

  get callCount(): number {
    return this.calls;
  }

  get requests(): readonly EmbedRequest[] {
    return this.seen;
  }

  embed(request: EmbedRequest): Promise<EmbedResult> {
    const index = this.calls;
    this.calls++;
    this.seen.push(request);

    const { failFirst } = this.options;
    if (failFirst && index < failFirst.times) {
      return Promise.reject(failFirst.error);
    }

    const vector = this.options.vectorFor?.(request) ?? hashVector(request.text, this.dimensions);

    return Promise.resolve({
      vector,
      // Модель называется по назначению: тесты проверяют, что для записи
      // и для поиска берутся разные.
      model: request.purpose === 'query' ? 'mock-query' : 'mock-doc',
      tokens: Math.max(1, Math.ceil(request.text.length / 4)),
    });
  }
}
