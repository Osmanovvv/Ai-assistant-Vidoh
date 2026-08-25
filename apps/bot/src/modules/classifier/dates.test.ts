import { describe, expect, it } from 'vitest';

import { describeNow, localDateParts, resolveDeadline, startOfDayInZone } from './dates.js';

/**
 * Сроки — самый частый источник тихих ошибок: они не падают, а ставят
 * напоминание не в тот день. Поэтому проверяется не «функция работает»,
 * а конкретные даты в конкретных поясах, включая переход на летнее время
 * и границу суток.
 *
 * Часы управляемые: тест, зависящий от настоящего «сейчас», однажды
 * покраснеет сам по себе.
 */

const MOSCOW = 'Europe/Moscow';
const VLADIVOSTOK = 'Asia/Vladivostok';
const BERLIN = 'Europe/Berlin';

/** Пятница, 4 сентября 2026, 12:00 по Москве. */
const NOW = new Date('2026-09-04T09:00:00.000Z');

describe('startOfDayInZone', () => {
  it('одна и та же дата в разных поясах — разные моменты', () => {
    // Условие готовности задачи 2.7 в чистом виде.
    const moscow = startOfDayInZone({ year: 2026, month: 9, day: 10 }, MOSCOW);
    const vladivostok = startOfDayInZone({ year: 2026, month: 9, day: 10 }, VLADIVOSTOK);

    expect(moscow.toISOString()).toBe('2026-09-09T21:00:00.000Z');
    expect(vladivostok.toISOString()).toBe('2026-09-09T14:00:00.000Z');
    expect(moscow.getTime()).not.toBe(vladivostok.getTime());
  });

  it('учитывает летнее время там, где оно есть', () => {
    // Берлин зимой +1, летом +2. Своя таблица поясов такое бы проспала.
    const winter = startOfDayInZone({ year: 2026, month: 1, day: 15 }, BERLIN);
    const summer = startOfDayInZone({ year: 2026, month: 7, day: 15 }, BERLIN);

    expect(winter.toISOString()).toBe('2026-01-14T23:00:00.000Z');
    expect(summer.toISOString()).toBe('2026-07-14T22:00:00.000Z');
  });

  it('в Москве перехода нет: зима и лето одинаково', () => {
    const winter = startOfDayInZone({ year: 2026, month: 1, day: 15 }, MOSCOW);
    const summer = startOfDayInZone({ year: 2026, month: 7, day: 15 }, MOSCOW);

    expect(winter.toISOString()).toBe('2026-01-14T21:00:00.000Z');
    expect(summer.toISOString()).toBe('2026-07-14T21:00:00.000Z');
  });

  it('день перехода на летнее время не уезжает на сутки', () => {
    // В Берлине 29 марта 2026 часы переводят в 02:00. Полночь этого дня
    // ещё по зимнему времени.
    const at = startOfDayInZone({ year: 2026, month: 3, day: 29 }, BERLIN);

    expect(at.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(localDateParts(at, BERLIN)).toEqual({ year: 2026, month: 3, day: 29 });
  });
});

describe('localDateParts', () => {
  it('за границей суток пояса дают разные даты', () => {
    // 4 сентября 23:30 по Москве — это уже 5 сентября во Владивостоке.
    const instant = new Date('2026-09-04T20:30:00.000Z');

    expect(localDateParts(instant, MOSCOW)).toEqual({ year: 2026, month: 9, day: 4 });
    expect(localDateParts(instant, VLADIVOSTOK)).toEqual({ year: 2026, month: 9, day: 5 });
  });
});

describe('describeNow', () => {
  it('называет день недели: без него не разрешить «в четверг»', () => {
    const described = describeNow(NOW, MOSCOW);

    expect(described).toContain('пятница');
    expect(described).toContain('4 сентября 2026');
    expect(described).toContain(MOSCOW);
  });

  it('в другом поясе то же мгновение описывается иначе', () => {
    // Ровно поэтому одна фраза в разных поясах даёт разные даты.
    const instant = new Date('2026-09-04T20:30:00.000Z');

    expect(describeNow(instant, MOSCOW)).toContain('4 сентября');
    expect(describeNow(instant, VLADIVOSTOK)).toContain('5 сентября');
  });
});

describe('resolveDeadline', () => {
  const context = { now: NOW, timeZone: MOSCOW };

  it('привязывает дату к началу суток в поясе человека', () => {
    const outcome = resolveDeadline({ deadline: '2026-09-10', accuracy: 'day' }, context);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.deadline) throw new Error('ожидался срок');
    expect(outcome.deadline.at.toISOString()).toBe('2026-09-09T21:00:00.000Z');
    expect(outcome.deadline.accuracy).toBe('day');
  });

  it('одна дата в двух поясах даёт разные моменты', () => {
    const moscow = resolveDeadline({ deadline: '2026-09-10', accuracy: 'day' }, context);
    const vladivostok = resolveDeadline(
      { deadline: '2026-09-10', accuracy: 'day' },
      { now: NOW, timeZone: VLADIVOSTOK },
    );

    if (!moscow.ok || !moscow.deadline || !vladivostok.ok || !vladivostok.deadline) {
      throw new Error('ожидались сроки');
    }

    expect(moscow.deadline.at.getTime()).not.toBe(vladivostok.deadline.at.getTime());
  });

  it('сохраняет точность недели и месяца', () => {
    const week = resolveDeadline({ deadline: '2026-09-07', accuracy: 'week' }, context);
    const month = resolveDeadline({ deadline: '2026-10-01', accuracy: 'month' }, context);

    if (!week.ok || !week.deadline || !month.ok || !month.deadline) {
      throw new Error('ожидались сроки');
    }

    // Без точности напоминание про «следующую неделю» сработало бы в
    // конкретный день и не в тот.
    expect(week.deadline.accuracy).toBe('week');
    expect(month.deadline.accuracy).toBe('month');
  });

  it('сегодняшний срок принимается', () => {
    // «В четверг», сказанное в четверг, может означать сегодня.
    const outcome = resolveDeadline({ deadline: '2026-09-04', accuracy: 'day' }, context);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.deadline) throw new Error('ожидался срок');
    expect(localDateParts(outcome.deadline.at, MOSCOW).day).toBe(4);
  });

  describe('срока нет', () => {
    it('пустая строка — не ошибка', () => {
      const outcome = resolveDeadline({ deadline: '', accuracy: 'none' }, context);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.deadline).toBeUndefined();
    });

    it('точность none при заполненной дате тоже означает «нет срока»', () => {
      // Рассогласование в ответе модели, но не повод терять запись.
      const outcome = resolveDeadline({ deadline: '2026-09-10', accuracy: 'none' }, context);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.deadline).toBeUndefined();
    });

    it('дата без точности тоже', () => {
      const outcome = resolveDeadline({ deadline: '   ', accuracy: 'day' }, context);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.deadline).toBeUndefined();
    });
  });

  describe('срок отвергается', () => {
    it('прошлое: человек не ставит задачи на вчера', () => {
      // Почти наверняка модель неверно разрешила «в четверг». Запись без
      // срока лучше записи с неверным: напоминание не вовремя хуже
      // не пришедшего.
      const outcome = resolveDeadline({ deadline: '2026-09-03', accuracy: 'day' }, context);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toContain('в прошлом');
    });

    it('не та форма записи', () => {
      for (const deadline of ['в четверг', '10.09.2026', '2026-9-10', '2026-09-10T12:00']) {
        const outcome = resolveDeadline({ deadline, accuracy: 'day' }, context);
        expect(outcome.ok, deadline).toBe(false);
      }
    });

    it('несуществующее число', () => {
      // 31 февраля молча превратилось бы в 3 марта.
      const outcome = resolveDeadline({ deadline: '2027-02-31', accuracy: 'day' }, context);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toContain('не существует');
    });

    it('невозможный месяц', () => {
      expect(resolveDeadline({ deadline: '2026-13-01', accuracy: 'day' }, context).ok).toBe(false);
    });

    it('слишком далёкое будущее: модель ошиблась в годе', () => {
      const outcome = resolveDeadline({ deadline: '2099-01-01', accuracy: 'day' }, context);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toContain('слишком далеко');
    });
  });
});
