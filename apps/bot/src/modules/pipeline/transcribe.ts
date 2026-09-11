import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';

import { messagesRaw, type Batch } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { combineBatch } from '../buffer/buffer.service.js';
import type { ModelPricing } from '../metering/pricing.js';
import type { SpendGuard } from '../metering/spend-guard.js';
import type { StatusTarget } from '../presenter/status.service.js';
import type { AudioLimits } from '../speech/audio.service.js';
import type { SpeechProvider } from '../speech/providers/types.js';
import {
  GlueAbortedError,
  transcribeMessage,
  transcribeVoices,
  type VoicesOutcome,
} from '../speech/speech.service.js';

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
  /**
   * Потолок расхода (задача 3.79). Не задан — ничего не меняется.
   *
   * Речь стоит денег того же счёта, и при перейдённом потолке платить за
   * расшифровку, чтобы потом отказать на разборе, — худшее из решений:
   * деньги ушли, ответа нет.
   */
  readonly spendGuard?: SpendGuard | undefined;
  readonly limits?: AudioLimits | undefined;
  readonly logger?: Logger | undefined;
}

/** Голосовые выгрузки, которые ещё не расшифрованы. */
async function pendingVoices(
  db: Database,
  batchId: string,
): Promise<readonly { id: string; fileId: string; durationSec: number }[]> {
  const rows = await db
    .select({
      id: messagesRaw.id,
      fileId: messagesRaw.fileId,
      durationSec: messagesRaw.audioDurationSec,
    })
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
  //
  // Длительность нужна раскладке по запросам. Её может не быть — Telegram
  // присылает её для голосовых всегда, но пересланное аудио бывает и без
  // неё. Тогда бесконечность: запись не попадёт ни в одну группу и уйдёт
  // прежним путём. Догадываться о длине файла, чтобы сэкономить рубль,
  // дороже, чем не экономить.
  return rows.flatMap((row) =>
    row.fileId === null
      ? []
      : [
          {
            id: row.id,
            fileId: row.fileId,
            durationSec: row.durationSec ?? Number.POSITIVE_INFINITY,
          },
        ],
  );
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
  /**
   * Сколько запросов к распознавателю дали расшифровку.
   *
   * Сорвавшийся запрос склейки сюда не входит: его текст выброшен, а
   * деньги за него считает учёт расхода, где каждая отправка — своя
   * строка. Число это читают одни тесты.
   */
  readonly requests: number;
  /**
   * Часть сказанного не расшифрована: запись длиннее десяти минут или
   * выгрузка длиннее двадцати (§10.5 ТЗ).
   *
   * До 27.08.2026 этот факт уходил только в журнал, и человек о нём не
   * узнавал. §10.5 требует предупреждения, и требует справедливо.
   */
  readonly truncated: boolean;
}

/**
 * Можно ли расшифровать все голосовые одним запросом.
 *
 * Два условия. Провайдер обязан отдавать времена слов — иначе склеенный
 * текст не разложить обратно по сообщениям. И голосовых должно быть больше
 * одного: на единственной записи склейка не экономит ничего, а лишний
 * проход конвертации делает.
 */
function canGlue(provider: SpeechProvider, voices: number): boolean {
  return provider.timeline === true && voices > 1;
}

export async function transcribeBatch(
  db: Database,
  batch: Batch,
  deps: TranscribeDeps,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const voices = await pendingVoices(db, batch.id);

  if (voices.length > 0) await options.onStart?.();

  const speech = {
    db,
    provider: deps.provider,
    download: deps.download,
    language: deps.language,
    pricing: deps.pricing,
    spendGuard: deps.spendGuard,
    limits: deps.limits,
    // Нужен одному замеру паузы (задача 3.59, шаг 1): поведение не
    // меняется, числа идут только в журнал.
    logger: deps.logger,
  };

  let truncated = false;

  /** Расшифровка по одному сообщению: путь на единственную запись и откат. */
  const onePerMessage = async (list: typeof voices): Promise<number> => {
    for (const voice of list) {
      const outcome = await transcribeMessage(speech, {
        messageId: voice.id,
        fileId: voice.fileId,
        userId: batch.userId,
        batchId: batch.id,
      });

      if (outcome.truncated) {
        truncated = true;

        // §10.5 ТЗ: хвост длинной записи не обрабатывается. В логе это
        // видно, а человеку об этом скажет ответ.
        deps.logger?.warn(
          { batchId: batch.id, messageId: voice.id, durationSec: outcome.durationSec },
          'Запись длиннее потолка, хвост не расшифрован',
        );
      }
    }

    return list.length;
  };

  /**
   * Учёт того, что дала склейка — вся или до срыва.
   *
   * Одна функция на оба исхода нарочно: обрезка записанной группы — тот же
   * факт и та же строка журнала независимо от того, дошла ли склейка до
   * конца. Пока учёт жил только на пути успеха, обрезка групп до срыва
   * терялась вместе с исключением.
   */
  const absorbGlued = (outcome: VoicesOutcome): void => {
    if (outcome.truncated) {
      truncated = true;

      deps.logger?.warn(
        { batchId: batch.id, durationSec: outcome.durationSec },
        'Часть сказанного не расшифрована: упёрлись в потолок',
      );
    }

    if (outcome.split > 0) {
      // Не беда, но знать полезно: столько фраз распознаватель не
      // разорвал на нашей паузе, и у них потеряна пунктуация. Вырастет
      // это число — значит паузу пора удлинять.
      deps.logger?.info(
        { batchId: batch.id, split: outcome.split },
        'Фразы на границе сообщений поделены по словам',
      );
    }
  };

  /**
   * Расшифровка всех голосовых одним запросом. Если склейка сорвалась,
   * сама уходит на путь по одному сообщению — но только для того, что
   * ещё не расшифровано.
   */
  const glueAll = async (): Promise<number> => {
    let outcome: VoicesOutcome;

    try {
      outcome = await transcribeVoices(speech, {
        messages: voices.map((voice) => ({
          messageId: voice.id,
          fileId: voice.fileId,
          durationSec: voice.durationSec,
        })),
        userId: batch.userId,
        batchId: batch.id,
      });
    } catch (error) {
      if (!(error instanceof GlueAbortedError)) throw error;

      // Склейка сорвалась: платим полную цену за нерасшифрованное, но не
      // врём о том, кто что сказал.
      //
      // **Группы до срыва записаны, и их итог приходит с исключением.**
      // Учитывается он до отката: долгая запись, обрезанная по потолку
      // §10.5 и записанная первой, в откат уже не попадёт — и без этого
      // человек не узнал бы, что хвост не расшифрован.
      absorbGlued(error.done);

      // **Список перечитывается, а не берётся снятый до склейки.** Склейка
      // пишет расшифровки в базу группа за группой — нарочно, чтобы
      // повторный заход добирал только нерасшифрованное. Сорваться могла
      // третья группа из трёх, и первые две уже записаны. Откат по
      // старому списку качал и оплачивал их второй раз — на живой
      // выгрузке из девяти голосовых, разложенной в группы 1 + 4 + 4, при
      // срыве третьей это двенадцать отправок вместо семи — и переписывал
      // верную расшифровку новым распознаванием того же звука: вернись
      // оно пустым, вместо сказанного встала бы пустая строка.
      const pending = await pendingVoices(db, batch.id);

      // Деньги за склеенный запрос уже потрачены — поэтому это
      // предупреждение, а не отладочная строка.
      deps.logger?.warn(
        { batchId: batch.id, err: error, voices: voices.length, pending: pending.length },
        'Склейка не удалась, расшифровываю по одному сообщению',
      );

      return error.done.requests + (await onePerMessage(pending));
    }

    absorbGlued(outcome);

    return outcome.requests;
  };

  const requests = canGlue(deps.provider, voices.length)
    ? await glueAll()
    : await onePerMessage(voices);

  return {
    combined: await combineBatch(db, batch.id),
    voices: voices.length,
    requests,
    truncated,
  };
}
