import { describe, expect, it } from 'vitest';

import { localDateParts } from '../classifier/dates.js';
import {
  isRuled,
  nextOccurrence,
  parseStoredRule,
  recurrenceRuleSchema,
  resolveRecurrence,
  type RecurrenceRule,
} from './recurrence.js';

/**
 * Правило повторения (задача 2.18а).
 *
 * Условие готовности: «каждый вторник вожу сына на плавание» даёт задачу с
 * правилом, а не задачу на ближайший вторник; фраза, которую не удалось
 * разобрать в правило, сохраняется текстом.
 *
 * Отдельно проверяются два края, каждый из которых уже кусал на задаче
 * 2.7: конец месяца и переход на летнее время.
 */

const MOSCOW = 'Europe/Moscow';
const VLADIVOSTOK = 'Asia/Vladivostok';
const KALININGRAD = 'Europe/Kaliningrad';
const BERLIN = 'Europe/Berlin';
const KAMCHATKA = 'Asia/Kamchatka';

/** Локальная дата момента: то, что человек видит в своём поясе. */
function localDate(at: Date, zone: string): string {
  const parts = localDateParts(at, zone);
  return `${String(parts.year)}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

const rule = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  kind: 'weekly',
  interval: 1,
  anchor: '2026-09-01',
  ...over,
});

describe('приведение ответа модели к правилу', () => {
  it('«каждый вторник» даёт правило, опирающееся на срок', () => {
    // Условие готовности задачи. День недели берётся из срока, который
    // модель и так вернула: отдельного поля под него нет намеренно.
    const resolved = resolveRecurrence({
      kind: 'weekly',
      interval: 1,
      text: 'каждый вторник',
      deadline: '2026-09-01',
    });

    expect(resolved.rule).toEqual({ kind: 'weekly', interval: 1, anchor: '2026-09-01' });
    expect(resolved.text).toBe('каждый вторник');
    expect(resolved.source).toBe('stated');
    expect(resolved.problem).toBeUndefined();
  });

  it('«не регулярное» не даёт ни правила, ни фразы', () => {
    const resolved = resolveRecurrence({
      kind: 'none',
      interval: 0,
      // Модель может заполнить фразу и при этом сказать «не регулярное».
      // Верим виду: его она выбирает из списка, фразу пишет свободно.
      text: 'в четверг',
      deadline: '2026-09-03',
    });

    expect(resolved).toEqual({});
  });

  it('непонятая регулярность сохраняется фразой без правила', () => {
    // «Каждый вторник и четверг» закрытым набором не выражается. Выдумать
    // правило, которого мы не умеем воспроизвести, хуже, чем признаться.
    const resolved = resolveRecurrence({
      kind: 'unclear',
      interval: 1,
      text: 'каждый вторник и четверг',
      deadline: '2026-09-01',
    });

    expect(resolved.rule).toBeUndefined();
    expect(resolved.text).toBe('каждый вторник и четверг');
    expect(resolved.source).toBe('stated');
    expect(resolved.problem).toContain('закрытым набором');
  });

  it('без срока правила нет, а фраза есть', () => {
    // Правило опирается на срок: без него неизвестен ни день недели, ни
    // число месяца.
    const resolved = resolveRecurrence({
      kind: 'monthly',
      interval: 1,
      text: 'раз в месяц',
      deadline: '',
    });

    expect(resolved.rule).toBeUndefined();
    expect(resolved.text).toBe('раз в месяц');
    expect(resolved.problem).toContain('срока');
  });

  it('вид без фразы — рассогласование, и правила из него не выйдет', () => {
    // Показывать человеку «регулярное» без его слов нельзя: он не узнает,
    // о чём речь.
    const resolved = resolveRecurrence({
      kind: 'weekly',
      interval: 1,
      text: '   ',
      deadline: '2026-09-01',
    });

    expect(resolved.rule).toBeUndefined();
    expect(resolved.text).toBeUndefined();
    expect(resolved.problem).toContain('без фразы');
  });

  it('нулевой и отрицательный интервал приводятся к единице', () => {
    for (const interval of [0, -3]) {
      const resolved = resolveRecurrence({
        kind: 'weekly',
        interval,
        text: 'каждую неделю',
        deadline: '2026-09-01',
      });

      expect(resolved.rule?.interval).toBe(1);
    }
  });

  it('слишком большой интервал обрезается по предельному', () => {
    const resolved = resolveRecurrence({
      kind: 'daily',
      interval: 5000,
      text: 'каждые пять тысяч дней',
      deadline: '2026-09-01',
    });

    expect(resolved.rule?.interval).toBe(99);
  });

  it('кривой срок правила не даёт', () => {
    for (const deadline of ['01.09.2026', '2026-9-1', 'завтра']) {
      const resolved = resolveRecurrence({
        kind: 'weekly',
        interval: 1,
        text: 'каждый вторник',
        deadline,
      });

      expect(resolved.rule, deadline).toBeUndefined();
      expect(resolved.text, deadline).toBe('каждый вторник');
    }
  });
});

describe('схема правила', () => {
  it('пропускает все пять видов', () => {
    for (const kind of ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'] as const) {
      expect(recurrenceRuleSchema.safeParse(rule({ kind })).success, kind).toBe(true);
      expect(isRuled(kind)).toBe(true);
    }
  });

  it('отвергает выдуманный вид и кривой якорь', () => {
    expect(recurrenceRuleSchema.safeParse({ ...rule(), kind: 'каждый вторник' }).success).toBe(
      false,
    );
    expect(recurrenceRuleSchema.safeParse({ ...rule(), anchor: '01.09.2026' }).success).toBe(false);
    expect(recurrenceRuleSchema.safeParse({ ...rule(), interval: 0 }).success).toBe(false);
  });

  it('правило из базы приходит как unknown и проверяется', () => {
    // В базе это jsonb: обещаниям типов тут верить нельзя.
    expect(parseStoredRule(rule())).toEqual(rule());
    expect(parseStoredRule({ kind: 'мусор' })).toBeUndefined();
    expect(parseStoredRule(null)).toBeUndefined();
    expect(parseStoredRule('строка')).toBeUndefined();
  });
});

describe('следующее повторение', () => {
  it('якорь в будущем и есть следующее повторение', () => {
    const at = nextOccurrence(rule({ anchor: '2026-09-08' }), {
      after: new Date('2026-09-01T09:00:00.000Z'),
      timeZone: MOSCOW,
    });

    expect(localDate(at, MOSCOW)).toBe('2026-09-08');
  });

  it('каждую неделю — через семь дней от якоря', () => {
    const at = nextOccurrence(rule({ anchor: '2026-09-01' }), {
      after: new Date('2026-09-01T09:00:00.000Z'),
      timeZone: MOSCOW,
    });

    expect(localDate(at, MOSCOW)).toBe('2026-09-08');
  });

  it('раз в две недели — через четырнадцать', () => {
    const at = nextOccurrence(rule({ interval: 2 }), {
      after: new Date('2026-09-01T09:00:00.000Z'),
      timeZone: MOSCOW,
    });

    expect(localDate(at, MOSCOW)).toBe('2026-09-15');
  });

  it('давно пропущенное правило догоняет до будущего, а не отдаёт прошлое', () => {
    // Человек мог не заходить месяц. Следующее повторение — впереди, а не
    // то, которое он пропустил: иначе оно тут же покажется просроченным.
    const at = nextOccurrence(rule({ anchor: '2026-01-06' }), {
      after: new Date('2026-09-01T09:00:00.000Z'),
      timeZone: MOSCOW,
    });

    expect(at.getTime()).toBeGreaterThan(new Date('2026-09-01T09:00:00.000Z').getTime());
    // И это по-прежнему вторник, как якорь.
    expect(new Date(localDate(at, MOSCOW)).getUTCDay()).toBe(2);
  });

  it('по будням выходные пропускает', () => {
    // Пятница 4 сентября 2026 → следующий рабочий день понедельник 7-е.
    const at = nextOccurrence(rule({ kind: 'weekdays', anchor: '2026-09-04' }), {
      after: new Date('2026-09-04T09:00:00.000Z'),
      timeZone: MOSCOW,
    });

    expect(localDate(at, MOSCOW)).toBe('2026-09-07');
  });

  it('каждый день — через день', () => {
    const at = nextOccurrence(rule({ kind: 'daily', anchor: '2026-09-01' }), {
      after: new Date('2026-09-01T09:00:00.000Z'),
      timeZone: MOSCOW,
    });

    expect(localDate(at, MOSCOW)).toBe('2026-09-02');
  });

  it('раз в год — через год, с тем же числом', () => {
    const at = nextOccurrence(rule({ kind: 'yearly', anchor: '2026-09-14' }), {
      after: new Date('2026-09-14T09:00:00.000Z'),
      timeZone: MOSCOW,
    });

    expect(localDate(at, MOSCOW)).toBe('2027-09-14');
  });
});

describe('конец месяца', () => {
  it('31 января плюс месяц — это последний день февраля, а не 3 марта', () => {
    // Молчаливый переход через край месяца мы уже разбирали на 2.7.
    const at = nextOccurrence(rule({ kind: 'monthly', anchor: '2026-01-31' }), {
      after: new Date('2026-01-31T09:00:00.000Z'),
      timeZone: MOSCOW,
    });

    expect(localDate(at, MOSCOW)).toBe('2026-02-28');
  });

  it('31 марта плюс месяц — 30 апреля', () => {
    const at = nextOccurrence(rule({ kind: 'monthly', anchor: '2026-03-31' }), {
      after: new Date('2026-03-31T09:00:00.000Z'),
      timeZone: MOSCOW,
    });

    expect(localDate(at, MOSCOW)).toBe('2026-04-30');
  });

  it('29 февраля в невисокосный год становится 28-м', () => {
    const at = nextOccurrence(rule({ kind: 'yearly', anchor: '2028-02-29' }), {
      after: new Date('2028-02-29T09:00:00.000Z'),
      timeZone: MOSCOW,
    });

    expect(localDate(at, MOSCOW)).toBe('2029-02-28');
  });
});

describe('часовые пояса', () => {
  it('дата одна и та же во всех поясах, а момент разный', () => {
    // Правило говорит про календарные дни: «каждый вторник» — это вторник,
    // во сколько бы человек ни вспомнил о деле.
    const moments = [MOSCOW, VLADIVOSTOK, KALININGRAD, BERLIN, KAMCHATKA].map((zone) => ({
      zone,
      at: nextOccurrence(rule({ anchor: '2026-09-01' }), {
        after: new Date('2026-09-01T09:00:00.000Z'),
        timeZone: zone,
      }),
    }));

    for (const { zone, at } of moments) {
      expect(localDate(at, zone), zone).toBe('2026-09-08');
    }

    // Начало суток во Владивостоке наступает раньше, чем в Калининграде.
    const times = moments.map(({ at }) => at.getTime());
    expect(new Set(times).size).toBeGreaterThan(1);
  });

  it('переход на летнее время не сдвигает дату', () => {
    // В Берлине 29 марта 2026 часы переводят вперёд. Начало суток
    // считается через Intl, и своей таблицы поясов у нас нет.
    const at = nextOccurrence(rule({ kind: 'daily', anchor: '2026-03-28' }), {
      after: new Date('2026-03-28T09:00:00.000Z'),
      timeZone: BERLIN,
    });

    expect(localDate(at, BERLIN)).toBe('2026-03-29');
  });

  it('и обратный переход тоже', () => {
    // 25 октября 2026 в Берлине часы переводят назад.
    const at = nextOccurrence(rule({ kind: 'daily', anchor: '2026-10-24' }), {
      after: new Date('2026-10-24T09:00:00.000Z'),
      timeZone: BERLIN,
    });

    expect(localDate(at, BERLIN)).toBe('2026-10-25');
  });
});
