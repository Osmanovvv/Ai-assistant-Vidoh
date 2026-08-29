import { localDateParts, nearestWeekday, startOfDayInZone } from '../classifier/dates.js';

/**
 * Период, упомянутый в сегменте (§7.2 ТЗ, задача 3.1).
 *
 * Третий источник кандидатов ищет «записи со сроком в периоде, который
 * упомянут в сегменте». Значит период надо откуда-то взять, а сегмент —
 * это обрывок живой речи: «нет, в пятницу», «давай завтра».
 *
 * **Разбор нарочно узкий, и это не лень.** Полный разбор дат уже есть —
 * им занимается модель на этапе извлечения, и он умеет «на следующей
 * неделе» и «пятого сентября». Здесь другая задача: дёшево и без
 * обращения к модели сузить список кандидатов до тех, чей срок человек
 * мог иметь в виду. Ошибка в эту сторону стоит лишнего кандидата в
 * списке, а не неверного срока в записи.
 *
 * Поэтому распознаётся только то, в чём нельзя ошибиться: дни недели и
 * «сегодня / завтра / послезавтра». Всё остальное даёт `undefined`, и
 * третий источник просто ничего не добавляет — первые два работают.
 */

/** Дни недели в том виде, в каком они звучат в живой речи. */
const WEEKDAYS: ReadonlyMap<string, number> = new Map([
  ['воскресенье', 0],
  ['воскресенья', 0],
  ['воскресенью', 0],
  ['понедельник', 1],
  ['понедельника', 1],
  ['понедельнику', 1],
  ['вторник', 2],
  ['вторника', 2],
  ['вторнику', 2],
  ['среда', 3],
  ['среду', 3],
  ['среды', 3],
  ['среде', 3],
  ['четверг', 4],
  ['четверга', 4],
  ['четвергу', 4],
  ['пятница', 5],
  ['пятницу', 5],
  ['пятницы', 5],
  ['пятнице', 5],
  ['суббота', 6],
  ['субботу', 6],
  ['субботы', 6],
  ['субботе', 6],
]);

/** Сдвиг в днях для слов, которые считаются от сегодня. */
const RELATIVE_DAYS: ReadonlyMap<string, number> = new Map([
  ['сегодня', 0],
  ['завтра', 1],
  ['послезавтра', 2],
]);

export interface Period {
  /** Начало дня в поясе человека, включительно. */
  readonly from: Date;
  /** Начало следующего дня: сравнение идёт как `from <= срок < to`. */
  readonly to: Date;
}

export interface PeriodContext {
  readonly now: Date;
  readonly timeZone: string;
}

const DAY_MS = 24 * 60 * 60_000;

/** Сутки, начинающиеся в названный день. */
function dayOf(start: Date, timeZone: string): Period {
  const from = startOfDayInZone(localDateParts(start, timeZone), timeZone);
  const next = new Date(from.getTime() + DAY_MS);

  // Пересчёт через части даты, а не прибавлением суток: в поясах с
  // переходом на летнее время в сутках бывает 23 часа или 25.
  return { from, to: startOfDayInZone(localDateParts(next, timeZone), timeZone) };
}

/**
 * Ищет в тексте упоминание дня.
 *
 * Слова сравниваются целиком, а не вхождением: «средство» содержит
 * «среда» только на взгляд регулярного выражения без границ, а границы
 * `\b` кириллицу не видят — они определены через `\w`, то есть латиницу.
 * Отсюда разбиение по не-буквам вместо поиска подстроки.
 */
export function mentionedPeriod(text: string, context: PeriodContext): Period | undefined {
  const words = text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length > 0);

  for (const word of words) {
    const shift = RELATIVE_DAYS.get(word);
    if (shift !== undefined) {
      return dayOf(new Date(context.now.getTime() + shift * DAY_MS), context.timeZone);
    }

    const weekday = WEEKDAYS.get(word);
    if (weekday !== undefined) {
      return dayOf(nearestWeekday(weekday, context), context.timeZone);
    }
  }

  return undefined;
}
