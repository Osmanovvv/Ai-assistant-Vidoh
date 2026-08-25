import { PermanentError, TransientError } from '../../../infra/failures.js';

/**
 * Провайдер смысловых представлений за интерфейсом (задача 2.9).
 *
 * §7.2 ТЗ требует смыслового поиска: чтобы понять, о какой записи человек
 * говорит «а, и ещё про врача», сравнения по словам недостаточно.
 *
 * Две модели, а не одна. У Yandex вектор записи считает `text-search-doc`,
 * а вектор поискового запроса — `text-search-query`, и это разные
 * пространства. Перепутать их означает поиск, который не падает и не
 * ругается, а просто тихо возвращает случайное — худший вид поломки.
 */

/** Для чего считаем вектор: для хранения или для поиска. */
export type EmbeddingPurpose = 'document' | 'query';

export interface EmbedRequest {
  readonly text: string;
  readonly purpose: EmbeddingPurpose;
}

export interface EmbedResult {
  readonly vector: readonly number[];
  readonly model: string;
  readonly tokens: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  /** Сколько измерений отдаёт провайдер. Должно совпадать с колонкой. */
  readonly dimensions: number;
  embed(request: EmbedRequest): Promise<EmbedResult>;
}

export class TransientEmbeddingError extends TransientError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'TransientEmbeddingError';
  }
}

export class PermanentEmbeddingError extends PermanentError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'PermanentEmbeddingError';
  }
}
