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

/** Ошибка, которую имеет смысл повторить: сеть, таймаут, перегрузка. */
export class TransientSpeechError extends Error {
  constructor(message: string, cause?: unknown) {
    // Штатный cause из ES2022: своё поле затенило бы его и сломало
    // вывод причины в логах и отладчиках.
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TransientSpeechError';
  }
}

/** Ошибка, которую повторять бессмысленно: битый файл, отказ в доступе. */
export class PermanentSpeechError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PermanentSpeechError';
  }
}
