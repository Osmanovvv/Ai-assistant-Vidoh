import { describe, expect, it } from 'vitest';

import { mentionedPeriod } from './period.js';

/**
 * Период, упомянутый в сегменте (§7.2 ТЗ, задача 3.1).
 *
 * Разбор узкий нарочно: он не заменяет разбор сроков моделью, а даёт
 * третьему источнику кандидатов дешёвую подсказку без обращения к ней.
 * Поэтому здесь проверяется не полнота, а два свойства: узнаёт то, что
 * обещал, и молчит про всё остальное.
 */

const MOSCOW = 'Europe/Moscow';

/** Суббота, 29 августа 2026 года, 15:00 по Москве. */
const NOW = new Date('2026-08-29T12:00:00.000Z');

function dayOf(period: { from: Date } | undefined): string | undefined {
  return period?.from.toISOString().slice(0, 10);
}

describe('дни недели', () => {
  it('«нет, в пятницу» — ближайшая пятница', () => {
    // Сказано в субботу, значит ближайшая пятница — 4 сентября.
    // Момент 21:00 UTC предыдущего дня и есть полночь в Москве.
    const period = mentionedPeriod('нет, в пятницу', { now: NOW, timeZone: MOSCOW });
    expect(dayOf(period)).toBe('2026-09-03');
    expect(period?.to.getTime()).toBe((period?.from.getTime() ?? 0) + 24 * 60 * 60_000);
  });

  it('падежи узнаются: «до среды», «к четвергу», «в субботу»', () => {
    for (const text of ['успеть до среды', 'к четвергу', 'давай в субботу']) {
      expect(mentionedPeriod(text, { now: NOW, timeZone: MOSCOW })).toBeDefined();
    }
  });

  it('день, названный сегодня, — это сегодня, а не через неделю', () => {
    // 29 августа 2026 — суббота. «В субботу», сказанное в субботу,
    // означает сегодня: иначе человек сказал бы «в следующую».
    expect(dayOf(mentionedPeriod('в субботу', { now: NOW, timeZone: MOSCOW }))).toBe('2026-08-28');
  });
});

describe('счёт от сегодня', () => {
  it('«завтра» — следующие сутки', () => {
    expect(dayOf(mentionedPeriod('давай завтра', { now: NOW, timeZone: MOSCOW }))).toBe(
      '2026-08-29',
    );
  });

  it('«послезавтра» — через одни', () => {
    expect(dayOf(mentionedPeriod('послезавтра', { now: NOW, timeZone: MOSCOW }))).toBe(
      '2026-08-30',
    );
  });

  it('пояс человека решает, какой это день', () => {
    // 22:30 по Москве — это ещё 29 августа, а по Гринвичу уже 19:30
    // того же дня. Камчатка же в этот момент живёт 30-м числом, и
    // «сегодня» там другое.
    const late = new Date('2026-08-29T19:30:00.000Z');

    expect(dayOf(mentionedPeriod('сегодня', { now: late, timeZone: MOSCOW }))).toBe('2026-08-28');
    expect(dayOf(mentionedPeriod('сегодня', { now: late, timeZone: 'Asia/Kamchatka' }))).toBe(
      '2026-08-29',
    );
  });
});

describe('молчит там, где не уверен', () => {
  it('без упоминания дня периода нет', () => {
    for (const text of ['нет, не так', 'продукты купила', 'перенеси попозже']) {
      expect(mentionedPeriod(text, { now: NOW, timeZone: MOSCOW })).toBeUndefined();
    }
  });

  it('слово, внутри которого спрятался день, днём не считается', () => {
    // «средство» содержит «средст», и поиск подстрокой нашёл бы «среда»
    // в «среде», «средстве», «посреди». Границы слова `\b` здесь не
    // помогут: они определены через латиницу и кириллицу не видят.
    for (const text of ['купить средство для посуды', 'посреди недели', 'средневековье']) {
      expect(mentionedPeriod(text, { now: NOW, timeZone: MOSCOW })).toBeUndefined();
    }
  });

  it('то, что умеет модель, а не мы, остаётся ей', () => {
    // «На следующей неделе» и «пятого сентября» разбирает извлечение.
    // Здесь такое молчит — и это правильнее, чем разобрать наполовину.
    for (const text of ['на следующей неделе', 'пятого сентября', 'через три дня']) {
      expect(mentionedPeriod(text, { now: NOW, timeZone: MOSCOW })).toBeUndefined();
    }
  });
});
