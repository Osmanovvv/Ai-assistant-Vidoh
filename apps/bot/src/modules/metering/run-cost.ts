import type { Executor } from '../../infra/db.js';
import { accountSpend, rublesOf, windowStart, type SpendCeiling } from './account-spend.js';

/**
 * Сколько стоил прогон — строкой в конце прогона (задача 3.79).
 *
 * **Именно этого не хватило 05.09.2026.** Набор и сквозной гонялись
 * по многу раз в день, каждый прогон стоил от 42 до 350 ₽, и нигде не
 * было видно ни цены прогона, ни накопленного итога. Расход за сутки
 * дошёл до 1 977 ₽ при плане 125 ₽, а узнали мы об этом из отказа
 * Yandex, когда деньги на счёте кончились.
 *
 * Одна строка в конце прогона — «этот прогон 346 ₽, всего по этой базе
 * 2 242 ₽» — остановила бы меня на третьем прогоне вместо шестого.
 *
 * **Потолок здесь не проверяется**: этим занимается страж расхода на
 * пути модели. Здесь только показ — чтобы человек, который платит, видел
 * цену своего решения сразу, а не в конце месяца.
 */

export interface RunCost {
  /** Потрачено за прогон, микроединицы. */
  readonly runMicros: number;
  /** Потрачено за сутки UTC, включая этот прогон. */
  readonly dayMicros: number;
  /** Потрачено за всё, что помнит эта база. */
  readonly totalMicros: number;
  readonly calls: number;
  /** Счёт неполон: у части вызовов цена неизвестна. */
  readonly partial: boolean;
}

/**
 * Считает расход прогона по отметке его начала.
 *
 * Отметка ставится **до** первого вызова: всё, что записалось после
 * неё, — этот прогон и есть. Способ грубый, зато не требует протаскивать
 * идентификатор прогона через все стадии, и в прогоне на одной машине
 * ничего чужого записаться не может.
 */
export async function runCost(
  db: Executor,
  params: { readonly startedAt: Date; readonly now: Date; readonly currency?: 'rub' | undefined },
): Promise<RunCost> {
  const currency = params.currency ?? 'rub';
  const dayStart = windowStart('day', params.now);

  const [run, day, all] = await Promise.all([
    accountSpend(db, { currency, since: params.startedAt }),
    accountSpend(db, { currency, ...(dayStart === undefined ? {} : { since: dayStart }) }),
    accountSpend(db, { currency }),
  ]);

  return {
    runMicros: run.spentMicros,
    dayMicros: day.spentMicros,
    totalMicros: all.spentMicros,
    calls: run.calls,
    partial: run.partial || all.partial,
  };
}

/**
 * Человеческая строка о цене прогона.
 *
 * Печатается всегда, а не только при включённом потолке: цена прогона
 * нужна тому, кто платит, независимо от того, настроил ли он ограничения.
 */
export function costLine(
  cost: RunCost,
  ceilings: { readonly total?: SpendCeiling | undefined },
): string {
  const parts = [
    `Этот прогон: ${rublesOf(cost.runMicros)} ₽ за ${String(cost.calls)} обращений.`,
    `За сутки: ${rublesOf(cost.dayMicros)} ₽.`,
    `Всего по этой базе: ${rublesOf(cost.totalMicros)} ₽`,
  ];

  const ceiling = ceilings.total;
  const tail =
    ceiling === undefined
      ? '.'
      : ` из ${rublesOf(ceiling.micros)} ₽ потолка (${String(Math.round((cost.totalMicros / ceiling.micros) * 100))}%).`;

  const line = `${parts.join(' ')}${tail}`;

  /**
   * Неполный счёт называется прямо.
   *
   * Иначе строка «всего 2 242 ₽» читается как факт, а это нижняя оценка:
   * у части вызовов цена модели неизвестна, и настоящий расход больше.
   */
  return cost.partial
    ? `${line}\nЦена части вызовов неизвестна — это нижняя оценка, а не расход.`
    : line;
}
