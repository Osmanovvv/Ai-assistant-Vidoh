import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import { messagesRaw } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { meterCall } from '../metering/ai-calls.repo.js';
import type { ModelPricing } from '../metering/pricing.js';
import {
  DEFAULT_AUDIO_LIMITS,
  prepareAudio,
  withTempDir,
  type AudioLimits,
} from './audio.service.js';
import type { SpeechProvider } from './providers/types.js';
import { withRetry, withTimeout, type RetryOptions } from './retry.js';

/**
 * Расшифровка голосового (задача 1.15).
 *
 * Порядок шагов задан §16 и §10.5 ТЗ: скачали во временную папку,
 * порезали по паузам, расшифровали части, склеили, сохранили текст,
 * удалили всё лишнее. Папка удаляется в любом случае, включая сбой.
 *
 * Каждое обращение к провайдеру проходит через учёт расхода: §10.5
 * требует записывать и неуспешные вызовы тоже.
 */

export interface TranscribeDeps {
  readonly db: Database;
  readonly provider: SpeechProvider;
  /** Скачивание отделено от расшифровки, чтобы тестировать без Telegram. */
  readonly download: (fileId: string, destPath: string) => Promise<void>;
  readonly limits?: AudioLimits | undefined;
  readonly retry?: RetryOptions | undefined;
  readonly timeoutMs?: number | undefined;
  readonly language?: string | undefined;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
}

export interface TranscribeParams {
  readonly messageId: string;
  readonly fileId: string;
  readonly userId: string;
  readonly batchId?: string | undefined;
}

export interface TranscribeOutcome {
  readonly text: string;
  readonly parts: number;
  /** Запись была длиннее потолка, хвост не расшифрован (§10.5 ТЗ). */
  readonly truncated: boolean;
  readonly durationSec: number;
}

/**
 * Таймаут на одну часть. Заведомо больше собственного потолка ожидания
 * у провайдера: тогда при затянувшемся распознавании сработает его
 * проверка с внятным сообщением, а не безымянный таймаут отсюда.
 *
 * Величина взята из замера: восемьдесят секунд записи распознаются
 * шестьдесят три секунды (живой прогон SpeechKit 24.08.2026). Часть
 * длиннее восьмидесяти двух секунд не бывает — см. MAX_SEGMENT_SEC.
 */
const DEFAULT_TIMEOUT_MS = 300_000;

export async function transcribeMessage(
  deps: TranscribeDeps,
  params: TranscribeParams,
): Promise<TranscribeOutcome> {
  const limits = deps.limits ?? DEFAULT_AUDIO_LIMITS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const outcome = await withTempDir(async (dir): Promise<TranscribeOutcome> => {
    const sourcePath = join(dir, 'source');
    await deps.download(params.fileId, sourcePath);

    const prepared = await prepareAudio(sourcePath, dir, limits);

    const texts: string[] = [];
    for (const part of prepared.parts) {
      const text = await meterCall(
        deps.db,
        {
          stage: 'speech',
          model: deps.provider.name,
          userId: params.userId,
          batchId: params.batchId,
        },
        async () => {
          const result = await withRetry(
            () =>
              withTimeout(
                () =>
                  deps.provider.transcribe({
                    filePath: part.path,
                    durationSec: part.endSec - part.startSec,
                    language: deps.language,
                  }),
                timeoutMs,
                'расшифровка',
              ),
            deps.retry ?? {},
          );

          return {
            value: result.text,
            usage: { audioSeconds: result.audioSeconds },
          };
        },
        { pricing: deps.pricing },
      );

      texts.push(text.trim());
    }

    return {
      text: texts.filter((part) => part !== '').join(' '),
      parts: prepared.parts.length,
      truncated: prepared.truncated,
      durationSec: prepared.durationSec,
    };
  });

  // Расшифровка получена — ссылка на файл больше не нужна (§16 ТЗ).
  await deps.db
    .update(messagesRaw)
    .set({ transcript: outcome.text, fileId: null })
    .where(eq(messagesRaw.id, params.messageId));

  return outcome;
}
