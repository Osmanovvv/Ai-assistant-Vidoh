import type { AiStage } from '../../db/schema.js';
import type { Currency } from './pricing.js';

/**
 * Себестоимость одной выгрузки (задача 2.21).
 *
 * §21 требует знать цену разбора: без неё цена подписки на четвёртом
 * этапе назначается на глаз. Считается не «в среднем по всему», а **по
 * выгрузкам**: пользователь платит за подписку, а расход создаёт
 * выгрузкой, и связь нужна именно эта.
 *
 * **Средняя и 90-й процентиль, а не одна средняя.** Выгрузки очень
 * разные: три секунды «купить хлеб» и семьдесят семь секунд потока из
 * пятнадцати дел. Средняя по ним обманывает в обе стороны, а цену надо
 * назначать так, чтобы тяжёлые выгрузки не съедали подписку.
 *
 * **Неизвестная цена не превращается в ноль.** Выгрузка, где хотя бы у
 * одного вызова цена модели неизвестна, в среднюю не входит и считается
 * отдельно. Иначе отсутствие прайс-листа выглядело бы как дешёвый разбор.
 *
 * **Объёмы считаются всегда, даже без прайс-листа.** Секунды звука и
 * токены известны из учёта; они и есть то, что умножается на цену. Пока
 * цены нет, отчёт всё равно отвечает на вопрос «сколько мы потребляем».
 */

export interface DumpCall {
  /** Выгрузка, к которой отнесён вызов. Пустая — вызов вне выгрузки. */
  readonly batchId: string | null;
  readonly stage: AiStage;
  readonly model: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly audioSeconds: number | null;
  readonly costMicros: number | null;
  readonly costCurrency: Currency | null;
}

/** Что стадия потребляет на одну выгрузку, в среднем. */
export interface StageAverage {
  readonly stage: AiStage;
  /** Вызовов на выгрузку: у расшифровки их столько, сколько голосовых. */
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly audioSeconds: number;
  readonly micros?: number | undefined;
  readonly currency?: Currency | undefined;
  /** Сколько вызовов стадии прошли без известной цены. */
  readonly unknownPrices: number;
}

export interface Spread {
  readonly average: number;
  /** 90-й процентиль по правилу ближайшего ранга. */
  readonly p90: number;
  readonly max: number;
}

export interface CostReport {
  /** Выгрузок в выборке. */
  readonly dumps: number;
  /**
   * Вызовы без выгрузки. Не мусор: так выглядят вызовы, чья выгрузка
   * удалена по §16, и прогоны стенда. В расчёт на выгрузку не идут.
   */
  readonly unlinkedCalls: number;
  readonly audioSeconds: Spread;
  readonly tokensIn: Spread;
  readonly tokensOut: Spread;
  /** Стоимость выгрузки — только по выгрузкам с полностью известной ценой. */
  readonly cost?: (Spread & { readonly currency: Currency; readonly dumps: number }) | undefined;
  /** Выгрузок, исключённых из стоимости из-за неизвестной цены. */
  readonly dumpsWithUnknownPrice: number;
  readonly byStage: readonly StageAverage[];
  readonly modelsWithoutPrice: readonly string[];
}

/**
 * 90-й процентиль по правилу ближайшего ранга.
 *
 * Без интерполяции намеренно: интерполяция придумывает значение, которого
 * не было ни у одной выгрузки, а нам нужна настоящая тяжёлая выгрузка,
 * а не среднее между двумя.
 */
function percentile(sorted: readonly number[], share: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(share * sorted.length));
  return sorted[rank - 1] ?? 0;
}

function spread(values: readonly number[]): Spread {
  if (values.length === 0) return { average: 0, p90: 0, max: 0 };

  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    average: total / sorted.length,
    p90: percentile(sorted, 0.9),
    max: sorted.at(-1) ?? 0,
  };
}

interface DumpTotals {
  audioSeconds: number;
  tokensIn: number;
  tokensOut: number;
  micros: number;
  currency: Currency | undefined;
  complete: boolean;
}

function emptyDump(): DumpTotals {
  return {
    audioSeconds: 0,
    tokensIn: 0,
    tokensOut: 0,
    micros: 0,
    currency: undefined,
    complete: true,
  };
}

interface StageTotals {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  audioSeconds: number;
  micros: number;
  currency: Currency | undefined;
  unknownPrices: number;
}

function emptyStage(): StageTotals {
  return {
    calls: 0,
    tokensIn: 0,
    tokensOut: 0,
    audioSeconds: 0,
    micros: 0,
    currency: undefined,
    unknownPrices: 0,
  };
}

export function collectCost(calls: readonly DumpCall[]): CostReport {
  const dumps = new Map<string, DumpTotals>();
  const stages = new Map<AiStage, StageTotals>();
  const withoutPrice = new Set<string>();
  let unlinkedCalls = 0;

  for (const call of calls) {
    // Список моделей без цены собирается по всем вызовам: он про
    // прайс-лист, а не про выгрузки.
    if (call.costMicros === null) withoutPrice.add(call.model);

    /**
     * Разбивка по стадиям считается только по вызовам, привязанным к
     * выгрузке, — иначе она делит чужое на наше.
     *
     * Поймано на живых данных: в базе стенда лежали девяносто вызовов
     * прошлых прогонов без привязки, и отчёт разделил их на три выгрузки,
     * показав двадцать четыре тысячи токенов у классификации вместо
     * двух с половиной. Итог на выгрузку при этом был верным — то есть
     * ошибка была ровно в том месте, куда смотрят, решая, что дорого.
     */
    if (call.batchId === null) {
      unlinkedCalls++;
      continue;
    }

    const stage = stages.get(call.stage) ?? emptyStage();
    stage.calls++;
    stage.tokensIn += call.tokensIn ?? 0;
    stage.tokensOut += call.tokensOut ?? 0;
    stage.audioSeconds += call.audioSeconds ?? 0;

    if (call.costMicros === null) {
      stage.unknownPrices++;
    } else {
      stage.micros += call.costMicros;
      stage.currency ??= call.costCurrency ?? undefined;
    }

    stages.set(call.stage, stage);

    const dump = dumps.get(call.batchId) ?? emptyDump();
    dump.audioSeconds += call.audioSeconds ?? 0;
    dump.tokensIn += call.tokensIn ?? 0;
    dump.tokensOut += call.tokensOut ?? 0;

    if (call.costMicros === null) {
      dump.complete = false;
    } else {
      dump.micros += call.costMicros;
      dump.currency ??= call.costCurrency ?? undefined;
    }

    dumps.set(call.batchId, dump);
  }

  const all = [...dumps.values()];
  const priced = all.filter((dump) => dump.complete && dump.currency !== undefined);
  const currency = priced[0]?.currency;

  /**
   * Валюты не смешиваются. Если в выборке есть и рубли, и доллары —
   * стоимость не считается вовсе: сумма разных валют не значит ничего,
   * а выбрать одну за пользователя мы не вправе.
   */
  const singleCurrency = priced.every((dump) => dump.currency === currency);

  const perDump = (value: number): number => (all.length === 0 ? 0 : value / all.length);

  const byStage: StageAverage[] = [...stages.entries()]
    .map(([stage, totals]) => ({
      stage,
      calls: perDump(totals.calls),
      tokensIn: perDump(totals.tokensIn),
      tokensOut: perDump(totals.tokensOut),
      audioSeconds: perDump(totals.audioSeconds),
      micros: totals.unknownPrices > 0 ? undefined : perDump(totals.micros),
      currency: totals.currency,
      unknownPrices: totals.unknownPrices,
    }))
    .sort((left, right) => (left.stage < right.stage ? -1 : 1));

  return {
    dumps: all.length,
    unlinkedCalls,
    audioSeconds: spread(all.map((dump) => dump.audioSeconds)),
    tokensIn: spread(all.map((dump) => dump.tokensIn)),
    tokensOut: spread(all.map((dump) => dump.tokensOut)),
    cost:
      priced.length > 0 && currency !== undefined && singleCurrency
        ? { ...spread(priced.map((dump) => dump.micros)), currency, dumps: priced.length }
        : undefined,
    dumpsWithUnknownPrice: all.length - priced.length,
    byStage,
    modelsWithoutPrice: [...withoutPrice].sort(),
  };
}
