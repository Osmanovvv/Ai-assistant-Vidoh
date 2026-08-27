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

/**
 * Слово с его временем от начала файла.
 *
 * Нужно для склейки голосовых одной выгрузки в один запрос (задача 1.14):
 * без времён склеенный текст не разложить обратно по сообщениям, и
 * экономия на округлении блоков стоила бы потерей того, кто что сказал
 * и в каком сообщении.
 */
export interface TimedWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Распознанная фраза: текст целиком и слова со временами.
 *
 * Две формы нужны обе. Пунктуация и заглавные буквы есть только у текста
 * фразы — в словах приходят голые токены с маленькой буквы. А времена есть
 * только у слов. Поэтому склейка раскладывает по сообщениям фразы, и лишь
 * фразу, перескочившую границу, приходится делить по словам.
 */
export interface RecognizedUtterance {
  readonly text: string;
  readonly words: readonly TimedWord[];
}

export interface TranscriptionResult {
  readonly text: string;
  readonly model: string;
  /** Секунды аудио для учёта расхода (§10.5 ТЗ). */
  readonly audioSeconds: number;
  /**
   * Фразы со временами, если распознаватель их вернул. Провайдер, который
   * их не отдаёт, остаётся полноценным — склейка просто не применяется.
   */
  readonly utterances?: readonly RecognizedUtterance[] | undefined;
}

export interface SpeechProvider {
  readonly name: string;
  /**
   * Возвращает ли провайдер времена слов. Только при true выгрузку можно
   * расшифровывать одним запросом на все голосовые: иначе текст не
   * разложить по сообщениям.
   */
  readonly timeline?: boolean | undefined;
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
