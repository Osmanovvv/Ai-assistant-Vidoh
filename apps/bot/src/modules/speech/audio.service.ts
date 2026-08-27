import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Api } from 'grammy';

import { concatToWav, convertToWav, detectSilence, probeDurationSec } from './ffmpeg.js';
import { withRetry, withTimeout } from '../../infra/retry.js';
import { parseSilence, planSegments } from './silence.js';

/**
 * Работа с аудио (задача 1.14).
 *
 * §16 ТЗ: исходный аудиофайл удаляется сразу после обработки, хранение
 * дольше времени обработки запрещено. Поэтому вся работа обёрнута в
 * withTempDir: папка удаляется в finally и при исключении тоже.
 *
 * §10.5 ТЗ: длинные сообщения обрабатываются частями. Нарезка идёт по
 * паузам — см. silence.ts.
 */

export interface AudioLimits {
  /** Свыше этой длительности сообщение режется на части. */
  readonly maxSegmentSec: number;
  /** Потолок на одно сообщение: сверх него хвост отбрасывается. */
  readonly maxSingleDurationSec: number;
  /**
   * Потолок на всю выгрузку (§10.5 ТЗ: «10 минут на сообщение, 20 минут на
   * выгрузку»).
   *
   * Второй потолок в коде отсутствовал — нашлось аудитом 27.08.2026. Без
   * него потолок в тридцать выгрузок за сутки ничего не ограничивает:
   * пятнадцать сообщений по десять минут — это два с половиной часа
   * распознавания в одной выгрузке, около девяноста рублей. Тридцать таких
   * выгрузок — две с половиной тысячи в день с одного человека.
   *
   * Необязательный: подготовка одной записи о нём ничего не знает и знать
   * не должна — потолок выгрузки применяется уровнем выше.
   */
  readonly maxDumpDurationSec?: number | undefined;
}

/** Байт в секунде записи после конвертации: моно, 16 кГц, 16 бит. */
const WAV_BYTES_PER_SEC = 16_000 * 2;

/**
 * Потолок тела запроса к распознавателю.
 *
 * Измерен живыми запросами к SpeechKit 24.08.2026: тело в 4 МБ принимается,
 * тело в 8 МБ обрывается по соединению без внятного кода ошибки. Берём
 * 3,5 МБ, чтобы не жить на самой границе.
 *
 * Из этого числа считается длина части, а не наоборот: без такого расчёта
 * пятиминутная часть весила бы 12,8 МБ и распознавание длинного голосового
 * падало бы всегда — при том что короткое работало бы прекрасно.
 */
const MAX_UPLOAD_BYTES = 3_500_000;

/** base64 раздувает тело запроса на треть. */
const BASE64_OVERHEAD = 4 / 3;

export const MAX_SEGMENT_SEC = Math.floor(MAX_UPLOAD_BYTES / BASE64_OVERHEAD / WAV_BYTES_PER_SEC);

export const DEFAULT_AUDIO_LIMITS: AudioLimits = {
  maxSegmentSec: MAX_SEGMENT_SEC,
  maxSingleDurationSec: 600,
  maxDumpDurationSec: 1200,
};

export interface AudioPart {
  readonly path: string;
  readonly startSec: number;
  readonly endSec: number;
}

export interface PreparedAudio {
  readonly durationSec: number;
  readonly parts: readonly AudioPart[];
  /** Запись длиннее потолка: хвост не обрабатывается, пользователя предупреждаем. */
  readonly truncated: boolean;
}

/** Создаёт временную папку и гарантированно удаляет её после работы. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'vydoh-audio-'));
  try {
    return await fn(dir);
  } finally {
    // force: не падать, если папку уже кто-то убрал.
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Готовит запись к расшифровке: определяет длительность, при необходимости
 * режет по паузам и конвертирует части в моно 16 кГц WAV.
 */
export async function prepareAudio(
  sourcePath: string,
  outputDir: string,
  limits: AudioLimits = DEFAULT_AUDIO_LIMITS,
): Promise<PreparedAudio> {
  const rawDuration = await probeDurationSec(sourcePath);
  const truncated = rawDuration > limits.maxSingleDurationSec;
  const durationSec = Math.min(rawDuration, limits.maxSingleDurationSec);

  const silences =
    durationSec > limits.maxSegmentSec ? parseSilence(await detectSilence(sourcePath)) : [];

  const plan = planSegments(durationSec, silences, limits.maxSegmentSec);

  const parts: AudioPart[] = [];
  for (const [index, segment] of plan.entries()) {
    const path = join(outputDir, `part-${String(index).padStart(2, '0')}.wav`);
    // Одна часть — конвертируем целиком, без лишнего перехода по времени.
    await convertToWav(sourcePath, path, plan.length === 1 ? undefined : segment);
    parts.push({ path, startSec: segment.startSec, endSec: segment.endSec });
  }

  return { durationSec, parts, truncated };
}

/**
 * Пауза между склеенными записями.
 *
 * Величина измерена на живом распознавании 27.08.2026, четыре записи в
 * одной склейке:
 *
 *   - полсекунды — SpeechKit слил две записи в одну фразу, раскладка
 *     спасла смысл делением по словам, но пунктуацию у этих двух потеряла;
 *   - **секунда — четыре фразы, ни одного деления, знаки у всех**;
 *   - полторы — то же самое, ничего не добавляет.
 *
 * Пауза — тоже оплаченное аудио, поэтому лишнего не берём: секунда на
 * восемь стыков девяти голосовых даёт 180 секунд из 172 сказанных, то есть
 * ровно те же двенадцать блоков.
 *
 * Она же служит зазором при раскладке: слов внутри паузы нет, значит
 * промах времён на десяток миллисекунд никуда слово не перенесёт.
 */
export const GLUE_PAUSE_SEC = 1;

/**
 * Расхождение предсказанной длины склейки с настоящей, после которого
 * склейке нельзя верить.
 *
 * Меньше половины паузы: больший сдвиг мог бы отнести слово к соседнему
 * сообщению, а это тише и хуже, чем отказаться от склейки.
 */
const MAX_DRIFT_SEC = GLUE_PAUSE_SEC / 2;

export interface VoiceSource {
  readonly messageId: string;
  readonly path: string;
}

/** Где внутри склейки лежит запись одного сообщения. */
export interface GluedPiece {
  readonly messageId: string;
  readonly startSec: number;
  readonly endSec: number;
}

export interface GluedAudio {
  readonly path: string;
  readonly durationSec: number;
  readonly pieces: readonly GluedPiece[];
  /** Хоть одна запись была длиннее потолка: её хвост не расшифрован. */
  readonly truncated: boolean;
}

export interface GlueOptions {
  readonly pauseSec?: number | undefined;
  /**
   * Потолок на **одну** запись (§10.5 ТЗ). Именно на одну, а не на всю
   * склейку: три получасовых голосовых и до склейки обрабатывались
   * каждое до своего потолка, и склейка не повод отнять у человека
   * половину сказанного.
   */
  readonly maxPieceSec?: number | undefined;
}

export class GlueDriftError extends Error {
  constructor(expectedSec: number, actualSec: number) {
    super(
      `склейка вышла длиной ${actualSec.toFixed(3)} с вместо ${expectedSec.toFixed(3)} с: ` +
        'границам сообщений верить нельзя',
    );
    this.name = 'GlueDriftError';
  }
}

/**
 * Склеивает голосовые одной выгрузки в один файл (задача 1.14, дополнено
 * 27.08.2026).
 *
 * **Почему сначала конвертация, потом склейка.** Границы сообщений внутри
 * склейки нужны точные: по ним потом раскладываются слова. Длительность,
 * взятая у исходного ogg, приблизительна, и на девяти записях промах
 * накопился бы. Длительность готового WAV — это число отсчётов, делённое
 * на частоту, то есть точная величина. Конвертация всё равно нужна была,
 * просто теперь она идёт раньше.
 *
 * Дополнительная проверка длины — не перестраховка: если ffmpeg вернёт
 * не то, что мы посчитали, лучше отказаться от склейки и заплатить
 * полную цену, чем молча приписать слова чужому сообщению.
 */
export async function glueVoices(
  sources: readonly VoiceSource[],
  outputDir: string,
  options: GlueOptions = {},
): Promise<GluedAudio> {
  if (sources.length === 0) throw new Error('склеивать нечего');

  const pauseSec = options.pauseSec ?? GLUE_PAUSE_SEC;
  const maxPieceSec = options.maxPieceSec ?? DEFAULT_AUDIO_LIMITS.maxSingleDurationSec;

  const converted: { readonly messageId: string; readonly path: string; readonly sec: number }[] =
    [];
  let truncated = false;

  for (const [index, source] of sources.entries()) {
    const path = join(outputDir, `piece-${String(index).padStart(2, '0')}.wav`);

    const raw = await probeDurationSec(source.path);
    if (raw > maxPieceSec) {
      truncated = true;
      await convertToWav(source.path, path, { startSec: 0, endSec: maxPieceSec });
    } else {
      await convertToWav(source.path, path);
    }

    converted.push({ messageId: source.messageId, path, sec: await probeDurationSec(path) });
  }

  const pieces: GluedPiece[] = [];
  let cursor = 0;
  for (const piece of converted) {
    pieces.push({ messageId: piece.messageId, startSec: cursor, endSec: cursor + piece.sec });
    cursor += piece.sec + pauseSec;
  }

  // Последняя пауза не добавляется: она нужна только между записями.
  const expected = cursor - (converted.length > 0 ? pauseSec : 0);

  const output = join(outputDir, 'glued.wav');
  await concatToWav(
    converted.map((piece) => piece.path),
    output,
    pauseSec,
  );

  const actual = await probeDurationSec(output);
  if (Math.abs(actual - expected) > MAX_DRIFT_SEC) {
    throw new GlueDriftError(expected, actual);
  }

  return { path: output, durationSec: actual, pieces, truncated };
}

/** Сколько ждать один заход за файлом и сколько раз пробовать. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_ATTEMPTS = 3;

/**
 * Скачивает голосовое из Telegram во временный файл.
 *
 * Сам файл остаётся у Telegram независимо от нашего решения, но у себя
 * мы его не храним: копия живёт только на время обработки.
 *
 * Повтор и таймаут здесь не для симметрии с вызовом распознавания.
 * На первой же настоящей записи скачивание однажды упёрлось в ETIMEDOUT,
 * и вся выгрузка встала намертво — при том что через минуту тот же файл
 * качался за семь десятых секунды. Сеть до Telegram ничем не надёжнее
 * сети до распознавателя, и относиться к ней надо так же.
 */
export async function downloadTelegramFile(
  api: Api,
  fileId: string,
  destPath: string,
): Promise<void> {
  await withRetry(
    async () => {
      await withTimeout(
        async () => {
          const file = await api.getFile(fileId);
          if (file.file_path === undefined) {
            throw new Error(`Telegram не вернул путь к файлу ${fileId}`);
          }

          const url = `https://api.telegram.org/file/bot${api.token}/${file.file_path}`;

          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Не удалось скачать файл: HTTP ${String(response.status)}`);
          }

          await writeFile(destPath, Buffer.from(await response.arrayBuffer()));
        },
        DOWNLOAD_TIMEOUT_MS,
        'скачивание файла',
      );
    },
    { attempts: DOWNLOAD_ATTEMPTS },
  );
}
