import { basename } from 'node:path';

import type { SpeechProvider, TranscriptionRequest, TranscriptionResult } from './types.js';

/**
 * Заглушка расшифровки для тестов и разработки без ключа.
 *
 * Без неё интеграционные тесты конвейера были бы недетерминированы и
 * жгли бы бюджет заказчика. Поведение задаётся списком ответов или
 * функцией, поэтому в тесте можно воспроизвести и успех, и сбой.
 */
export interface MockSpeechOptions {
  /** Фиксированные ответы по порядку вызовов. */
  readonly responses?: readonly string[];
  /** Или произвольная логика, если ответ зависит от запроса. */
  readonly respond?: (request: TranscriptionRequest, callIndex: number) => string;
  /** Сколько первых вызовов должны упасть заданной ошибкой. */
  readonly failFirst?: { readonly times: number; readonly error: Error };
  readonly model?: string;
  readonly delayMs?: number;
}

export class MockSpeechProvider implements SpeechProvider {
  readonly name = 'mock';
  private calls = 0;

  constructor(private readonly options: MockSpeechOptions = {}) {}

  /** Сколько раз провайдер вызывали. Нужно тестам на повторы. */
  get callCount(): number {
    return this.calls;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const index = this.calls;
    this.calls++;

    if (this.options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }

    const { failFirst } = this.options;
    if (failFirst && index < failFirst.times) {
      throw failFirst.error;
    }

    const text =
      this.options.respond?.(request, index) ??
      this.options.responses?.[index] ??
      `расшифровка ${basename(request.filePath)}`;

    return {
      text,
      model: this.options.model ?? 'mock-speech',
      audioSeconds: Math.round(request.durationSec),
    };
  }
}
