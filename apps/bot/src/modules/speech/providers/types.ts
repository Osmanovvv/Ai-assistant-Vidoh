import { PermanentError, TransientError } from '../../../infra/failures.js';

/**
 * Провайдер расшифровки за интерфейсом (задача 1.15).
 *
 * Интерфейс здесь не абстракция ради абстракции. Выбранный провайдер
 * официально не работает в юрисдикции заказчика, и вероятность вынужденной
 * замены реальная — см. разбор ТЗ, пункт про OpenAI. Замена должна стоить
 * один файл, а не переписывание конвейера.
 */

export interface TranscriptionRequest {
  /** Путь к готовому файлу: моно 16 кГц WAV после prepareAudio. */
  readonly filePath: string;
  /** Подсказка языка. Помогает распознаванию русской речи. */
  readonly language?: string | undefined;
  readonly durationSec: number;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly model: string;
  /** Секунды аудио для учёта расхода (§10.5 ТЗ). */
  readonly audioSeconds: number;
}

export interface SpeechProvider {
  readonly name: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/**
 * Ошибки распознавания — частные случаи общих (см. infra/failures.ts).
 *
 * Отдельные классы нужны, чтобы в логе было видно, что сломалось именно
 * распознавание. Различение «повторять или нет» при этом остаётся общим
 * для всех внешних обращений, и конвейеру не приходится знать про каждый
 * провайдер отдельно.
 */
export class TransientSpeechError extends TransientError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'TransientSpeechError';
  }
}

export class PermanentSpeechError extends PermanentError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'PermanentSpeechError';
  }
}
