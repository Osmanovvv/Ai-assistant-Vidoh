import { describe, expect, it } from 'vitest';

import { localDateParts } from '../classifier/dates.js';
import { nextOccurrence, type RecurrenceRule } from './recurrence.js';

/**
 * Привычка, которая живёт дольше предела шагов (ревизия этапов 1–2).
 *
 * **Молчаливый отказ, и самый обидный: он бил по самым ценным делам.**
 * Следующее повторение искалось обходом от якоря по одному шагу, а обход
 * был ограничен четырьмя сотнями. Ежедневная привычка проходит четыреста
 * шагов за четыреста дней — то есть предел срабатывал не на «странных
 * правилах», как обещала оговорка рядом с ним, а на обычных: на тех, что
 * живут дольше года. Оплата садика идёт годами, и ломалась она первой.
 *
 * Что видел человек: на 517-й день «Сделано» переносило срок на дату
 * **116 дней назад**. Дело оставалось просроченным, а каждое следующее
 * «Сделано» считало ту же прошлую дату заново — кнопка переставала
 * работать навсегда, не сказав ни слова. Ни ошибки, ни записи в панели:
 * обработчик не бросал, значит всё «прошло».
 *
 * **Чинится это перескоком, а не большим пределом.** Исчерпание счёта
 * шагов никогда не значит «правило сломано» — оно значит «нам не хватило
 * шагов», и лечится тем, чтобы шаги перестали быть нужны.
 */

const MOSCOW = 'Europe/Moscow';
const DAY = 24 * 60 * 60_000;

function localDate(at: Date, zone: string): string {
  const parts = localDateParts(at, zone);
  return `${String(parts.year)}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

describe('правило переживает предел шагов', () => {
  it('ежедневная привычка на 517-й день даёт завтра, а не прошлое', () => {
    const at = nextOccurrence(
      { kind: 'daily', interval: 1, anchor: '2026-01-01' },
      { after: new Date('2027-06-01T09:00:00.000Z'), timeZone: MOSCOW },
    );

    expect(localDate(at, MOSCOW)).toBe('2027-06-02');
  });

  it('«по будням» через два года даёт следующий будний день', () => {
    // 2027-06-01 — вторник; следующий будний день — среда.
    const at = nextOccurrence(
      { kind: 'weekdays', interval: 1, anchor: '2025-06-02' },
      { after: new Date('2027-06-01T09:00:00.000Z'), timeZone: MOSCOW },
    );

    expect(localDate(at, MOSCOW)).toBe('2027-06-02');
  });

  it('еженедельное правило через восемь лет остаётся в будущем', () => {
    // 428 недель — больше прежнего предела в 400 шагов.
    const at = nextOccurrence(
      { kind: 'weekly', interval: 1, anchor: '2019-01-07' },
      { after: new Date('2027-03-10T09:00:00.000Z'), timeZone: MOSCOW },
    );

    expect(localDate(at, MOSCOW)).toBe('2027-03-15');
  });

  it('никакое суточное правило не отдаёт прошлое — сколько бы лет ни прошло', () => {
    /**
     * Проверка по существу, а не по образцу. Требование одно и его легко
     * прочесть вслух: «следующее повторение» обязано быть позже того
     * момента, после которого его спросили. Такой страж переживёт любую
     * правку арифметики и покраснеет на настоящем промахе.
     */
    const kinds = [
      { kind: 'daily', interval: 1 },
      { kind: 'daily', interval: 3 },
      { kind: 'weekly', interval: 1 },
      { kind: 'weekly', interval: 2 },
      { kind: 'weekdays', interval: 1 },
    ] as const;

    for (const shape of kinds) {
      for (const years of [1, 2, 5, 12]) {
        const after = new Date(Date.UTC(2026, 0, 1) + years * 365 * DAY);
        const at = nextOccurrence({ ...shape, anchor: '2026-01-01' }, { after, timeZone: MOSCOW });

        expect(
          at.getTime(),
          `${shape.kind}/${String(shape.interval)} через ${String(years)} лет отдал прошлое`,
        ).toBeGreaterThan(after.getTime());
      }
    }
  });
});

describe('перескок считает тот же ряд, что и обход по одному', () => {
  /**
   * Быстрый путь ценен ровно настолько, насколько он совпадает с
   * медленным. Здесь рядом стоит **прежний** способ — обход по одному
   * шагу, без всякого предела, — и ответы сверяются день в день.
   *
   * Он повторяет `advance` для суточных видов, и это тот редкий случай,
   * когда второй счёт одного числа уместен: сверять быстрый путь не с
   * чем, кроме медленного. Месячные и годовые сюда не входят намеренно —
   * их никто не перескакивает, и повторять их обрезку по краю месяца
   * значило бы завести настоящий второй счёт.
   */
  function naive(shape: RecurrenceRule, after: Date): string {
    const step = (from: Date): Date => {
      if (shape.kind === 'daily') return new Date(from.getTime() + shape.interval * DAY);
      if (shape.kind === 'weekly') return new Date(from.getTime() + 7 * shape.interval * DAY);

      let next = new Date(from.getTime() + DAY);
      while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
        next = new Date(next.getTime() + DAY);
      }
      return next;
    };

    // Важен только календарный день в поясе человека, поэтому обход идёт
    // по датам без времени.
    const todayIso = localDate(after, MOSCOW);
    let candidate = new Date(`${shape.anchor}T00:00:00.000Z`);
    if (candidate.toISOString().slice(0, 10) > todayIso) return shape.anchor;

    while (candidate.toISOString().slice(0, 10) <= todayIso) candidate = step(candidate);
    return candidate.toISOString().slice(0, 10);
  }

  it('день в день на сотнях сочетаний', () => {
    const shapes: RecurrenceRule[] = [];
    for (const kind of ['daily', 'weekly', 'weekdays'] as const) {
      for (const interval of [1, 2, 3, 5]) {
        for (const anchor of ['2026-01-01', '2026-01-03', '2026-02-28', '2025-11-30']) {
          shapes.push({ kind, interval, anchor });
        }
      }
    }

    for (const shape of shapes) {
      for (const days of [0, 1, 7, 30, 100, 399, 400, 401, 900, 3000]) {
        const after = new Date(Date.UTC(2026, 0, 1, 9) + days * DAY);
        const mine = localDate(nextOccurrence(shape, { after, timeZone: MOSCOW }), MOSCOW);

        expect(
          mine,
          `${shape.kind}/${String(shape.interval)} от ${shape.anchor} через ${String(days)} дней`,
        ).toBe(naive(shape, after));
      }
    }
  });
});

describe('месячные и годовые считаются по-прежнему', () => {
  it('31 января ежемесячно съезжает на 28-е и там остаётся', () => {
    /**
     * Так ведёт себя обход: 31 января плюс месяц — это 28 февраля, а
     * дальше 28 марта, а не 31-е. Перескок дал бы 31 марта, то есть
     * молча изменил бы сроки уже заведённых дел. Этот страж стоит здесь,
     * чтобы такую «оптимизацию» никто не внёс не заметив.
     */
    const at = nextOccurrence(
      { kind: 'monthly', interval: 1, anchor: '2026-01-31' },
      { after: new Date('2026-03-15T09:00:00.000Z'), timeZone: MOSCOW },
    );

    expect(localDate(at, MOSCOW)).toBe('2026-03-28');
  });

  it('годовое правило через сто лет всё ещё в будущем', () => {
    const at = nextOccurrence(
      { kind: 'yearly', interval: 1, anchor: '1926-04-10' },
      { after: new Date('2026-09-11T09:00:00.000Z'), timeZone: MOSCOW },
    );

    expect(localDate(at, MOSCOW)).toBe('2027-04-10');
  });
});

describe('кончившийся счёт шагов слышен', () => {
  it('правило, не идущее вперёд, бросает ошибку, а не отдаёт прошлое', () => {
    /**
     * Дойти сюда проверенным правилом нельзя: `interval` не меньше
     * единицы, значит каждый шаг двигает дату хотя бы на сутки. Здесь
     * подсунуто именно сломанное правило — так выглядела бы поломка
     * `advance`, — и важно, что она **слышна**. Прежде отсюда возвращалась
     * последняя досчитанная дата: прошлое, выданное за будущее.
     */
    const broken = {
      kind: 'daily',
      interval: 0,
      anchor: '2026-01-01',
    } as unknown as RecurrenceRule;

    expect(() =>
      nextOccurrence(broken, { after: new Date('2027-06-01T09:00:00.000Z'), timeZone: MOSCOW }),
    ).toThrow(/не дошло до будущего/u);
  });
});
