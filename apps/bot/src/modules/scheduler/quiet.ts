import { parseLocalTime } from './time.js';

/**
 * Режим тишины (§11 ТЗ, задача 3.17).
 *
 * «В настройках есть выключатель напоминаний и режим тишины.»
 *
 * Тишина обычно идёт через полночь — с двадцати двух до восьми, — и это
 * не крайний случай, а основной. Сравнение «от меньше текущего меньше до»
 * здесь просто не работает: 23:00 не меньше 08:00.
 */

/** Границы в минутах от местной полуночи. */
export interface QuietWindow {
  readonly from: number;
  readonly to: number;
}

export function quietWindow(from: string, to: string): QuietWindow {
  const start = parseLocalTime(from);
  const end = parseLocalTime(to);

  return { from: start.hours * 60 + start.minutes, to: end.hours * 60 + end.minutes };
}

/**
 * Попадает ли местная минута в окно тишины.
 *
 * Начало включается, конец нет: в 08:00 при границе «до 08:00» человек уже
 * доступен. Иначе напоминание, стоящее ровно на границе, не уходило бы
 * никогда — а границу по умолчанию человек и не двигал.
 */
export function inQuietHours(localMinutes: number, window: QuietWindow): boolean {
  // Пустое окно: тишины нет ни минуты.
  if (window.from === window.to) return false;

  return window.from < window.to
    ? localMinutes >= window.from && localMinutes < window.to
    : localMinutes >= window.from || localMinutes < window.to;
}

/**
 * Что делать с напоминанием, попавшим в тишину.
 *
 * Не переносим, а пропускаем. Перенос значил бы, что в восемь утра
 * человека ждёт пачка ночных напоминаний — ровно тот раздражитель, от
 * которого §11 велит уходить. Вечерний итог, не отправленный вовремя,
 * назавтра уже не итог.
 */
export const QUIET_SKIP_REASON = 'quiet';
