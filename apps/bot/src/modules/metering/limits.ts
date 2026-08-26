import type { Logger } from 'pino';

import type { Executor } from '../../infra/db.js';
import { spendByUser } from './ai-calls.repo.js';
import type { Currency } from './pricing.js';

/**
 * Мягкий лимит расхода на пользователя (§10.5 ТЗ, задача 2.22).
 *
 * Требования §10.5 не было ни в одном этапе плана работ ТЗ, и это опасный
 * пропуск: как только продуктом начинают пользоваться живые люди, один
 * нетипичный пользователь может съесть месячный бюджет за день, и узнаем
 * мы об этом из счёта.
 *
 * **Мягкий — значит человек ничего не замечает** (§17). При превышении
 * тяжёлые стадии переходят на лёгкую модель, в журнале остаётся запись,
 * ответ приходит как обычно. Ни отказа, ни предупреждения, ни просьбы
 * подождать: человек не виноват, что его выгрузки дороже среднего.
 *
 * **Лимит абсолютной суммой, а не долей подписки.** По плану значение —
 * 30% от цены месячной подписки, но цена появится на четвёртом этапе.
 * До тех пор сумма задаётся переменной окружения; на четвёртом этапе она
 * переедет в админку, и считаться будет от цены.
 *
 * **Незнание цены не считается непревышением.** Если хотя бы у одного
 * вызова цена модели неизвестна, потраченное — нижняя оценка, и лимит
 * работать не может. Такой случай возвращается отдельным признаком и
 * пишется в журнал предупреждением: молча не работающий лимит хуже
 * отсутствующего — на него надеются, а он не защищает.
 */

/** Начало расчётного периода: календарный месяц. */
export function periodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface SpendVerdict {
  /** Превышен ли лимит. */
  readonly exceeded: boolean;
  /** Потрачено за период в микроединицах. */
  readonly spentMicros: number;
  readonly currency: Currency;
  /** Лимит не может работать: цена части вызовов неизвестна. */
  readonly blind: boolean;
}

export interface SpendLimit {
  /** Лимит в микроединицах за расчётный период. */
  readonly micros: number;
  readonly currency: Currency;
}

/**
 * Проверяет расход пользователя за период.
 *
 * Валюта лимита сверяется с валютой расхода: лимит в рублях ничего не
 * говорит о расходе в долларах, и сравнивать их — молча получить
 * неправильный ответ. Расход в другой валюте считается неизвестным.
 */
export async function checkSpend(
  db: Executor,
  params: { readonly userId: string; readonly now: Date; readonly limit: SpendLimit },
): Promise<SpendVerdict> {
  const summary = await spendByUser(db, params.userId, periodStart(params.now));
  const spentMicros = summary.totals[params.limit.currency] ?? 0;

  // Итог по валютам приходит из учёта уже сгруппированным, поэтому в
  // записях лежат числа, а не пропуски.
  const otherCurrencies = Object.entries(summary.totals).some(
    ([currency, value]) => currency !== params.limit.currency && value > 0,
  );

  const blind = !summary.complete || otherCurrencies;

  return {
    // Слепой лимит не превышен — но и не соблюдён: об этом говорит blind,
    // и об этом же кричит журнал. Останавливать разбор из-за незнания
    // цены нельзя: человек получил бы деградацию за нашу недоделку.
    exceeded: !blind && spentMicros >= params.limit.micros,
    spentMicros,
    currency: params.limit.currency,
    blind,
  };
}

export interface LimitDecision {
  /** Переводить ли тяжёлые стадии на лёгкую модель. */
  readonly degrade: boolean;
  readonly verdict?: SpendVerdict | undefined;
}

/**
 * Решение для одной выгрузки: работать как обычно или подешевле.
 *
 * Лимит не задан — работаем как обычно и молчим: это не сбой, а
 * состояние «ограничение не включено». А вот слепой лимит — сбой, и в
 * журнале он остаётся предупреждением каждый раз.
 */
export async function decideDegradation(
  db: Executor,
  params: {
    readonly userId: string;
    readonly now: Date;
    readonly limit?: SpendLimit | undefined;
    readonly logger?: Logger | undefined;
  },
): Promise<LimitDecision> {
  if (params.limit === undefined) return { degrade: false };

  const verdict = await checkSpend(db, {
    userId: params.userId,
    now: params.now,
    limit: params.limit,
  });

  if (verdict.blind) {
    params.logger?.warn(
      {
        event: 'spend_limit_blind',
        userId: params.userId,
        spentMicros: verdict.spentMicros,
        limitMicros: params.limit.micros,
      },
      'Мягкий лимит расхода не работает: цена части вызовов неизвестна',
    );

    return { degrade: false, verdict };
  }

  if (verdict.exceeded) {
    params.logger?.warn(
      {
        event: 'spend_limit_exceeded',
        userId: params.userId,
        spentMicros: verdict.spentMicros,
        limitMicros: params.limit.micros,
        currency: verdict.currency,
      },
      'Мягкий лимит расхода превышен: тяжёлые стадии идут на лёгкой модели',
    );
  }

  return { degrade: verdict.exceeded, verdict };
}

/**
 * Лимит из переменной окружения.
 *
 * Рубли на входе, микрорубли внутри: расход считается целыми
 * микроединицами, чтобы суммирование мелких дробей не расходилось со
 * счётом провайдера.
 */
export function limitFromEnv(rubles: number | undefined): SpendLimit | undefined {
  if (rubles === undefined) return undefined;
  return { micros: Math.round(rubles * 1_000_000), currency: 'rub' };
}
