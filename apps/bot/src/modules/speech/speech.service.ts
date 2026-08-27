import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import { messagesRaw } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { meterCall } from '../metering/ai-calls.repo.js';
import { SPEECH_BILLING_BLOCK_SEC, type ModelPricing } from '../metering/pricing.js';
import { attribute } from './attribution.js';
import { groupVoices } from './grouping.js';
import {
  DEFAULT_AUDIO_LIMITS,
  GLUE_PAUSE_SEC,
  glueVoices,
  prepareAudio,
  withTempDir,
  type AudioLimits,
  type VoiceSource,
} from './audio.service.js';
import type { RecognizedUtterance, SpeechProvider } from './providers/types.js';
import { withRetry, withTimeout, type RetryOptions } from '../../infra/retry.js';

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

export interface VoiceMessage {
  readonly messageId: string;
  readonly fileId: string;
  /** Длительность по данным Telegram: по ней решается, что с чем клеить. */
  readonly durationSec: number;
}

export interface VoicesOutcome {
  /** Сколько запросов к распознавателю сделано. */
  readonly requests: number;
  /** Сколько секунд отправлено: речь плюс паузы внутри склеек. */
  readonly durationSec: number;
  /** Хоть одна запись была длиннее потолка (§10.5 ТЗ). */
  readonly truncated: boolean;
  /** Сколько фраз пришлось делить по словам на границе сообщений. */
  readonly split: number;
}

interface GroupOutcome {
  readonly requests: number;
  readonly durationSec: number;
  readonly truncated: boolean;
  readonly split: number;
}

/**
 * Расшифровка одной группы голосовых одним запросом.
 *
 * Группа собрана так, что влезает в запрос целиком (см. grouping.ts). Если
 * после конвертации она всё же оказалась длиннее потолка — Telegram
 * округляет длительности до секунды, и на десятке записей это заметно, —
 * склейка режется на части прежним способом, а времена слов сдвигаются на
 * начало своей части.
 */
async function transcribeGroup(
  deps: TranscribeDeps,
  group: readonly VoiceMessage[],
  params: { readonly userId: string; readonly batchId?: string | undefined },
): Promise<GroupOutcome> {
  const limits = deps.limits ?? DEFAULT_AUDIO_LIMITS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const done = await withTempDir(async (dir) => {
    const sources: VoiceSource[] = [];
    for (const [index, message] of group.entries()) {
      const path = join(dir, `source-${String(index).padStart(2, '0')}`);
      await deps.download(message.fileId, path);
      sources.push({ messageId: message.messageId, path });
    }

    const glued = await glueVoices(sources, dir, {
      maxPieceSec: limits.maxSingleDurationSec,
    });

    const parts =
      glued.durationSec <= limits.maxSegmentSec
        ? [{ path: glued.path, startSec: 0, endSec: glued.durationSec }]
        : (
            await prepareAudio(glued.path, dir, {
              maxSegmentSec: limits.maxSegmentSec,
              // Потолок уже применён к каждой записи внутри склейки.
              // Применить его второй раз к сумме значило бы отнять у
              // человека сказанное только потому, что он сказал это
              // несколькими сообщениями подряд.
              maxSingleDurationSec: Number.POSITIVE_INFINITY,
            })
          ).parts;

    const utterances: RecognizedUtterance[] = [];

    for (const part of parts) {
      const recognized = await meterCall(
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

          return { value: result, usage: { audioSeconds: result.audioSeconds } };
        },
        { pricing: deps.pricing },
      );

      // Времена приходят от начала части, а границы сообщений считаны от
      // начала склейки. Без сдвига вторая часть уехала бы целиком в первое
      // сообщение.
      const shiftMs = part.startSec * 1000;
      for (const utterance of recognized.utterances ?? []) {
        utterances.push({
          text: utterance.text,
          words: utterance.words.map((word) => ({
            text: word.text,
            startMs: word.startMs + shiftMs,
            endMs: word.endMs + shiftMs,
          })),
        });
      }
    }

    return {
      attribution: attribute(glued.pieces, utterances),
      requests: parts.length,
      durationSec: glued.durationSec,
      truncated: glued.truncated,
    };
  });

  // Расшифровки записываются по одной, а не одной транзакцией: если
  // процесс упадёт посередине, повторный заход доберёт только
  // нерасшифрованное — это дешевле, чем начинать выгрузку заново.
  for (const piece of done.attribution.pieces) {
    await deps.db
      .update(messagesRaw)
      .set({ transcript: piece.text, fileId: null })
      .where(eq(messagesRaw.id, piece.messageId));
  }

  return {
    requests: done.requests,
    durationSec: done.durationSec,
    truncated: done.truncated,
    split: done.attribution.split,
  };
}

/**
 * Расшифровка всех голосовых выгрузки (задача 1.14, дополнено 27.08.2026).
 *
 * **Зачем.** SpeechKit берёт деньги блоками по 15 секунд за запрос. Живая
 * выгрузка 27.08.2026: девять голосовых, 172 секунды речи — семнадцать
 * оплаченных блоков вместо двенадцати, потому что каждая запись
 * округлялась вверх сама по себе. По записанному учёту это 2,7642 ₽.
 * Собранные в три группы, те же 172 секунды стоят тринадцать блоков.
 *
 * **Чем это не бесплатно.** Расшифровка обязана вернуться в то сообщение,
 * из которого пришла: на ней держатся выгрузка данных по §16, повторный
 * заход после сбоя и порядок склейки текста. Поэтому склейка помнит, где
 * чья запись, а раскладка (attribution.ts) раскидывает фразы по временам
 * слов. Времена SpeechKit отдаёт — проверено живым запросом 27.08.2026.
 *
 * **Когда не клеим.** Запись, которая сама не влезает в запрос, идёт
 * прежним путём: её всё равно резать по внутренним паузам. Одна запись в
 * группе — тоже прежним путём: клеить нечего.
 */
export async function transcribeVoices(
  deps: TranscribeDeps,
  params: {
    readonly messages: readonly VoiceMessage[];
    readonly userId: string;
    readonly batchId?: string | undefined;
  },
): Promise<VoicesOutcome> {
  if (params.messages.length === 0) {
    return { requests: 0, durationSec: 0, truncated: false, split: 0 };
  }

  const limits = deps.limits ?? DEFAULT_AUDIO_LIMITS;
  const dumpCap =
    limits.maxDumpDurationSec ??
    DEFAULT_AUDIO_LIMITS.maxDumpDurationSec ??
    Number.POSITIVE_INFINITY;

  /**
   * Потолок на всю выгрузку (§10.5 ТЗ: 20 минут).
   *
   * Его в коде не было — нашлось аудитом 27.08.2026. Потолок в тридцать
   * выгрузок за сутки без него ничего не ограничивает: пятнадцать
   * сообщений по десять минут — два с половиной часа распознавания в одной
   * выгрузке.
   *
   * Запись, которая не влезла целиком, расшифровывается до остатка, а не
   * выбрасывается: человек говорил, и услышать его надо настолько,
   * насколько мы обещали. Остаток короче блока оплаты не берём — один
   * запрос ради нескольких секунд.
   */
  const planned: VoiceMessage[] = [];
  const capped: { readonly message: VoiceMessage; readonly allowedSec: number }[] = [];
  const skipped: VoiceMessage[] = [];

  let used = 0;
  for (const message of params.messages) {
    const remaining = dumpCap - used;

    if (remaining <= 0) {
      skipped.push(message);
      continue;
    }

    if (message.durationSec <= remaining) {
      planned.push(message);
      used += message.durationSec;
      continue;
    }

    if (remaining >= SPEECH_BILLING_BLOCK_SEC) {
      capped.push({ message, allowedSec: remaining });
    } else {
      skipped.push(message);
    }

    used = dumpCap;
  }

  const groups = groupVoices(
    planned.map((message) => ({
      messageId: message.messageId,
      durationSec: message.durationSec,
    })),
    {
      capacitySec: limits.maxSegmentSec,
      pauseSec: GLUE_PAUSE_SEC,
      blockSec: SPEECH_BILLING_BLOCK_SEC,
    },
  );

  const byId = new Map(planned.map((message) => [message.messageId, message]));

  let requests = 0;
  let durationSec = 0;
  let truncated = capped.length > 0 || skipped.length > 0;
  let split = 0;

  for (const group of groups) {
    const members = group.flatMap((voice) => {
      const message = byId.get(voice.messageId);
      return message === undefined ? [] : [message];
    });

    const only = members.length === 1 ? members[0] : undefined;

    if (only !== undefined) {
      // Клеить нечего: один запрос в любом случае, а прежний путь умеет
      // резать длинную запись по её внутренним паузам.
      const outcome = await transcribeMessage(deps, {
        messageId: only.messageId,
        fileId: only.fileId,
        userId: params.userId,
        batchId: params.batchId,
      });

      requests += outcome.parts;
      durationSec += outcome.durationSec;
      truncated = truncated || outcome.truncated;
      continue;
    }

    const outcome = await transcribeGroup(deps, members, params);

    requests += outcome.requests;
    durationSec += outcome.durationSec;
    truncated = truncated || outcome.truncated;
    split += outcome.split;
  }

  // Запись, упёршаяся в потолок выгрузки: расшифровываем ровно остаток.
  for (const item of capped) {
    const outcome = await transcribeMessage(
      { ...deps, limits: { ...limits, maxSingleDurationSec: item.allowedSec } },
      {
        messageId: item.message.messageId,
        fileId: item.message.fileId,
        userId: params.userId,
        batchId: params.batchId,
      },
    );

    requests += outcome.parts;
    durationSec += outcome.durationSec;
  }

  // Записи за потолком. Расшифровка пустая, но проставленная: иначе
  // повторный заход брался бы за них снова и снова. Само сообщение из базы
  // никуда не девается — §9 запрещает терять сказанное, и оно не потеряно,
  // просто не расшифровано. Человеку об этом скажет ответ.
  for (const message of skipped) {
    await deps.db
      .update(messagesRaw)
      .set({ transcript: '', fileId: null })
      .where(eq(messagesRaw.id, message.messageId));
  }

  return { requests, durationSec, truncated, split };
}
