import { and, gte, inArray, sql } from 'drizzle-orm';

import { aiCalls, users } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { Currency } from './pricing.js';

/**
 * Расход в разрезах для админ-панели (§15 ТЗ, задача 4.7).
 *
 * §21 п.14 — прямой критерий приёмки: «в админ-панели виден расход по
 * каждому пользователю и по этапам». Данные лежат в `ai_calls` с первого
 * этапа, считать нечего заново — надо сложить по трём разрезам и честно
 * показать то, что сложилось.
 *
 * **Валюты не складываются никогда.** У нас две — рубли и доллары, — и
 * сумма «рубли плюс доллары» не означает ничего. Поэтому всюду не число,
 * а список сумм по валютам: пусть в панели их будет две строки, чем одно
 * неправильное число. Тот же приём, что в `spendByUser` с первого этапа.
 *
 * **Расход без цены считается отдельно, а не нулём.** Модель, которой нет
 * в прайс-листе, даёт строку с пустой ценой: деньги потрачены, а сколько —
 * неизвестно. Ноль в этом месте — самая опасная ложь отчёта: он выглядит
 * как «бесплатно».
 *
 * **Расход обезличенных строк показывается отдельной величиной.** §16
 * требует удалять данные человека, и при удалении `ai_calls.user_id`
 * обнуляется — иначе история себестоимости рассыпалась бы. Значит сумма
 * по пользователям **меньше** общей, и разница не ошибка: это расход тех,
 * кто ушёл. Не сказать об этом — значит показать отчёт, который не
 * сходится сам с собой, и заставить человека искать ошибку там, где её
 * нет.
 *
 * **Панель показывает расход боевой базы, и только его.** Один ключ
 * Yandex обслуживает четыре базы — боевую, разработки, контрольного
 * набора и сквозного прогона, — и 05.09.2026 выяснилось, что боевая
 * знает 15% потраченного. Остальное — наши собственные прогоны, и
 * складывает их `scripts/spend.ts` по всем базам. Здесь этого нет
 * нарочно: §21 п.14 спрашивает про расход **пользователей**, а он весь
 * в боевой базе. Смешать одно с другим значило бы показать заказчице
 * счёт за нашу отладку как её себестоимость.
 */

export interface Money {
  readonly currency: Currency;
  readonly micros: number;
}

export interface CostRow {
  /** Этап, модель или человек — смотря какой разрез. */
  readonly key: string;
  readonly calls: number;
  readonly failed: number;
  /** По валютам. Пустой список — все цены неизвестны. */
  readonly money: readonly Money[];
  /** Сколько вызовов ушло без цены. */
  readonly unknownPrices: number;
}

export interface UserCostRow extends CostRow {
  /** Как человека называть в панели: имя из профиля либо код. */
  readonly title: string;
  /**
   * Телеграмного номера здесь нет нарочно (ревизия четвёртого этапа).
   *
   * Он уезжал в браузер в каждой строке страницы и не рисовался ни в
   * одной колонке: панель берёт из строки только имя. То есть личный
   * идентификатор ходил туда, где он никому не нужен, — а
   * минимизация §16 говорит обратное.
   *
   * Имя остаётся: без него разрез по людям не прочесть, и путь по-прежнему
   * объявлен персональным. Понадобится номер разбирающему — его надо
   * нарисовать колонкой, а не возить молча.
   */
}

export interface CostBreakdown {
  readonly since: Date;
  readonly byStage: readonly CostRow[];
  readonly byModel: readonly CostRow[];
  readonly byUser: readonly UserCostRow[];
  /** Сколько всего людей с расходом за период: панели нужно для страниц. */
  readonly userCount: number;
  /** Расход строк без человека: он ушёл, а история осталась (§16). */
  readonly unattributed: readonly Money[];
  /** Сколько обезличенных вызовов: без числа сверить колонки нечем. */
  readonly unattributedCalls: number;
  /**
   * Расход вне выгрузок — отдельной величиной (ревизия этапа).
   *
   * Выгрузка уходит каскадом вместе с человеком, а строка учёта
   * остаётся. Прежде эти деньги молча попадали в числитель среднего «на
   * выгрузку», и себестоимость разбора росла от чужого удаления.
   */
  readonly unlinked: readonly Money[];
  readonly unlinkedCalls: number;
  /** Средний расход на разобранную выгрузку. */
  readonly perDump: readonly Money[];
  /** Средний расход на человека. */
  readonly perUser: readonly Money[];
  readonly dumps: number;
  readonly calls: number;
  /** Все ли цены известны. Ложь означает, что суммы — нижняя граница. */
  readonly complete: boolean;
}

/** Сырая строка группировки: одна на пару «ключ, валюта». */
interface Grouped {
  readonly key: string;
  readonly currency: Currency | null;
  readonly calls: number;
  readonly failed: number;
  readonly unknownPrices: number;
  readonly total: string;
}

/**
 * Сложить строки группировки в разрез.
 *
 * Группировка идёт по паре «ключ, валюта», поэтому на один ключ приходит
 * несколько строк, и собрать их надо здесь, а не в запросе: складывать
 * валюты в SQL было бы тем самым числом, которое ничего не означает.
 */
function fold(rows: readonly Grouped[]): CostRow[] {
  const byKey = new Map<
    string,
    { calls: number; failed: number; unknown: number; money: Map<Currency, number> }
  >();

  for (const row of rows) {
    const seen = byKey.get(row.key) ?? {
      calls: 0,
      failed: 0,
      unknown: 0,
      money: new Map<Currency, number>(),
    };

    seen.calls += row.calls;
    seen.failed += row.failed;
    seen.unknown += row.unknownPrices;

    // Валюта пустая — значит цены нет вовсе: считать такую строку нулём
    // рублей было бы ложью «бесплатно».
    if (row.currency !== null) {
      seen.money.set(row.currency, (seen.money.get(row.currency) ?? 0) + Number(row.total));
    }

    byKey.set(row.key, seen);
  }

  return (
    [...byKey.entries()]
      .map(([key, seen]) => ({
        key,
        calls: seen.calls,
        failed: seen.failed,
        unknownPrices: seen.unknown,
        /**
         * Валюты внутри строки — по имени валюты (ревизия этапа 4).
         *
         * `Map` хранит порядок появления, а появлялись валюты в порядке
         * строк запроса без `order by` — то есть в том, какой выбрал план.
         * Заказчица видела «₽, $» и «$, ₽» на одной и той же странице при
         * разных обновлениях. Тот же дефект нашёлся в расходе человека,
         * где он ронял проверку через раз.
         */
        money: [...seen.money.entries()]
          .map(([currency, micros]) => ({ currency, micros }))
          .sort((first, second) => first.currency.localeCompare(second.currency)),
      }))
      /**
       * Довесок по ключу при равных вызовах — иначе порядок не задан.
       *
       * У запроса по людям нет `order by`, значит порядок страницы
       * наследует порядок строк Postgres, а сортировка только по числу
       * вызовов неустойчива. Тот же дефект уже чинили в списке людей
       * (4.6): один человек попадал на две страницы, другой — ни на одну.
       */
      .sort((first, second) => second.calls - first.calls || first.key.localeCompare(second.key))
  );
}

/** Сумма по валютам, делённая на число. Ноль делителя — пустой список. */
function divide(money: readonly Money[], by: number): Money[] {
  if (by <= 0) return [];

  return money.map((one) => ({ currency: one.currency, micros: Math.round(one.micros / by) }));
}

/** Сложить несколько разрезов в одну сумму по валютам. */
function totalOf(rows: readonly CostRow[]): Money[] {
  const money = new Map<Currency, number>();

  for (const row of rows) {
    for (const one of row.money) {
      money.set(one.currency, (money.get(one.currency) ?? 0) + one.micros);
    }
  }

  return [...money.entries()].map(([currency, micros]) => ({ currency, micros }));
}

export interface BreakdownParams {
  readonly since: Date;
  /** Сколько людей отдавать. Панель показывает по страницам. */
  readonly userLimit?: number | undefined;
  readonly userOffset?: number | undefined;
}

export async function costBreakdown(db: Executor, params: BreakdownParams): Promise<CostBreakdown> {
  const since = params.since;
  const where = gte(aiCalls.createdAt, since);

  /** Общие поля группировки: одинаковы во всех трёх разрезах. */
  const counters = {
    calls: sql<number>`count(*)::int`,
    failed: sql<number>`count(*) filter (where ${aiCalls.ok} = false)::int`,
    unknownPrices: sql<number>`count(*) filter (where ${aiCalls.costMicros} is null)::int`,
    // bigint приходит строкой: драйвер не рискует точностью.
    total: sql<string>`coalesce(sum(${aiCalls.costMicros}), 0)::bigint`,
  };

  const stageRows = await db
    .select({ key: aiCalls.stage, currency: aiCalls.costCurrency, ...counters })
    .from(aiCalls)
    .where(where)
    .groupBy(aiCalls.stage, aiCalls.costCurrency);

  const modelRows = await db
    .select({ key: aiCalls.model, currency: aiCalls.costCurrency, ...counters })
    .from(aiCalls)
    .where(where)
    .groupBy(aiCalls.model, aiCalls.costCurrency);

  /**
   * Разрез по людям — только строки **с** человеком.
   *
   * Обезличенные считаются отдельно: они и есть разница между общей
   * суммой и суммой по людям.
   */
  const userRows = await db
    .select({
      key: sql<string>`${aiCalls.userId}::text`,
      currency: aiCalls.costCurrency,
      ...counters,
    })
    .from(aiCalls)
    .where(and(where, sql`${aiCalls.userId} is not null`))
    .groupBy(aiCalls.userId, aiCalls.costCurrency);

  const anonymousRows = await db
    .select({ key: sql<string>`'обезличено'`, currency: aiCalls.costCurrency, ...counters })
    .from(aiCalls)
    .where(and(where, sql`${aiCalls.userId} is null`))
    .groupBy(aiCalls.costCurrency);

  /**
   * Обращения **вне выгрузок** — своим разрезом (ревизия этапа).
   *
   * Выгрузка уходит каскадом вместе с человеком, а строка учёта
   * остаётся: §16 требует удалить его данные, но себестоимость — наша
   * история. Значит расход без выгрузки — нормальное состояние, а не
   * сбой.
   *
   * Прежде он молча уходил в числитель среднего «на выгрузку» и нигде не
   * показывался. Один активный человек с двадцатью выгрузками и 200 ₽,
   * удалив данные, поднимал себестоимость разбора с 10 до 12.50 ₽ — от
   * **чужого** удаления, и объяснения на странице не было.
   *
   * Соседний модуль этот вопрос уже решил правильно: `cost-per-dump.ts`
   * держит такие вызовы отдельным полем и в расчёт на выгрузку не берёт.
   */
  const unlinkedRows = await db
    .select({ key: sql<string>`'вне выгрузок'`, currency: aiCalls.costCurrency, ...counters })
    .from(aiCalls)
    .where(and(where, sql`${aiCalls.batchId} is null`))
    .groupBy(aiCalls.costCurrency);

  /** Расход, привязанный к выгрузке — числитель среднего «на выгрузку». */
  const linkedRows = await db
    .select({ key: sql<string>`'в выгрузках'`, currency: aiCalls.costCurrency, ...counters })
    .from(aiCalls)
    .where(and(where, sql`${aiCalls.batchId} is not null`))
    .groupBy(aiCalls.costCurrency);

  /**
   * Выгрузки считаются по тем же строкам учёта, а не по таблице выгрузок.
   *
   * Иначе средний расход считался бы от одного числа, а сумма — от
   * другого, и отношение не сходилось бы: выгрузка могла закрыться без
   * единого обращения к модели, а обращение — случиться вне выгрузки.
   * Один источник для числителя и знаменателя.
   */
  const [totals] = await db
    .select({
      dumps: sql<number>`count(distinct ${aiCalls.batchId})::int`,
      people: sql<number>`count(distinct ${aiCalls.userId})::int`,
      calls: sql<number>`count(*)::int`,
      unknownPrices: sql<number>`count(*) filter (where ${aiCalls.costMicros} is null)::int`,
    })
    .from(aiCalls)
    .where(where);

  const byStage = fold(stageRows);
  const byModel = fold(modelRows);
  const foldedUsers = fold(userRows);

  // Имена — отдельным запросом и только тем, кого показываем: тянуть
  // профили всех ради страницы из двадцати было бы расточительством.
  const limit = params.userLimit ?? 50;
  const offset = params.userOffset ?? 0;
  const page = foldedUsers.slice(offset, offset + limit);

  const profiles =
    page.length === 0
      ? []
      : await db
          .select({ id: users.id, firstName: users.firstName })
          .from(users)
          // Через `inArray`, а не склейкой строки: коды приходят из базы
          // и опасности не несут, но собирать SQL текстом — привычка,
          // которая однажды доберётся до значения, пришедшего снаружи.
          .where(
            inArray(
              users.id,
              page.map((row) => row.key),
            ),
          );

  const named = new Map(profiles.map((row) => [row.id, row]));

  const byUser: UserCostRow[] = page.map((row) => {
    const profile = named.get(row.key);

    return {
      ...row,
      // Имя, если есть; иначе код — но не пустая строка: пустая ячейка в
      // отчёте читается как «нет данных», а человек-то есть.
      title: profile?.firstName ?? `без имени (${row.key.slice(0, 8)})`,
    };
  });

  const anonymous = fold(anonymousRows);
  const unlinked = fold(unlinkedRows);

  return {
    since,
    byStage,
    byModel,
    byUser,
    userCount: foldedUsers.length,
    unattributed: totalOf(anonymous),
    /**
     * Число обезличенных вызовов, а не только их деньги.
     *
     * Прежде наверх уходила одна сумма, и колонку «Вызовов» в разрезе по
     * людям было не с чем сверить: расхождение с итогом «Обращений к
     * моделям» проверить нечем.
     */
    unattributedCalls: anonymous.reduce((sum, row) => sum + row.calls, 0),
    /** Расход вне выгрузок — отдельной величиной, а не в числителе. */
    unlinked: totalOf(unlinked),
    unlinkedCalls: unlinked.reduce((sum, row) => sum + row.calls, 0),
    /**
     * **Числители берутся из тех же множеств, что знаменатели.**
     *
     * Найдено ревизией этапа. Прежде оба средних делили **общую** сумму
     * — вместе с обезличенной и вместе с расходом вне выгрузок — на
     * число только уцелевших людей и выгрузок. Двенадцать человек по
     * 50 ₽, десять удалили данные: панель показывала «По людям» две
     * строки по 50 ₽, ниже «ещё 500 ₽ на тех, кто удалил данные», а в
     * итогах «На человека 300 ₽» — при настоящей себестоимости 50 ₽.
     *
     * Отчёт противоречил себе на одном экране, и это не косметика: по
     * среднему на человека назначают цену подписки.
     */
    perDump: divide(totalOf(fold(linkedRows)), totals?.dumps ?? 0),
    perUser: divide(totalOf(foldedUsers), totals?.people ?? 0),
    dumps: totals?.dumps ?? 0,
    calls: totals?.calls ?? 0,
    complete: (totals?.unknownPrices ?? 0) === 0,
  };
}
