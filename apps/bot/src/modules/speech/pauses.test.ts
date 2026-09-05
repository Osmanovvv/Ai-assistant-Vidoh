import { describe, expect, it } from 'vitest';

import { gapsBetweenWords, PAUSE_THRESHOLDS, pauseStats } from './pauses.js';
import type { RecognizedUtterance } from './providers/types.js';

/**
 * Замер паузы между словами (задача 3.59, шаг 1).
 *
 * Точки в расшифровке ставит литературная нормализация Yandex, и ставит их
 * не там: «…позвонить бабушке, желательно вечером, завтра надо. Отнести
 * ноутбук…». Правила срока опираются на предложения, и «завтра» из мысли
 * про ноутбук досталось бабушке.
 *
 * Здесь пока **только счёт**. Порог, выбранный на глаз, — догадка, а
 * догадки в этом проекте уже давали выдуманные сроки; поэтому сперва надо
 * увидеть, какие паузы в живой речи бывают.
 */

/** Слова с временами: пары «начало, конец» в миллисекундах. */
function said(...spans: readonly (readonly [number, number])[]): RecognizedUtterance {
  return {
    text: spans.map((_, index) => `слово${String(index)}`).join(' '),
    words: spans.map((span, index) => ({
      text: `слово${String(index)}`,
      startMs: span[0],
      endMs: span[1],
    })),
  };
}

describe('разрывы между словами', () => {
  it('считает разрыв между концом слова и началом следующего', () => {
    // Слова: 0–100, 400–500, 520–600 → разрывы 300 и 20.
    const gaps = gapsBetweenWords([said([0, 100], [400, 500], [520, 600])]);

    expect([...gaps]).toEqual([20, 300]);
  });

  it('перекрытие времён считается нулём, а не отрицательным', () => {
    /**
     * У соседних слов времена перекрываются — это норма распознавания, а
     * не ошибка. Отрицательная «пауза» исказила бы и середину, и доли.
     */
    const gaps = gapsBetweenWords([said([0, 200], [150, 300])]);

    expect([...gaps]).toEqual([0]);
  });

  it('разрывы между фразами не считаются', () => {
    /**
     * Между фразами распознавание уже поставило границу само — там пауза
     * заведомо длинная, и включать её в счёт значило бы завысить доли.
     */
    const gaps = gapsBetweenWords([said([0, 100], [200, 300]), said([5000, 5100], [5200, 5300])]);

    expect([...gaps]).toEqual([100, 100]);
  });

  it('на одном слове и на пустоте разрывов нет', () => {
    expect(gapsBetweenWords([said([0, 100])])).toEqual([]);
    expect(gapsBetweenWords([])).toEqual([]);
  });
});

describe('сводка по паузам', () => {
  it('считает слова, разрывы и доли', () => {
    const stats = pauseStats([said([0, 100], [200, 300], [900, 1000], [3000, 3100])]);

    expect(stats.words).toBe(4);
    expect(stats.gaps).toBe(3);
    expect(stats.max).toBe(2000);
    expect(stats.median).toBeGreaterThanOrEqual(100);
  });

  it('показывает, сколько границ дал бы каждый порог', () => {
    /**
     * Главное число замера: по нему видно, годится порог или нет. Порог,
     * дающий границу на каждом третьем слове, не годится, и это должно
     * быть видно сразу, а не после выкладки.
     */
    const stats = pauseStats([said([0, 100], [200, 300], [900, 1000], [3000, 3100])]);

    // Разрывы: 100, 600, 2000.
    expect(stats.over['200мс']).toBe(2);
    expect(stats.over['500мс']).toBe(2);
    expect(stats.over['1000мс']).toBe(1);
  });

  it('у каждого порога есть своё число', () => {
    const stats = pauseStats([said([0, 100], [200, 300])]);

    for (const threshold of PAUSE_THRESHOLDS) {
      expect(stats.over[`${String(threshold)}мс`], String(threshold)).toBeDefined();
    }
  });

  it('на пустоте не падает и даёт нули', () => {
    const stats = pauseStats([]);

    expect(stats.words).toBe(0);
    expect(stats.gaps).toBe(0);
    expect(stats.max).toBe(0);
    expect(stats.median).toBe(0);
  });
});
