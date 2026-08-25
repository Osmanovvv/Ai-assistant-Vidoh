import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';

import { messagesRaw, type Batch } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { combineBatch } from '../buffer/buffer.service.js';
import type { ModelPricing } from '../metering/pricing.js';
import type { StatusTarget } from '../presenter/status.service.js';
import type { AudioLimits } from '../speech/audio.service.js';
import type { SpeechProvider } from '../speech/providers/types.js';
import { transcribeMessage } from '../speech/speech.service.js';

/**
 * Расшифровка голосовых выгрузки и склейка её текста (задача 1.15).
 *
 * Вынесено из обработчика выгрузки отдельным файлом на связке цепочки:
 * обработчик стал делать две разные работы — слушать и понимать, — и
 * держать их в одном файле значило бы, что правку в разборе приходится
 * делать, читая расшифровку, и наоборот.
 *
 * Порядок расшифровки — порядок получения сообщений: склейка сортирует по
 * тому же полю, и разойтись они не могут.
 *
 * Сбой расшифровки не глотается: выгрузка помечается сбойной целиком.
 * Альтернатива — пропустить нерасшифрованное сообщение и склеить
 * остальное — тише, но она молча теряет часть сказанного, а §9 ТЗ
 * запрещает терять сообщения.
 */

export interface TranscribeDeps {
  readonly provider: SpeechProvider;
  /** Скачивание отделено от расшифровки, чтобы тестировать без Telegram. */
  readonly download: (fileId: string, destPath: string) => Promise<void>;
  readonly language?: string | undefined;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
  readonly limits?: AudioLimits | undefined;
  readonly logger?: Logger | undefined;
}

/** Голосовые выгрузки, которые ещё не расшифрованы. */
async function pendingVoices(
  db: Database,
  batchId: string,
): Promise<readonly { id: string; fileId: string }[]> {
  const rows = await db
    .select({ id: messagesRaw.id, fileId: messagesRaw.fileId })
    .from(messagesRaw)
    .where(
      and(
        eq(messagesRaw.batchId, batchId),
        isNotNull(messagesRaw.fileId),
        // Повторный заход не должен расшифровывать заново: это чужие
        // деньги, а после сбоя посреди выгрузки заход будет повторным.
        isNull(messagesRaw.transcript),
      ),
    )
    .orderBy(asc(messagesRaw.receivedAt), asc(messagesRaw.tgMessageId));

  // Условие isNotNull уже отсеяло пустые ссылки, но типу об этом
  // неизвестно, и заявлять это утверждением было бы обманом.
  return rows.flatMap((row) => (row.fileId === null ? [] : [{ id: row.id, fileId: row.fileId }]));
}

/**
 * Куда отвечать. В самой выгрузке чата нет, он есть у её сообщений —
 * и это правильно: выгрузка принадлежит человеку, а не чату.
 */
export async function statusTarget(
  db: Database,
  batchId: string,
): Promise<StatusTarget | undefined> {
  const [row] = await db
    .select({ chatId: messagesRaw.tgChatId, threadId: messagesRaw.tgThreadId })
    .from(messagesRaw)
    .where(eq(messagesRaw.batchId, batchId))
    .orderBy(asc(messagesRaw.receivedAt))
    .limit(1);

  if (!row) return undefined;

  return {
    batchId,
    chatId: row.chatId,
    threadId: row.threadId ?? undefined,
  };
}

export interface TranscribeOptions {
  /**
   * Вызывается один раз перед первой расшифровкой, и только если
   * голосовые есть. Расшифровка идёт примерно в реальном времени:
   * минутная запись распознаётся около минуты, и молчать всё это время
   * невежливо.
   */
  readonly onStart?: (() => Promise<void>) | undefined;
}

export interface TranscribeResult {
  /** Склеенный текст всей выгрузки: расшифровки и тексты по порядку. */
  readonly combined: string;
  readonly voices: number;
}

export async function transcribeBatch(
  db: Database,
  batch: Batch,
  deps: TranscribeDeps,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const voices = await pendingVoices(db, batch.id);

  if (voices.length > 0) await options.onStart?.();

  for (const voice of voices) {
    const outcome = await transcribeMessage(
      {
        db,
        provider: deps.provider,
        download: deps.download,
        language: deps.language,
        pricing: deps.pricing,
        limits: deps.limits,
      },
      {
        messageId: voice.id,
        fileId: voice.fileId,
        userId: batch.userId,
        batchId: batch.id,
      },
    );

    if (outcome.truncated) {
      // §10.5 ТЗ: хвост длинной записи не обрабатывается. В логе это
      // видно, а человеку об этом скажет ответ.
      deps.logger?.warn(
        { batchId: batch.id, messageId: voice.id, durationSec: outcome.durationSec },
        'Запись длиннее потолка, хвост не расшифрован',
      );
    }
  }

  return { combined: await combineBatch(db, batch.id), voices: voices.length };
}
