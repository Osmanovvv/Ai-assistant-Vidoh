import { describe, expect, it } from 'vitest';

import {
  describeToday,
  isoDateIn,
  localDateParts,
  namedWeekday,
  nearestWeekday,
  resolveDeadline,
  startOfDayInZone,
} from './dates.js';

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

describe('describeToday', () => {
  it('называет день недели: без него не разрешить «в четверг»', () => {
    const described = describeToday(NOW, MOSCOW);

    expect(described).toContain('пятница');
    expect(described).toContain('4 сентября 2026');
    expect(described).toContain(MOSCOW);
  });

  it('в другом поясе то же мгновение описывается иначе', () => {
    // Ровно поэтому одна фраза в разных поясах даёт разные даты.
    const instant = new Date('2026-09-04T20:30:00.000Z');

    expect(describeToday(instant, MOSCOW)).toContain('4 сентября');
    expect(describeToday(instant, VLADIVOSTOK)).toContain('5 сентября');
  });

  it('дважды за день описывает день одинаково', () => {
    /**
     * То самое свойство, из-за которого починка и делалась (задача 3.23).
     *
     * Раньше сюда уходили часы и минуты, и один и тот же текст, сказанный
     * в 11:06 и в 12:11, приходил модели **разным входом** — с разным
     * разбором на выходе. Замер на живой модели показал: при одинаковом
     * входе ответ совпадает, при разном времени того же дня расходится.
     *
     * Времена ниже — настоящие, из трёх выгрузок с боевого 31.08.2026.
     */
    const morning = new Date('2026-08-31T08:06:49.000Z');
    const noon = new Date('2026-08-31T09:03:55.000Z');
    const later = new Date('2026-08-31T09:11:55.000Z');

    expect(describeToday(noon, MOSCOW)).toBe(describeToday(morning, MOSCOW));
    expect(describeToday(later, MOSCOW)).toBe(describeToday(morning, MOSCOW));
  });

  it('часов и минут в описании нет', () => {
    /**
     * Прежний тест проверял только, что нужное **есть**, — и остался
     * зелёным, когда часы убрали. Проверять надо и то, чего быть не
     * должно: иначе минуты вернутся следующей правкой, и никто не
     * заметит.
     */
    const described = describeToday(new Date('2026-08-31T09:11:55.000Z'), MOSCOW);

    expect(described).not.toMatch(/\d{1,2}:\d{2}/u);
  });

  it('через сутки описание меняется', () => {
    // Обратная сторона: «в четверг» от разных дней — разные даты, и
    // одинаковое описание здесь было бы ошибкой.
    const monday = new Date('2026-08-31T09:00:00.000Z');
    const tuesday = new Date('2026-09-01T09:00:00.000Z');

    expect(describeToday(tuesday, MOSCOW)).not.toBe(describeToday(monday, MOSCOW));
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

  it('неточный срок хранится началом периода: неделя — понедельником, месяц — первым числом', () => {
    /**
     * Ручной прогон 15.09.2026 (вторник) на бою: «записаться к
     * стоматологу на следующей неделе» → модель вернула 22.09, вторник
     * через неделю, с точностью `week`. Код вокруг считает, что неделя
     * хранится понедельником (`filter.ts`, планировщик мягкого возврата):
     * возврат ушёл бы во вторник 22-го, а не утром понедельника 21-го,
     * и карточка говорила бы «около 22 сентября». Дата модели — это
     * день внутри периода; хранится начало периода.
     */
    const tuesday = { now: new Date('2026-09-15T05:00:00.000Z'), timeZone: 'Asia/Omsk' };

    const week = resolveDeadline(
      { deadline: '2026-09-22', accuracy: 'week' },
      { ...tuesday, said: 'записаться к стоматологу на следующей неделе' },
    );
    if (!week.ok || !week.deadline) throw new Error('ожидался срок');
    // Понедельник 21.09, начало суток по Омску (UTC+6).
    expect(week.deadline.at.toISOString()).toBe('2026-09-20T18:00:00.000Z');
    expect(week.deadline.accuracy).toBe('week');

    const month = resolveDeadline(
      { deadline: '2026-10-15', accuracy: 'month' },
      { ...tuesday, said: 'в октябре пройти диспансеризацию' },
    );
    if (!month.ok || !month.deadline) throw new Error('ожидался срок');
    expect(month.deadline.at.toISOString()).toBe('2026-09-30T18:00:00.000Z');
    expect(month.deadline.accuracy).toBe('month');
  });

  it('назван месяц — срок обязан быть в нём: «в октябре» при сентябрьской неделе от модели → 1 октября, месяц (прогон 17.09.2026)', () => {
    /**
     * Бой 17.09.2026, голосовое Никиты: расшифровка склеила «…записаться
     * к стоматологу давно уже откладываю в октябре пройти
     * диспансеризацию», и на диспансеризацию модель вернула 2026-09-21 с
     * точностью `week` — срок соседнего дела. Месяц назван прямо, и дата
     * из него следует однозначно — работа кода, как с днём недели.
     */
    const thursday = { now: new Date('2026-09-17T05:00:00.000Z'), timeZone: 'Europe/Moscow' };

    const fixed = resolveDeadline(
      { deadline: '2026-09-21', accuracy: 'week' },
      { ...thursday, said: 'В октябре пройти диспансеризацию' },
    );
    if (!fixed.ok || !fixed.deadline) throw new Error('ожидался срок');
    // 1 октября, начало суток по Москве.
    expect(fixed.deadline.at.toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(fixed.deadline.accuracy).toBe('month');
    expect(fixed.corrected).toBe('month');

    // Дата уже в названном месяце — не трогается, точность модели остаётся.
    const kept = resolveDeadline(
      { deadline: '2026-10-15', accuracy: 'day' },
      { ...thursday, said: '15 октября пройти диспансеризацию' },
    );
    if (!kept.ok || !kept.deadline) throw new Error('ожидался срок');
    expect(kept.deadline.at.toISOString()).toBe('2026-10-14T21:00:00.000Z');
    expect(kept.deadline.accuracy).toBe('day');
    expect(kept.corrected).toBeUndefined();

    // Месяц уже прошёл в этом году — ближайший такой месяц, то есть следующий год.
    const next = resolveDeadline(
      { deadline: '2026-09-21', accuracy: 'week' },
      { ...thursday, said: 'в марте поменять резину' },
    );
    if (!next.ok || !next.deadline) throw new Error('ожидался срок');
    expect(next.deadline.at.toISOString()).toBe('2027-02-28T21:00:00.000Z');
    expect(next.deadline.accuracy).toBe('month');

    // Названы и месяц, и день недели — решает день недели, как раньше.
    const weekday = resolveDeadline(
      { deadline: '2026-09-21', accuracy: 'day' },
      { ...thursday, said: 'в пятницу в октябре забрать справку' },
    );
    if (!weekday.ok || !weekday.deadline) throw new Error('ожидался срок');
    expect(weekday.deadline.at.toISOString()).toBe('2026-09-17T21:00:00.000Z');
  });

  it('назван день недели — это день, даже если модель сказала «неделя»: «по средам» остаётся средой (голос 4, 18.09.2026)', () => {
    /**
     * Бой: «по средам английский» — модель дала верную среду 23.09 с
     * точностью `week`, укладка на начало периода увела срок на
     * понедельник 21.09, а с ним и якорь правила «по средам». Названный
     * день недели — это день (§2.7), и начало недели ему не нужно.
     */
    const friday = { now: new Date('2026-09-18T13:14:49.000Z'), timeZone: MOSCOW };

    const wednesday = resolveDeadline(
      { deadline: '2026-09-23', accuracy: 'week' },
      { ...friday, said: 'по средам английский' },
    );
    if (!wednesday.ok || !wednesday.deadline) throw new Error('ожидался срок');
    expect(wednesday.deadline.at.toISOString()).toBe('2026-09-22T21:00:00.000Z');
    expect(wednesday.deadline.accuracy).toBe('day');
    expect(wednesday.corrected).toBe('weekday');

    // Модель ещё и день перепутала — правится и день, и точность.
    const fromMonday = resolveDeadline(
      { deadline: '2026-09-21', accuracy: 'week' },
      { ...friday, said: 'по средам английский' },
    );
    if (!fromMonday.ok || !fromMonday.deadline) throw new Error('ожидался срок');
    expect(fromMonday.deadline.at.toISOString()).toBe('2026-09-22T21:00:00.000Z');
    expect(fromMonday.deadline.accuracy).toBe('day');

    // Неделя без дня недели — по-прежнему неделя с понедельника.
    const week = resolveDeadline(
      { deadline: '2026-09-23', accuracy: 'week' },
      { ...friday, said: 'на следующей неделе записаться к стоматологу' },
    );
    if (!week.ok || !week.deadline) throw new Error('ожидался срок');
    expect(week.deadline.at.toISOString()).toBe('2026-09-20T21:00:00.000Z');
    expect(week.deadline.accuracy).toBe('week');
  });

  it('«на выходных» началом периода не трогается: суббота остаётся субботой', () => {
    const tuesday = { now: new Date('2026-09-15T05:00:00.000Z'), timeZone: 'Asia/Omsk' };

    const weekend = resolveDeadline(
      { deadline: '2026-09-19', accuracy: 'week' },
      { ...tuesday, said: 'разобрать балкон на выходных' },
    );
    if (!weekend.ok || !weekend.deadline) throw new Error('ожидался срок');
    expect(weekend.deadline.at.toISOString()).toBe('2026-09-18T18:00:00.000Z');
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

/**
 * Дата в поясе человека (задача 3.74).
 *
 * **Зачем понадобилась.** Якорь правила повторения брался из
 * `toISOString()`, то есть по UTC, — а схема правила требует дату
 * **в поясе человека**. Срок хранится мгновением: четверг у москвича —
 * это среда 21:00 по UTC, и правило «каждый четверг» становилось
 * правилом «каждую среду». Навсегда и у каждого, кто восточнее
 * Гринвича, то есть у всех наших.
 */
describe('названный день недели, совпадающий с сегодняшним', () => {
  /**
   * Голос 10 Никиты, пятница 18.09.2026, 18:21 по Москве: «…хотя нет, к
   * врачу лучше в пятницу». Модель отдала 25.09, код «поправил» на
   * ближайшую пятницу — сегодня, 18.09, — и дело уехало в «сегодня
   * вечером». Тот же день у проджекта 03.09 (четверг, 20:00): «в четверг
   * съездить к родителям» — модель дала 10.09, код вернул на сегодня.
   *
   * Правило: сегодняшний день недели — сегодня только **до полудня**. О
   * сегодняшнем вечере человек говорит «сегодня», а «в пятницу» в
   * пятницу вечером — следующая пятница. Закрытое правило, а не догадка:
   * полдень по поясу человека.
   */
  const FRIDAY_MORNING = { now: new Date('2026-09-18T06:00:00.000Z'), timeZone: MOSCOW };
  const FRIDAY_EVENING = { now: new Date('2026-09-18T15:21:00.000Z'), timeZone: MOSCOW };

  it('утром — сегодня', () => {
    expect(namedWeekday(5, FRIDAY_MORNING).toISOString()).toBe('2026-09-17T21:00:00.000Z');
  });

  it('после полудня — через неделю', () => {
    expect(namedWeekday(5, FRIDAY_EVENING).toISOString()).toBe('2026-09-24T21:00:00.000Z');
  });

  it('ровно полдень — уже через неделю', () => {
    const noon = { now: new Date('2026-09-18T09:00:00.000Z'), timeZone: MOSCOW };
    expect(namedWeekday(5, noon).toISOString()).toBe('2026-09-24T21:00:00.000Z');
  });

  it('другой день недели — ближайший, время суток не важно', () => {
    expect(namedWeekday(6, FRIDAY_EVENING).toISOString()).toBe('2026-09-18T21:00:00.000Z');
    expect(namedWeekday(4, FRIDAY_EVENING).toISOString()).toBe('2026-09-23T21:00:00.000Z');
  });

  it('модель сказала «через неделю» — вечером код её не тянет на сегодня', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-25', accuracy: 'day' },
      { ...FRIDAY_EVENING, said: 'к врачу лучше в пятницу' },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.deadline) throw new Error('ожидался срок');
    expect(outcome.deadline.at.toISOString()).toBe('2026-09-24T21:00:00.000Z');
    expect(outcome.corrected).toBeUndefined();
  });

  it('а утром ту же дату тянет на сегодня: ближайшая пятница', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-25', accuracy: 'day' },
      { ...FRIDAY_MORNING, said: 'в пятницу забрать справку' },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.deadline) throw new Error('ожидался срок');
    expect(outcome.deadline.at.toISOString()).toBe('2026-09-17T21:00:00.000Z');
    expect(outcome.corrected).toBe('weekday');
  });

  it('выходные и неделя — периоды, сегодня в них входит и вечером', () => {
    // «На выходных», сказанное в субботу вечером, — эти выходные.
    const saturdayEvening = { now: new Date('2026-09-19T16:00:00.000Z'), timeZone: MOSCOW };
    expect(nearestWeekday(6, saturdayEvening).toISOString()).toBe('2026-09-18T21:00:00.000Z');
  });
});

describe('isoDateIn', () => {
  it('полночь в поясе человека остаётся его датой', () => {
    /**
     * Так срок и хранится: полночь названного дня в его поясе. Именно
     * здесь `toISOString()` и врал — каждый раз, а не на краю.
     */
    const cases: readonly [string, string, string][] = [
      ['2026-09-04T18:00:00.000Z', 'Asia/Omsk', '2026-09-05'],
      ['2026-09-02T21:00:00.000Z', 'Europe/Moscow', '2026-09-03'],
      ['2026-09-04T22:00:00.000Z', 'Europe/Kaliningrad', '2026-09-05'],
      ['2026-09-04T11:00:00.000Z', 'Asia/Kamchatka', '2026-09-04'],
    ];

    for (const [instant, timeZone, expected] of cases) {
      expect(isoDateIn(new Date(instant), timeZone), `${instant} ${timeZone}`).toBe(expected);
    }
  });

  it('утро омича — уже его сегодня, а не вчерашнее по UTC', () => {
    // 05:00 в Омске (UTC+6) — это 23:00 предыдущего дня по Гринвичу.
    expect(isoDateIn(new Date('2026-09-04T23:00:00.000Z'), 'Asia/Omsk')).toBe('2026-09-05');
  });

  it('в поясе Гринвича совпадает с ISO — иначе сверять было бы нечем', () => {
    expect(isoDateIn(new Date('2026-09-05T10:00:00.000Z'), 'UTC')).toBe('2026-09-05');
  });

  it('день и месяц печатаются двумя знаками', () => {
    // Якорь сверяется с образцом ГГГГ-ММ-ДД, и «2026-9-5» его не прошёл бы.
    expect(isoDateIn(new Date('2026-01-05T12:00:00.000Z'), 'Europe/Moscow')).toBe('2026-01-05');
  });
});
