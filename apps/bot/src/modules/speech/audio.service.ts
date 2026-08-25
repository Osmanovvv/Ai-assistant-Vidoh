import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Api } from 'grammy';

import { convertToWav, detectSilence, probeDurationSec } from './ffmpeg.js';
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
