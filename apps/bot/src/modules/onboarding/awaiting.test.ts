import { describe, expect, it } from 'vitest';

import { AWAITING, parseAwaiting, parseName, parseTime } from './awaiting.js';

/**
 * Разбор ответа словами (задача 3.61).
 *
 * Главное свойство здесь — **строгость**. Ошибка в сторону «принял»
 * стоит человеку потерянной мысли: она уйдёт в имя или в настройку
 * времени вместо разбора. Ошибка в сторону «не принял» стоит одного
 * лишнего сообщения, которое разберётся как обычно.
 */

describe('время из слов человека', () => {
  it('берёт то, чем время пишут', () => {
    const cases: readonly [string, string][] = [
      ['7:30', '07:30'],
      ['07:30', '07:30'],
      ['7 30', '07:30'],
      ['7.30', '07:30'],
      ['7-30', '07:30'],
      ['19:05', '19:05'],
      ['в 7:30', '07:30'],
      ['7:30 утра', '07:30'],
      ['21:00 мск', '21:00'],
      ['  8:05  ', '08:05'],
      ['23:59', '23:59'],
      ['0:00', '00:00'],
    ];

    for (const [input, expected] of cases) {
      expect(parseTime(input), input).toBe(expected);
    }
  });

  it('одно число — это круглый час', () => {
    expect(parseTime('7')).toBe('07:00');
    expect(parseTime('в 21')).toBe('21:00');
  });

  it('несуществующее время не берёт', () => {
    for (const input of ['24:00', '25:30', '7:60', '99', '-1:00']) {
      expect(parseTime(input), input).toBeUndefined();
    }
  });

  it('мысль человека временем не считает', () => {
    /**
     * Ровно то, из-за чего опрос был на кнопках: реплика, пришедшая
     * вместо ответа, обязана уйти в разбор, а не в настройку.
     */
    for (const input of [
      'надо купить продукты',
      'позвонить бабушке в 7',
      'семь тридцать',
      'полвосьмого',
      'когда удобно',
      '',
    ]) {
      expect(parseTime(input), input).toBeUndefined();
    }
  });

  it('«полвосьмого» намеренно не понимает', () => {
    // Угадав неверно, бот начнёт писать не в то время, а человек не
    // поймёт почему. Лучше не понять и спросить снова.
    expect(parseTime('полвосьмого')).toBeUndefined();
  });
});

describe('имя из слов человека', () => {
  it('берёт то, как люди себя называют', () => {
    for (const input of ['Леночка', 'Ксюша', 'ксюша', 'Анна Мария', 'Мария-Луиза', 'Лёля']) {
      expect(parseName(input), input).toBe(input);
    }
  });

  it('обрезает лишние пробелы', () => {
    expect(parseName('  Леночка  ')).toBe('Леночка');
    expect(parseName('Анна   Мария')).toBe('Анна Мария');
  });

  it('длинную мысль именем не считает', () => {
    expect(parseName('надо купить продукты и позвонить бабушке вечером')).toBeUndefined();
    expect(parseName('купить хлеб молоко яйца')).toBeUndefined();
  });

  it('не берёт цифры, ссылки и несколько строк', () => {
    for (const input of ['Лена 2', 'https://ya.ru', '@lenochka', 'Лена\nи ещё', 'дом/работа']) {
      expect(parseName(input), input).toBeUndefined();
    }
  });

  it('без букв — не имя', () => {
    for (const input of ['...', '???', '   ', '—']) {
      expect(parseName(input), input).toBeUndefined();
    }
  });
});

describe('чего ждём от человека', () => {
  it('узнаёт свои значения', () => {
    expect(parseAwaiting(AWAITING.name)).toEqual({ kind: 'name' });
    expect(parseAwaiting(AWAITING.morning)).toEqual({ kind: 'morning' });
    expect(parseAwaiting(AWAITING.evening)).toEqual({ kind: 'evening' });
  });

  it('у правки достаёт запись', () => {
    expect(parseAwaiting('edit:6f1e2d3c')).toEqual({ kind: 'edit', itemId: '6f1e2d3c' });
  });

  it('пусто и мусор — ничего не ждём', () => {
    // Значение читается из базы, но чужая строка не должна включать
    // перехват сообщений: молчание надёжнее догадки.
    for (const input of [null, '', 'edit:', 'что угодно', 'NAME']) {
      expect(parseAwaiting(input), String(input)).toBeUndefined();
    }
  });
});
