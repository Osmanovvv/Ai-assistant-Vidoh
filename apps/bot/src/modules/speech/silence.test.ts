import { describe, expect, it } from 'vitest';

import { parseSilence, planSegments, type SilenceInterval } from './silence.js';

describe('parseSilence', () => {
  it('разбирает пару строк silencedetect', () => {
    const output = [
      '[silencedetect @ 0x55] silence_start: 12.345',
      '[silencedetect @ 0x55] silence_end: 13.891 | silence_duration: 1.546',
    ].join('\n');

    expect(parseSilence(output)).toEqual([{ startSec: 12.345, endSec: 13.891 }]);
  });

  it('разбирает несколько пауз подряд', () => {
    const output = [
      'silence_start: 5',
      'silence_end: 6 | silence_duration: 1',
      'silence_start: 20.5',
      'silence_end: 22.25 | silence_duration: 1.75',
    ].join('\n');

    expect(parseSilence(output)).toEqual([
      { startSec: 5, endSec: 6 },
      { startSec: 20.5, endSec: 22.25 },
    ]);
  });

  it('отбрасывает незакрытую паузу в конце файла', () => {
    const output = ['silence_start: 5', 'silence_end: 6', 'silence_start: 40'].join('\n');

    expect(parseSilence(output)).toEqual([{ startSec: 5, endSec: 6 }]);
  });

  it('игнорирует остальной вывод ffmpeg', () => {
    const output = [
      'ffmpeg version 8.1 Copyright (c) 2000-2026',
      '  Duration: 00:03:20.15, start: 0.000000, bitrate: 32 kb/s',
      '[silencedetect @ 0x55] silence_start: 1.5',
      '[silencedetect @ 0x55] silence_end: 2.5 | silence_duration: 1',
      'size=N/A time=00:03:20.15 bitrate=N/A speed= 234x',
    ].join('\n');

    expect(parseSilence(output)).toEqual([{ startSec: 1.5, endSec: 2.5 }]);
  });

  it('возвращает пустой список, когда пауз нет', () => {
    expect(parseSilence('ffmpeg version 8.1\nsize=N/A')).toEqual([]);
  });

  it('переживает вывод с переводами строк Windows', () => {
    const output = 'silence_start: 3\r\nsilence_end: 4 | silence_duration: 1\r\n';

    expect(parseSilence(output)).toEqual([{ startSec: 3, endSec: 4 }]);
  });
});

describe('planSegments', () => {
  const silences = (...pairs: readonly (readonly [number, number])[]): SilenceInterval[] =>
    pairs.map(([startSec, endSec]) => ({ startSec, endSec }));

  it('короткое голосовое не режется', () => {
    expect(planSegments(120, silences([60, 61]), 300)).toEqual([{ startSec: 0, endSec: 120 }]);
  });

  it('голосовое ровно по лимиту не режется', () => {
    expect(planSegments(300, [], 300)).toEqual([{ startSec: 0, endSec: 300 }]);
  });

  it('режет по паузе, а не по секундомеру', () => {
    // Пауза на 280–284, лимит 300: режем в середине паузы.
    const segments = planSegments(500, silences([280, 284]), 300);

    expect(segments).toEqual([
      { startSec: 0, endSec: 282 },
      { startSec: 282, endSec: 500 },
    ]);
  });

  it('выбирает самую позднюю паузу в пределах лимита', () => {
    // Меньше кусков — меньше обращений к расшифровке.
    const segments = planSegments(500, silences([50, 52], [180, 182], [290, 292]), 300);

    expect(segments[0]).toEqual({ startSec: 0, endSec: 291 });
  });

  it('режет по лимиту, если подходящей паузы нет', () => {
    const segments = planSegments(700, [], 300);

    expect(segments).toEqual([
      { startSec: 0, endSec: 300 },
      { startSec: 300, endSec: 600 },
      { startSec: 600, endSec: 700 },
    ]);
  });

  it('не режет по паузе у самого начала куска', () => {
    // Пауза на 5-й секунде дала бы пятисекундный кусок и лишний вызов.
    const segments = planSegments(500, silences([4, 6]), 300);

    expect(segments[0]).toEqual({ startSec: 0, endSec: 300 });
  });

  it('покрывает всю запись без пропусков и наложений', () => {
    const segments = planSegments(1_000, silences([250, 252], [560, 563], [800, 802]), 300);

    expect(segments[0]?.startSec).toBe(0);
    expect(segments.at(-1)?.endSec).toBe(1_000);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]?.startSec).toBe(segments[i - 1]?.endSec);
    }
  });

  it('ни один кусок не длиннее лимита', () => {
    const segments = planSegments(1_800, silences([100, 101], [700, 702], [1_500, 1_502]), 300);

    for (const segment of segments) {
      expect(segment.endSec - segment.startSec).toBeLessThanOrEqual(300);
    }
  });

  it('игнорирует паузы за пределами записи', () => {
    const segments = planSegments(400, silences([-5, -1], [900, 905]), 300);

    expect(segments).toEqual([
      { startSec: 0, endSec: 300 },
      { startSec: 300, endSec: 400 },
    ]);
  });

  it('отвергает неположительный лимит', () => {
    expect(() => planSegments(100, [], 0)).toThrow(/положительным/u);
  });
});
