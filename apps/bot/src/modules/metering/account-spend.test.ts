import { describe, expect, it } from 'vitest';

import {
  ceilingFromEnv,
  ceilingVerdict,
  rublesOf,
  windowStart,
  type SpendCeiling,
} from './account-spend.js';

/**
 * Решение по потолку расхода (задача 3.79).
 *
 * **Половина проверок ниже — про то, чего делать нельзя.** От этого
 * правила зависит, ответит ли бот вообще: ошибись оно в сторону
 * «превышено» — и человек не получит разбора из-за опечатки в настройке.
 */

const CEILING: SpendCeiling = { micros: 1_000_000_000, currency: 'rub' }; // 1000 ₽
const WARN = 0.8;

const spent = (micros: number, partial = false) => ({ spentMicros: micros, partial });

describe('ceilingVerdict', () => {
  it('под потолком — ни остановки, ни предупреждения', () => {
    const verdict = ceilingVerdict(spent(500_000_000), CEILING, WARN);

    expect(verdict.exceeded).toBe(false);
    expect(verdict.warn).toBe(false);
    expect(verdict.share).toBeCloseTo(0.5);
  });

  it('на пороге предупреждения — предупреждаем, но не останавливаем', () => {
    /**
     * Ради этого порог и нужен: узнать заранее. 05.09.2026 узнали из
     * отказа, когда бот уже встал.
     */
    const verdict = ceilingVerdict(spent(800_000_000), CEILING, WARN);

    expect(verdict.warn).toBe(true);
    expect(verdict.exceeded).toBe(false);
  });

  it('ровно потолок — уже превышение', () => {
    // Иначе последний вызов уходит «в счёт следующего рубля», и потолок
    // оказывается не потолком, а полом.
    expect(ceilingVerdict(spent(1_000_000_000), CEILING, WARN).exceeded).toBe(true);
  });

  it('выше потолка — превышение', () => {
    expect(ceilingVerdict(spent(1_500_000_000), CEILING, WARN).exceeded).toBe(true);
  });

  it('неполный счёт превышение не отменяет', () => {
    /**
     * **Здесь потолок ведёт себя иначе, чем мягкий лимит §10.5, и это
     * осознанно.** Тот при незнании цены отказывается работать: он
     * ухудшает выдачу человеку, и делать это на догадке нельзя.
     *
     * Потолок сравнивает с **нижней** оценкой расхода. Если она уже
     * перешла потолок, настоящий расход перешёл тем более: ошибиться
     * можно только в одну сторону — пропустить превышение, а не
     * выдумать его.
     */
    const verdict = ceilingVerdict(spent(1_200_000_000, true), CEILING, WARN);

    expect(verdict.exceeded).toBe(true);
    expect(verdict.partial).toBe(true);
  });

  describe('чего делать нельзя', () => {
    it('потолок в ноль считается невыставленным, а не превышенным всегда', () => {
      /**
       * Самая опасная опечатка в настройке. «Превышено всегда» означает
       * бота, который молча не отвечает никому, — и причину этого
       * человек будет искать в разборе, а не в переменной окружения.
       */
      for (const micros of [0, -1, -1_000_000, Number.NaN, Number.POSITIVE_INFINITY]) {
        const verdict = ceilingVerdict(spent(5_000_000_000), { micros, currency: 'rub' }, WARN);

        expect(verdict.exceeded, String(micros)).toBe(false);
        expect(verdict.warn, String(micros)).toBe(false);
      }
    });

    it('нулевой расход при живом потолке — не превышение', () => {
      const verdict = ceilingVerdict(spent(0), CEILING, WARN);

      expect(verdict.exceeded).toBe(false);
      expect(verdict.warn).toBe(false);
    });
  });
});

describe('windowStart', () => {
  it('сутки считаются по UTC, а не в чьём-то поясе', () => {
    /**
     * Потолок защищает **счёт**, а счёт у провайдера один и живёт не в
     * поясе человека. Привяжи сутки к местному дню — и у двух людей из
     * разных поясов один и тот же счёт кончался бы в разные моменты.
     */
    expect(windowStart('day', new Date('2026-09-06T02:30:00.000Z'))?.toISOString()).toBe(
      '2026-09-06T00:00:00.000Z',
    );
    expect(windowStart('day', new Date('2026-09-06T23:59:59.000Z'))?.toISOString()).toBe(
      '2026-09-06T00:00:00.000Z',
    );
  });

  it('окно «за всё время» начала не имеет', () => {
    expect(windowStart('all', new Date('2026-09-06T02:30:00.000Z'))).toBeUndefined();
  });
});

describe('ceilingFromEnv', () => {
  it('рубли снаружи, микрорубли внутри', () => {
    expect(ceilingFromEnv(4000)).toEqual({ micros: 4_000_000_000, currency: 'rub' });
  });

  it('не задан — потолка нет, и это законное состояние', () => {
    expect(ceilingFromEnv(undefined)).toBeUndefined();
  });

  it('дробные рубли не теряются в копейках', () => {
    expect(ceilingFromEnv(0.5)).toEqual({ micros: 500_000, currency: 'rub' });
  });
});

describe('rublesOf', () => {
  it('печатает рубли с копейками — для человека, не для сравнений', () => {
    expect(rublesOf(1_234_567_890)).toBe('1234.57');
    expect(rublesOf(0)).toBe('0.00');
  });
});
