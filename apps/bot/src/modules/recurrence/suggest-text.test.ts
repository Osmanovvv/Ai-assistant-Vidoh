import { describe, expect, it } from 'vitest';

import { datesInWords, rhythmInWords } from './suggest-text.js';

/**
 * Как звучит предложение (задача 3.8в).
 *
 * Предложение обязано показывать основание: без дат оно читается как
 * гадание бота. А раз даты показываются человеку, они должны звучать
 * по-человечески, а не таблицей.
 */

const MOSCOW = 'Europe/Moscow';
const at = (iso: string): Date => new Date(`${iso}T09:00:00.000Z`);

describe('даты словами', () => {
  it('три даты одного месяца называют месяц один раз', () => {
    // «5, 12 и 19 августа» — человек читает фразу, а не таблицу.
    expect(datesInWords([at('2026-08-05'), at('2026-08-12'), at('2026-08-19')], MOSCOW)).toBe(
      '5, 12 и 19 августа',
    );
  });

  it('разные месяцы называются каждый', () => {
    expect(datesInWords([at('2026-06-03'), at('2026-07-01'), at('2026-08-03')], MOSCOW)).toBe(
      '3 июня, 1 июля и 3 августа',
    );
  });

  it('пояс человека решает, какое это число', () => {
    // 22:30 по Москве — это ещё пятое, а по Гринвичу уже пятое же, но
    // на Камчатке шестое.
    const late = new Date('2026-08-05T19:30:00.000Z');

    expect(datesInWords([late], MOSCOW)).toBe('5 августа');
    expect(datesInWords([late], 'Asia/Kamchatka')).toBe('6 августа');
  });

  it('пустой список не ломает фразу', () => {
    expect(datesInWords([], MOSCOW)).toBe('');
  });
});

describe('ритм словами', () => {
  it('называется так, как сказал бы человек', () => {
    expect(rhythmInWords({ kind: 'weekly', interval: 1, medianDays: 7 })).toBe('каждую неделю');
    expect(rhythmInWords({ kind: 'weekly', interval: 2, medianDays: 14 })).toBe('раз в две недели');
    expect(rhythmInWords({ kind: 'monthly', interval: 1, medianDays: 30 })).toBe('каждый месяц');
  });
});
