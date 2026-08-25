import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';

import { messagesRaw } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { combineBatch } from '../buffer/buffer.service.js';
import type { ModelPricing } from '../metering/pricing.js';
import {
  finishStatus,
  showStatus,
  type StatusSender,
  type StatusTarget,
} from '../presenter/status.service.js';
import type { AudioLimits } from '../speech/audio.service.js';
import type { SpeechProvider } from '../speech/providers/types.js';
import { transcribeMessage } from '../speech/speech.service.js';
import { textProfileOf } from '../users/settings.repo.js';
import { textsFor } from '../../texts/index.js';
import type { BatchHandler } from './pipeline.service.js';

/**
 * Обработка выгрузки на первом этапе: расшифровать голосовые и склеить
 * текст (задача 1.15, подключение модуля speech к потоку сообщений).
 *
 * До этой задачи голосовое сохранялось, попадало в выгрузку данных, но
 * `transcript` оставался пустым, и склейка выдавала пустую строку.
 *
 * Порядок расшифровки — порядок получения сообщений: склейка сортирует
 * по тому же полю, и разойтись они не могут.
 *
 * Сбой расшифровки не глотается: выгрузка помечается сбойной целиком.
 * Альтернатива — пропустить нерасшифрованное сообщение и склеить
 * остальное — тише, но она молча теряет часть сказанного, а §9 ТЗ
 * запрещает терять сообщения. Сбойную выгрузку видно в админке, и её
 * можно перезапустить; потерянную половину мысли вернуть нельзя.
 */

export interface Stage1Deps {
  readonly provider: SpeechProvider;
  /** Скачивание отделено от расшифровки, чтобы тестировать без Telegram. */
  readonly download: (fileId: string, destPath: string) => Promise<void>;
  readonly language?: string | undefined;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
  readonly limits?: AudioLimits | undefined;
  readonly logger?: Logger | undefined;
  /** Отправитель статусного сообщения (задача 1.17). */
  readonly sender?: StatusSender | undefined;
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
async function statusTarget(db: Database, batchId: string): Promise<StatusTarget | undefined> {
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

export function createStage1Handler(deps: Stage1Deps): BatchHandler {
  return async (db, batch) => {
    const voices = await pendingVoices(db, batch.id);
    const target = deps.sender ? await statusTarget(db, batch.id) : undefined;
    const texts = textsFor(await textProfileOf(db, batch.userId));

    // Расшифровка идёт примерно в реальном времени: минутная запись
    // распознаётся около минуты. Молчать всё это время невежливо.
    if (deps.sender && target && voices.length > 0) {
      await showStatus({ db, sender: deps.sender }, target, texts.listening.working);
    }

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
        // §10.5 ТЗ: хвост длинной записи не обрабатывается. Пользователю
        // об этом скажет ответ на этапе 2, а в логе это видно уже сейчас.
        deps.logger?.warn(
          { batchId: batch.id, messageId: voice.id, durationSec: outcome.durationSec },
          'Запись длиннее потолка, хвост не расшифрован',
        );
      }
    }

    const combined = await combineBatch(db, batch.id);

    if (deps.sender && target) {
      await finishStatus(
        { db, sender: deps.sender },
        target,
        combined === '' ? texts.listening.nothingHeard : texts.listening.heard(combined),
      );
    }
  };
}
