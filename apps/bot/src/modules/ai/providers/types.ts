import { PermanentError, TransientError } from '../../../infra/failures.js';

/**
 * Провайдер языковой модели за интерфейсом (задача 2.3).
 *
 * Интерфейс здесь не абстракция ради абстракции. На первом этапе провайдер
 * распознавания уже пришлось заменить: выбранный в ТЗ OpenAI в юрисдикции
 * заказчика официально не работает. С языковой моделью ровно та же история,
 * и замена должна стоить один файл.
 */

export interface CompletionRequest {
  /** Системная часть: собственно промпт из активной версии. */
  readonly prompt: string;
  /** Пользовательская часть: склеенный текст выгрузки. */
  readonly input: string;
  /** Схема ответа. Модель обязана вернуть строго её. */
  readonly jsonSchema: Record<string, unknown>;
  /**
   * Для структурных этапов температура близка к нулю: нам нужен разбор,
   * а не творчество. §10 ТЗ.
   */
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export interface CompletionResult {
  /** Ответ модели как есть, до разбора. */
  readonly text: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /**
   * Версия модели, которой ответил провайдер.
   *
   * Нужна потому, что `latest` — это ветка, а не модель: за ней стоит
   * поколение, которое Yandex однажды поменяет. От поколения зависят и
   * цена, и качество разбора, а мы мерили порог на конкретном. Пока
   * версия не писалась в учёт, смена поколения выглядела бы как
   * «модель вдруг стала хуже» и как расхождение расхода со счётом —
   * без единого способа связать одно с другим.
   */
  readonly modelVersion?: string | undefined;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Ошибки языковой модели — частные случаи общих (см. infra/failures.ts).
 * Отдельные классы нужны, чтобы в логе было видно, что сломалось именно
 * обращение к модели.
 */
export class TransientLlmError extends TransientError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'TransientLlmError';
  }
}

export class PermanentLlmError extends PermanentError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'PermanentLlmError';
  }
}
