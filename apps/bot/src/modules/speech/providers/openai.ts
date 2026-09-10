import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { markAlreadyPaid } from '../../../infra/failures.js';

import {
  PermanentSpeechError,
  TransientSpeechError,
  type SpeechProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './types.js';

/**
 * Расшифровка через OpenAI (задача 1.15).
 *
 * Обращение идёт на baseUrl, а не жёстко на api.openai.com: из России
 * сервис не отвечает, и запросы ходят через релей в Казахстане —
 * см. разбор ТЗ. Адрес задаётся переменной окружения.
 *
 * Ошибки делятся на временные и постоянные, чтобы повторять только то,
 * что имеет смысл повторять.
 */

export interface OpenAiSpeechOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'whisper-1';

/** Коды, при которых повтор имеет смысл. */
const TRANSIENT_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

interface TranscriptionResponse {
  readonly text?: unknown;
}

export class OpenAiSpeechProvider implements SpeechProvider {
  readonly name: string;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: OpenAiSpeechOptions) {
    if (options.apiKey.trim() === '') {
      throw new Error('OpenAiSpeechProvider: пустой ключ доступа');
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
    this.model = options.model ?? DEFAULT_MODEL;
    // В учёте расхода это поле становится названием модели, поэтому
    // одного «openai» недостаточно: модели стоят по-разному.
    this.name = `openai:${this.model}`;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const audio = await readFile(request.filePath);

    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), basename(request.filePath));
    form.append('model', this.model);
    if (request.language !== undefined) {
      form.append('language', request.language);
    }

    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        body: form,
      });
    } catch (error) {
      // Сеть не ответила: релей мог перезагружаться, это стоит повторить.
      throw new TransientSpeechError('не удалось достучаться до провайдера', error);
    }

    /**
     * Тело принято — за секунды заплачено (ревизия этапов 1–2).
     *
     * Whisper платит той же отправкой, что и SpeechKit. Пока об этом не
     * говорилось, любой отказ после принятого тела — включая пятисотый —
     * повторялся как бесплатный, и та же запись уезжала до трёх раз.
     *
     * Ровно здесь, а не выше: до ответа неизвестно, приняли ли тело,
     * и запретить повтор сетевому обрыву значило бы разучиться переживать
     * моргнувшую сеть.
     */
    request.onSent?.(Math.round(request.durationSec));

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const message = `провайдер ответил ${String(response.status)}: ${body.slice(0, 300)}`;

      // Отказ после принятого тела оплачен: повторять его отправкой
      // значит платить за ту же запись второй раз.
      const paid = { audioSeconds: Math.round(request.durationSec) };

      if (TRANSIENT_STATUSES.has(response.status)) {
        throw markAlreadyPaid(new TransientSpeechError(message), paid);
      }
      // 401, 403, 400: ключ, регион или сам файл. Повтор не поможет.
      throw markAlreadyPaid(new PermanentSpeechError(message), paid);
    }

    const payload = (await response.json()) as TranscriptionResponse;
    if (typeof payload.text !== 'string') {
      throw markAlreadyPaid(new PermanentSpeechError('провайдер вернул ответ без текста'), {
        audioSeconds: Math.round(request.durationSec),
      });
    }

    return {
      text: payload.text,
      model: this.model,
      audioSeconds: Math.round(request.durationSec),
    };
  }
}
