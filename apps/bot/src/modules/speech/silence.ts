/**
 * Нарезка длинного голосового на части (задача 1.14).
 *
 * §10.5 ТЗ: сообщения сверх лимита обрабатываются частями. Резать надо
 * по паузам, а не по секундомеру: разрыв посреди слова портит расшифровку
 * обеих частей, и это видно в разборе.
 *
 * Здесь только вычисления. Запуск ffmpeg — в ffmpeg.ts, чтобы логику
 * выбора точек можно было проверить без внешнего процесса.
 */

export interface SilenceInterval {
  readonly startSec: number;
  readonly endSec: number;
}

export interface Segment {
  readonly startSec: number;
  readonly endSec: number;
}

/**
 * Разбирает вывод фильтра silencedetect.
 *
 * ffmpeg печатает пары строк вида:
 *   [silencedetect @ ...] silence_start: 12.345
 *   [silencedetect @ ...] silence_end: 13.891 | silence_duration: 1.546
 *
 * Последняя пауза может остаться без silence_end, если файл заканчивается
 * тишиной — такую отбрасываем: резать по ней нечего.
 */
export function parseSilence(ffmpegOutput: string): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  let pendingStart: number | undefined;

  for (const line of ffmpegOutput.split(/\r?\n/u)) {
    const start = /silence_start:\s*(-?[\d.]+)/u.exec(line);
    if (start?.[1] !== undefined) {
      pendingStart = Number.parseFloat(start[1]);
      continue;
    }

    const end = /silence_end:\s*(-?[\d.]+)/u.exec(line);
    if (end?.[1] !== undefined && pendingStart !== undefined) {
      const endSec = Number.parseFloat(end[1]);
      if (endSec > pendingStart) {
        intervals.push({ startSec: pendingStart, endSec });
      }
      pendingStart = undefined;
    }
  }

  return intervals;
}

/** Середина паузы: самая безопасная точка разреза. */
function midpoint(interval: SilenceInterval): number {
  return (interval.startSec + interval.endSec) / 2;
}

/**
 * Выбирает точки разреза так, чтобы куски были не длиннее максимума
 * и разрезы попадали в паузы.
 *
 * Если подходящей паузы рядом с границей нет, режем строго по максимуму:
 * непрерывная речь длиной в двадцать минут всё равно должна быть обработана.
 */
export function planSegments(
  totalDurationSec: number,
  silences: readonly SilenceInterval[],
  maxSegmentSec: number,
): Segment[] {
  if (maxSegmentSec <= 0) {
    throw new Error('maxSegmentSec должен быть положительным');
  }
  if (totalDurationSec <= maxSegmentSec) {
    return [{ startSec: 0, endSec: totalDurationSec }];
  }

  const candidates = silences
    .map(midpoint)
    .filter((point) => point > 0 && point < totalDurationSec)
    .sort((a, b) => a - b);

  const segments: Segment[] = [];
  let cursor = 0;

  while (totalDurationSec - cursor > maxSegmentSec) {
    const hardLimit = cursor + maxSegmentSec;

    // Берём самую позднюю паузу, которая укладывается в лимит: так кусков
    // получится меньше, а значит меньше обращений к расшифровке.
    let cut: number | undefined;
    for (const point of candidates) {
      if (point > cursor && point <= hardLimit) {
        cut = point;
      } else if (point > hardLimit) {
        break;
      }
    }

    // Пауза у самого начала куска дала бы почти пустой отрезок и лишний
    // вызов расшифровки. Тогда честнее резать по лимиту.
    const minUsefulLength = maxSegmentSec * 0.2;
    const nextCut = cut !== undefined && cut - cursor >= minUsefulLength ? cut : hardLimit;

    segments.push({ startSec: cursor, endSec: nextCut });
    cursor = nextCut;
  }

  segments.push({ startSec: cursor, endSec: totalDurationSec });
  return segments;
}
