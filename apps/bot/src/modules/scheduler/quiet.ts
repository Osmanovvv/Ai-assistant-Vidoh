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
 * Окно тишины, ужатое под времена, которые человек выбрал сам.
 *
 * **Найдено на приёмке этапа 3, на живом пользователе.** Проджект
 * заказчицы выбрал на онбординге утро в 07:00, а тишина по умолчанию идёт
 * с 22:00 до 08:00 — и накрывает его выбор целиком. Он не получил бы
 * утреннее напоминание **никогда**, молча: настройки по умолчанию, к
 * которым он не прикасался, отменяли то, о чём он попросил прямо.
 *
 * Правило простое: **явный выбор человека сильнее умолчания.** Если его
 * утро попадает в тишину, тишина кончается вместе с началом его утра;
 * если вечер — начинается после его вечера.
 *
 * Совсем отменять тишину для выбранных времён было бы проще, но тогда она
 * перестала бы значить хоть что-нибудь: все напоминания, кроме вопроса о
 * застрявшем проекте, идут ровно по этим двум временам. Ужатое окно
 * по-прежнему закрывает ночь.
 *
 * `undefined` — от окна ничего не осталось.
 */
export function effectiveQuiet(
  window: QuietWindow,
  times: { readonly morning: number; readonly evening: number },
): QuietWindow | undefined {
  let { from, to } = window;

  if (inQuietHours(times.morning, { from, to })) to = times.morning;
  if (inQuietHours(times.evening, { from, to })) from = (times.evening + 1) % (24 * 60);

  if (from === to) return undefined;

  return { from, to };
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
