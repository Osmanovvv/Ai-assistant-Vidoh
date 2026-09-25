import { describe, expect, it } from 'vitest';

import { defaultTexts } from '../../texts/index.js';
import { isSingleDayPeriod, spanLine, underDayTitle } from './day-list.js';

/**
 * Строки списков «На завтра у тебя вот это:» (проверка Никиты 25.09.2026,
 * 03:29): «— Встретить курьера послезавтра» под шапкой «на завтра» —
 * слово дня осталось в названии со дня записи, а часа у дел не было видно.
 * Дела — как на бою в ту минуту.
 */
const now = new Date('2026-09-25T00:29:00Z'); // 25.09 03:29 МСК
const timeZone = 'Europe/Moscow';
const day = (iso: string): Date => new Date(`${iso}T00:00:00+03:00`);
const item = (
  text: string,
  due: string,
  time: number | null = null,
  accuracy: 'day' | 'week' | 'month' = 'day',
) => ({ text, deadlineAt: day(due), deadlineAccuracy: accuracy, deadlineTime: time });

describe('строка под шапкой одного дня: без слова дня, с часом', () => {
  it('бой 25.09.2026: «Встретить курьера послезавтра» на завтра — «Встретить курьера · 21:00»', () => {
    expect(underDayTitle(item('Встретить курьера послезавтра', '2026-09-26', 21 * 60))).toBe(
      'Встретить курьера · 21:00',
    );
    expect(underDayTitle(item('Позвонить маме', '2026-09-26', 21 * 60))).toBe(
      'Позвонить маме · 21:00',
    );
    expect(underDayTitle(item('Забрать ребенка', '2026-09-26', 20 * 60))).toBe(
      'Забрать ребенка · 20:00',
    );
  });

  it('без часа — только название без слова дня, с заглавной', () => {
    expect(underDayTitle(item('Купить яйца на завтра', '2026-09-25'))).toBe('Купить яйца');
    expect(
      underDayTitle(item('На завтра сделать предмет по университету Питон', '2026-09-25')),
    ).toBe('Сделать предмет по университету Питон');
  });

  it('старый час в названии при сроке с часом — срезан: час один, из срока', () => {
    expect(underDayTitle(item('Позвонить маме в 9', '2026-09-26', 21 * 60))).toBe(
      'Позвонить маме · 21:00',
    );
  });

  it('час в названии без часа в сроке — остаётся: другого нет', () => {
    expect(underDayTitle(item('Забрать ребенка в 7', '2026-09-26'))).toBe('Забрать ребенка в 7');
  });
});

describe('строка под шапкой нескольких дней: без слова дня, со своим днём из срока', () => {
  const context = { now, timeZone };

  it('«послезавтра» из названия уходит, настоящий день и час — из срока', () => {
    expect(
      spanLine(item('Встретить курьера послезавтра', '2026-09-26', 21 * 60), context, defaultTexts),
    ).toEqual({
      title: 'Встретить курьера',
      when: 'завтра, 21:00',
    });
  });

  it('дальний день — числом; сегодня без часа — «сегодня»; сегодня с часом — час', () => {
    expect(spanLine(item('Купить обои', '2026-09-27'), context, defaultTexts)).toEqual({
      title: 'Купить обои',
      when: '27.09',
    });
    expect(spanLine(item('Пойти в кипу', '2026-09-25'), context, defaultTexts)).toEqual({
      title: 'Пойти в кипу',
      when: 'сегодня',
    });
    expect(
      spanLine(item('Поехать за ребёнком', '2026-09-25', 16 * 60), context, defaultTexts),
    ).toEqual({
      title: 'Поехать за ребёнком',
      when: '16:00',
    });
  });

  it('неточный срок — словами карточки, как было', () => {
    const line = spanLine(item('Купить шторы', '2026-09-28', null, 'week'), context, defaultTexts);
    expect(line.title).toBe('Купить шторы');
    expect(line.when).toBe(defaultTexts.card.deadlineWeek('28.09'));
  });
});

describe('какой отрезок — один день', () => {
  it('завтра, послезавтра и день недели — один день; выходные, неделя, месяц, N дней — нет', () => {
    for (const period of ['tomorrow', 'afterTomorrow', 'weekday:4', 'weekday:4:next'] as const) {
      expect(isSingleDayPeriod(period), period).toBe(true);
    }
    for (const period of ['weekend', 'week', 'nextWeek', 'month', 'days:3', 'month:10'] as const) {
      expect(isSingleDayPeriod(period), period).toBe(false);
    }
  });
});
