import { readFile } from 'node:fs/promises';

import {
  PermanentSpeechError,
  TransientSpeechError,
  type SpeechProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './types.js';

/**
 * Расшифровка через Yandex SpeechKit, API v3 (задача 1.15).
 *
 * Почему v3 и почему асинхронный вызов, а не синхронный: синхронное
 * распознавание v1 ограничено тридцатью секундами и мегабайтом, а части
 * после нарезки заметно длиннее. Вторая причина важнее: v1 отдаёт поток
 * слов без знаков препинания, а v3 возвращает нормализованный текст с
 * запятыми и точками — на этапе 2 модели разбирать его сильно легче.
 *
 * Формат запросов и ответов снят живыми вызовами 24.08.2026, а не взят
 * из документации: ответ getRecognition — это NDJSON, по одному событию
 * в строке, и в документации его форма описана неполно.
 */

export interface YandexSpeechOptions {
  readonly apiKey: string;
  /**
   * Каталог. Для ключа сервисного аккаунта не обязателен — каталог
   * определяется по владельцу ключа, — но заголовок принимается,
   * и с ним понятнее, куда идёт расход.
   */
  readonly folderId?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly operationsUrl?: string | undefined;
  readonly model?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly maxPollMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /** Пауза между опросами. Подменяется в тестах, чтобы не ждать по-настоящему. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const DEFAULT_BASE_URL = 'https://stt.api.cloud.yandex.net';
const DEFAULT_OPERATIONS_URL = 'https://operation.api.cloud.yandex.net';
const DEFAULT_MODEL = 'general';
const DEFAULT_POLL_INTERVAL_MS = 700;
const MAX_POLL_INTERVAL_MS = 3_000;

/**
 * Потолок ожидания результата.
 *
 * Число измерено, а не выбрано: живой прогон 24.08.2026 показал, что
 * восемьдесят секунд записи распознаются шестьдесят три секунды — почти
 * в реальном времени, а не в десять раз быстрее, как можно было бы
 * предположить. Потолок в полторы минуты стоял бы вплотную к норме, и
 * распознавание длинных частей срывалось бы на ровном месте под нагрузкой.
 * Отсюда четыре минуты — примерно втрое от замеренного.
 *
 * Держится ниже таймаута вызова из speech.service, чтобы причина отказа
 * была внятной: «распознавание не успело», а не безымянный таймаут снаружи.
 */
const DEFAULT_MAX_POLL_MS = 240_000;

/** Коды HTTP, при которых повтор имеет смысл. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Коды gRPC, при которых повтор имеет смысл: отмена, истёкший срок,
 * исчерпанная квота, конфликт, внутренняя ошибка, недоступность, потеря
 * данных. Остальное — ключ, права или сам файл, и повтор не поможет.
 */
const TRANSIENT_GRPC_CODES = new Set([1, 4, 8, 10, 13, 14, 15]);

/**
 * Коды языков SpeechKit. Выводить их по шаблону нельзя: русскому
 * соответствует ru-RU, а английскому en-US, а не en-EN.
 */
const LANGUAGE_CODES: Readonly<Record<string, string>> = {
  ru: 'ru-RU',
  en: 'en-US',
  kk: 'kk-KK',
  uz: 'uz-UZ',
  de: 'de-DE',
  tr: 'tr-TR',
};

interface JsonRequest {
  readonly method?: 'GET' | 'POST';
  readonly body?: string;
  readonly contentType?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** SpeechKit присылает целые числа строками: "finalIndex": "0". */
function toIndex(value: unknown): number {
  if (typeof value === 'number') return Number.isInteger(value) ? value : 0;
  if (typeof value !== 'string') return 0;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstAlternativeText(container: Record<string, unknown> | undefined): string | undefined {
  const alternatives = container?.['alternatives'];
  if (!Array.isArray(alternatives)) return undefined;
  return asString(asRecord(alternatives[0])?.['text']);
}

/**
 * Приводит код языка к виду, который понимает SpeechKit. Неизвестный код
 * лучше не выдумывать: без ограничения языка распознавание определит его
 * само, а неверный код привёл бы к отказу.
 */
export function toYandexLanguage(code: string): string | undefined {
  if (code.includes('-')) return code;
  return LANGUAGE_CODES[code.toLowerCase()];
}

/** Один распознанный отрезок речи. */
interface Utterance {
  /** Текст без пунктуации — приходит первым. */
  raw?: string;
  /** Нормализованный текст с пунктуацией — приходит следом, если включён. */
  normalized?: string;
}

/**
 * Разбор ответа getRecognition.
 *
 * Ответ — не один JSON, а поток событий по строкам: сначала `final` с
 * текстом без знаков, затем `finalRefinement` с нормализованным текстом,
 * затем `eouUpdate`. Длинная запись даёт несколько таких троек, они
 * различаются номером отрезка, поэтому склейка идёт по номеру, а не по
 * порядку строк.
 */
export function parseRecognition(body: string): string {
  const byIndex = new Map<number, Utterance>();

  const at = (index: number): Utterance => {
    const existing = byIndex.get(index);
    if (existing) return existing;
    const created: Utterance = {};
    byIndex.set(index, created);
    return created;
  };

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new PermanentSpeechError('SpeechKit вернул неразбираемую строку результата', error);
    }

    const result = asRecord(asRecord(parsed)?.['result']);
    if (!result) continue;

    const refinement = asRecord(result['finalRefinement']);
    if (refinement) {
      const text = firstAlternativeText(asRecord(refinement['normalizedText']));
      if (text !== undefined) at(toIndex(refinement['finalIndex'])).normalized = text;
      continue;
    }

    const final = asRecord(result['final']);
    if (final) {
      const text = firstAlternativeText(final);
      // У события final своего номера нет, он лежит в курсорах.
      const index = toIndex(asRecord(result['audioCursors'])?.['finalIndex']);
      if (text !== undefined) at(index).raw = text;
    }
  }

  return (
    [...byIndex.entries()]
      .sort(([left], [right]) => left - right)
      // Нормализованный текст предпочтительнее: он с пунктуацией.
      .map(([, utterance]) => (utterance.normalized ?? utterance.raw ?? '').trim())
      .filter((text) => text !== '')
      .join(' ')
  );
}

function operationFailure(error: Record<string, unknown>): Error {
  const message = asString(error['message']) ?? JSON.stringify(error).slice(0, 300);
  const code = error['code'];
  const transient = typeof code === 'number' && TRANSIENT_GRPC_CODES.has(code);

  return transient
    ? new TransientSpeechError(`распознавание не удалось: ${message}`)
    : new PermanentSpeechError(`распознавание не удалось: ${message}`);
}

export class YandexSpeechProvider implements SpeechProvider {
  readonly name: string;

  private readonly baseUrl: string;
  private readonly operationsUrl: string;
  private readonly model: string;
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;
  private readonly doFetch: typeof fetch;
  private readonly pause: (ms: number) => Promise<void>;

  constructor(private readonly options: YandexSpeechOptions) {
    if (options.apiKey.trim() === '') {
      throw new Error('YandexSpeechProvider: пустой ключ доступа');
    }

    this.model = options.model ?? DEFAULT_MODEL;
    // В учёте расхода это поле становится названием модели, поэтому
    // одного «yandex» недостаточно: general и deluxe стоят по-разному.
    this.name = `yandex:${this.model}`;

    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
    this.operationsUrl = (options.operationsUrl ?? DEFAULT_OPERATIONS_URL).replace(/\/+$/u, '');
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollMs = options.maxPollMs ?? DEFAULT_MAX_POLL_MS;
    this.doFetch = options.fetchImpl ?? fetch;
    this.pause =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const audio = await readFile(request.filePath);

    const operationId = await this.startRecognition(audio, request.language);
    await this.awaitOperation(operationId);
    const text = await this.fetchRecognition(operationId);

    return {
      text,
      model: this.model,
      audioSeconds: Math.round(request.durationSec),
    };
  }

  private async startRecognition(audio: Buffer, language: string | undefined): Promise<string> {
    const restriction = language === undefined ? undefined : toYandexLanguage(language);

    const body = {
      content: audio.toString('base64'),
      recognitionModel: {
        model: this.model,
        // Части после prepareAudio — WAV с заголовком, поэтому контейнер,
        // а не rawAudio: частоту и число каналов SpeechKit прочитает сам,
        // и рассинхрон настроек с ffmpeg становится невозможен.
        audioFormat: { containerAudio: { containerAudioType: 'WAV' } },
        // Нормализация — то, ради чего взят v3: она возвращает текст
        // с пунктуацией. Фильтр мата выключен намеренно: человек
        // выговаривается, и подменять его слова звёздочками нельзя.
        textNormalization: {
          textNormalization: 'TEXT_NORMALIZATION_ENABLED',
          profanityFilter: false,
          literatureText: true,
        },
        ...(restriction === undefined
          ? {}
          : {
              languageRestriction: {
                restrictionType: 'WHITELIST',
                languageCode: [restriction],
              },
            }),
        audioProcessingType: 'FULL_DATA',
      },
    };

    const payload = await this.requestJson(`${this.baseUrl}/stt/v3/recognizeFileAsync`, {
      method: 'POST',
      body: JSON.stringify(body),
      contentType: 'application/json',
    });

    const id = asString(asRecord(payload)?.['id']);
    if (id === undefined) {
      throw new PermanentSpeechError('SpeechKit не вернул идентификатор операции');
    }

    return id;
  }

  private async awaitOperation(operationId: string): Promise<void> {
    const deadline = Date.now() + this.maxPollMs;

    for (let attempt = 0; ; attempt++) {
      const url = `${this.operationsUrl}/operations/${encodeURIComponent(operationId)}`;
      const payload = asRecord(await this.requestJson(url));

      const failure = asRecord(payload?.['error']);
      if (failure) throw operationFailure(failure);
      if (payload?.['done'] === true) return;

      if (Date.now() >= deadline) {
        // Не сломалось, а не успело: повтор осмыслен.
        throw new TransientSpeechError(
          `SpeechKit не закончил распознавание за ${String(this.maxPollMs)} мс`,
        );
      }

      // Пауза растёт: короткая запись готова почти сразу, длинной частый
      // опрос ничем не помогает, а квоту на запросы расходует.
      await this.pause(Math.min(this.pollIntervalMs * 2 ** attempt, MAX_POLL_INTERVAL_MS));
    }
  }

  private async fetchRecognition(operationId: string): Promise<string> {
    const body = await this.requestText(
      `${this.baseUrl}/stt/v3/getRecognition?operationId=${encodeURIComponent(operationId)}`,
    );

    return parseRecognition(body);
  }

  private async requestText(url: string, request: JsonRequest = {}): Promise<string> {
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: request.method ?? 'GET',
        headers: {
          authorization: `Api-Key ${this.options.apiKey}`,
          ...(this.options.folderId === undefined ? {} : { 'x-folder-id': this.options.folderId }),
          ...(request.contentType === undefined ? {} : { 'content-type': request.contentType }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } catch (error) {
      throw new TransientSpeechError('не удалось достучаться до SpeechKit', error);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // Соединение оборвалось на середине ответа — это тоже сеть.
      throw new TransientSpeechError('ответ SpeechKit не дочитан', error);
    }

    if (!response.ok) {
      const message = `SpeechKit ответил ${String(response.status)}: ${text.slice(0, 300)}`;
      throw TRANSIENT_STATUSES.has(response.status)
        ? new TransientSpeechError(message)
        : new PermanentSpeechError(message);
    }

    return text;
  }

  private async requestJson(url: string, request: JsonRequest = {}): Promise<unknown> {
    const text = await this.requestText(url, request);

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new PermanentSpeechError('SpeechKit вернул не JSON', error);
    }
  }
}
