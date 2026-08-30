import { describe, expect, it } from 'vitest';

import { localDateKey, localTimeToUtc, nextLocalTime, parseLocalTime } from './time.js';

/**
 * Расчёт времени в поясах (задача 3.14).
 *
 * План просит «модульные с управляемыми часами на расчёт времени в 5
 * поясах, включая переход через полночь». Часы здесь управляемые в самом
 * буквальном смысле: ни одна функция не зовёт `new Date()` без аргумента,
 * момент всегда приходит снаружи.
 *
 * Пять поясов — не для красоты счёта. Калининград и Камчатка разнесены на
 * девять часов, и утро одного приходится на вечер другого; Лондон нужен
 * ради перехода на летнее время, которого в России нет; Катманду — ради
 * смещения в 5:45, на котором ломается всё, что считает пояса целыми
 * часами.
 */

const ZONES = {
  kaliningrad: 'Europe/Kaliningrad', // UTC+2
  moscow: 'Europe/Moscow', // UTC+3
  yekaterinburg: 'Asia/Yekaterinburg', // UTC+5
  kathmandu: 'Asia/Kathmandu', // UTC+5:45 — не целый час
  kamchatka: 'Asia/Kamchatka', // UTC+12
} as const;

/** Как выглядит момент в этом поясе: «2026-08-30 08:30». */
function shownIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  })
    .format(at)
    .replace(',', '');
}

describe('час, названный человеком, наступает в его поясе', () => {
  const day = { year: 2026, month: 8, day: 30 };

  it.each(Object.entries(ZONES))('%s: 08:30 — это 08:30', (_name, zone) => {
    const at = localTimeToUtc(day, '08:30', zone);

    expect(shownIn(at, zone)).toBe('2026-08-30 08:30');
  });

  it('пять поясов дают пять разных моментов', () => {
    const moments = Object.values(ZONES).map((zone) =>
      localTimeToUtc(day, '08:30', zone).toISOString(),
    );

    expect(new Set(moments).size).toBe(5);
  });

  it('на Камчатке утро наступает раньше, чем в Калининграде', () => {
    const kamchatka = localTimeToUtc(day, '08:30', ZONES.kamchatka);
    const kaliningrad = localTimeToUtc(day, '08:30', ZONES.kaliningrad);

    expect(kamchatka.getTime()).toBeLessThan(kaliningrad.getTime());
    expect(kaliningrad.getTime() - kamchatka.getTime()).toBe(10 * 60 * 60_000);
  });

  it('смещение в 5:45 не округляется', () => {
    const at = localTimeToUtc(day, '08:30', ZONES.kathmandu);

    expect(at.toISOString()).toBe('2026-08-30T02:45:00.000Z');
  });
});

describe('переход на летнее время', () => {
  /**
   * В России перехода нет с 2014 года, поэтому проверяем на Лондоне.
   * Код о поясах ничего не предполагает, и это единственный способ
   * убедиться, что предположение действительно не зашито.
   */
  const london = 'Europe/London';

  it('летом 08:30 — это 07:30 UTC', () => {
    const at = localTimeToUtc({ year: 2026, month: 7, day: 15 }, '08:30', london);

    expect(at.toISOString()).toBe('2026-07-15T07:30:00.000Z');
    expect(shownIn(at, london)).toBe('2026-07-15 08:30');
  });

  it('зимой 08:30 — это 08:30 UTC', () => {
    const at = localTimeToUtc({ year: 2026, month: 1, day: 15 }, '08:30', london);

    expect(at.toISOString()).toBe('2026-01-15T08:30:00.000Z');
  });

  it('в ночь перевода стрелок вперёд утро всё равно наступает в 08:30', () => {
    // 29 марта 2026 в 01:00 стрелки уходят на 02:00: сутки короче на час.
    const at = localTimeToUtc({ year: 2026, month: 3, day: 29 }, '08:30', london);

    expect(shownIn(at, london)).toBe('2026-03-29 08:30');
  });

  it('в ночь перевода стрелок назад — тоже', () => {
    const at = localTimeToUtc({ year: 2026, month: 10, day: 25 }, '08:30', london);

    expect(shownIn(at, london)).toBe('2026-10-25 08:30');
  });
});

describe('следующее наступление', () => {
  it('час ещё не прошёл — сегодня', () => {
    const now = new Date('2026-08-30T02:00:00.000Z'); // 05:00 в Москве
    const at = nextLocalTime(now, '08:30', ZONES.moscow);

    expect(shownIn(at, ZONES.moscow)).toBe('2026-08-30 08:30');
  });

  it('час уже прошёл — завтра, а не в прошлое', () => {
    const now = new Date('2026-08-30T06:00:00.000Z'); // 09:00 в Москве
    const at = nextLocalTime(now, '08:30', ZONES.moscow);

    expect(at.getTime()).toBeGreaterThan(now.getTime());
    expect(shownIn(at, ZONES.moscow)).toBe('2026-08-31 08:30');
  });

  it('ровно в назначенную минуту — сегодня, а не завтра', () => {
    // Регрессия. Строгое сравнение уводило напоминание на сутки, если
    // проход планировщика случался секунда в секунду, и человек оставался
    // без него молча. От повторной отправки защищает ключ задания.
    const now = localTimeToUtc({ year: 2026, month: 8, day: 30 }, '08:30', ZONES.moscow);
    const at = nextLocalTime(now, '08:30', ZONES.moscow);

    expect(shownIn(at, ZONES.moscow)).toBe('2026-08-30 08:30');
  });

  it('минутой позже — уже завтра', () => {
    const now = new Date(
      localTimeToUtc({ year: 2026, month: 8, day: 30 }, '08:30', ZONES.moscow).getTime() + 60_000,
    );

    expect(shownIn(nextLocalTime(now, '08:30', ZONES.moscow), ZONES.moscow)).toBe(
      '2026-08-31 08:30',
    );
  });

  it.each(Object.entries(ZONES))('%s: всегда в будущем и всегда в 21:00', (_name, zone) => {
    const now = new Date('2026-08-30T14:23:11.000Z');
    const at = nextLocalTime(now, '21:00', zone);

    expect(at.getTime()).toBeGreaterThan(now.getTime());
    expect(shownIn(at, zone).slice(-5)).toBe('21:00');
  });
});

describe('переход через полночь', () => {
  /**
   * Самый частый источник ошибок: момент один, а даты у людей разные.
   * В 22:30 UTC в Москве и Калининграде уже завтра, а в Лондоне сегодня —
   * и ключ задания, собранный не в том поясе, разъедется на сутки.
   */
  const at = new Date('2026-08-30T22:30:00.000Z');

  it('в Москве уже 31-е', () => {
    expect(localDateKey(at, ZONES.moscow)).toBe('2026-08-31');
  });

  it('в Калининграде тоже 31-е: полночь там уже прошла', () => {
    expect(localDateKey(at, ZONES.kaliningrad)).toBe('2026-08-31');
  });

  it('в Лондоне ещё 30-е — тот же момент, другая дата', () => {
    expect(localDateKey(at, 'Europe/London')).toBe('2026-08-30');
  });

  it('на Камчатке уже 31-е', () => {
    expect(localDateKey(at, ZONES.kamchatka)).toBe('2026-08-31');
  });

  it('вечернее в 23:30 не уезжает на сутки вперёд', () => {
    // 23:30 по-местному 30-го — это ключ «30», а не «31», даже если в UTC
    // уже 31-е. Иначе на следующем проходе планировщик поставит второе.
    const evening = localTimeToUtc({ year: 2026, month: 8, day: 30 }, '23:30', ZONES.moscow);

    expect(evening.toISOString()).toBe('2026-08-30T20:30:00.000Z');
    expect(localDateKey(evening, ZONES.moscow)).toBe('2026-08-30');
  });

  it('полночь принадлежит наступившему дню', () => {
    const midnight = localTimeToUtc({ year: 2026, month: 8, day: 30 }, '00:00', ZONES.moscow);

    expect(localDateKey(midnight, ZONES.moscow)).toBe('2026-08-30');
  });
});

describe('разбор времени', () => {
  it('читает «08:30»', () => {
    expect(parseLocalTime('08:30')).toEqual({ hours: 8, minutes: 30 });
  });

  it('читает формат базы «21:00:00»', () => {
    expect(parseLocalTime('21:00:00')).toEqual({ hours: 21, minutes: 0 });
  });

  it('мусор не роняет расчёт', () => {
    expect(parseLocalTime('')).toEqual({ hours: 0, minutes: 0 });
    expect(parseLocalTime('99:99')).toEqual({ hours: 23, minutes: 59 });
  });
});
