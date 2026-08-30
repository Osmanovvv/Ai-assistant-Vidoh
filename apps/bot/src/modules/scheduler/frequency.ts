/**
 * Снижение частоты напоминаний (§11 ТЗ, задача 3.17).
 *
 * «Если пользователь несколько раз подряд не отвечал на утренние
 * напоминания, частота автоматически снижается. Продукт не имеет права
 * превращаться в раздражитель.»
 *
 * Значения из плана: после 5 подряд без реакции — через день, после 10 —
 * раз в неделю.
 *
 * **Счётчик не хранится, а считается по истории.** Отдельная колонка
 * означала бы, что сброс живёт в коде: кто-то должен обнулить её при
 * первом же сообщении человека. Один пропущенный вызов — и активный
 * пользователь молча съезжает на недельную частоту, а найти это можно
 * только по жалобе. История отправленных напоминаний и история сообщений
 * уже есть; из них ответ выводится однозначно и сбрасывается сам.
 */

/** Порог, после которого напоминания приходят через день. */
export const SLOW_AFTER = 5;
/** Порог, после которого — раз в неделю. */
export const WEEKLY_AFTER = 10;

export type Frequency = 'daily' | 'everyOther' | 'weekly';

/** Как часто писать человеку с такой серией молчания. */
export function frequencyFor(ignoredStreak: number): Frequency {
  if (ignoredStreak >= WEEKLY_AFTER) return 'weekly';
  if (ignoredStreak >= SLOW_AFTER) return 'everyOther';

  return 'daily';
}

/** Сколько дней между напоминаниями при такой частоте. */
export function intervalDays(frequency: Frequency): number {
  switch (frequency) {
    case 'weekly':
      return 7;
    case 'everyOther':
      return 2;
    case 'daily':
      return 1;
  }
}

/**
 * Пора ли утреннее напоминание.
 *
 * `lastMorningDay` — местная дата последнего отправленного утреннего, в
 * днях от эпохи. Пусто — не отправляли ни разу, значит пора.
 *
 * Считаем в местных днях, а не в часах: «через день» — это про календарь
 * человека. Час туда-обратно на границе суток превратил бы «через день» в
 * «через день, кроме тех, когда не через день».
 */
export function morningDue(params: {
  readonly today: number;
  readonly lastMorningDay?: number | undefined;
  readonly ignoredStreak: number;
}): boolean {
  if (params.lastMorningDay === undefined) return true;

  const passed = params.today - params.lastMorningDay;

  return passed >= intervalDays(frequencyFor(params.ignoredStreak));
}
