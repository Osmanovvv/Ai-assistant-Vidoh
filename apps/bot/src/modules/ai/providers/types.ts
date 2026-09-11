import type { AiStage } from '../../../db/schema.js';
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
  /**
   * Этап, от имени которого спрашивают модель.
   *
   * Живому провайдеру он не нужен — в запрос к модели не уходит. Нужен
   * записи ответов (задача 3.80): в её файле у каждой строки стоит этап,
   * чтобы промахи разбирались по этапам. Прежде запись угадывала его по
   * `title` схемы, а схема боя имени не несёт — и каждая строка получала
   * «неизвестный». Обязательное поле вместо догадки: забыть его нельзя.
   */
  readonly stage: AiStage;
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

  /**
   * Отмена запроса по таймауту (задача 3.81).
   *
   * Без него мы переставали ждать, а генерация продолжалась и
   * оплачивалась: при трёх попытках повтора один вызов мог стоить трёх
   * ответов. Необязателен, потому что провайдеры-заглушки его не ждут.
   */
  readonly signal?: AbortSignal | undefined;
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
