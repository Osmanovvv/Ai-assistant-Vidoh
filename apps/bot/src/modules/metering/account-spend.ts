import { and, gte, lt, sql } from 'drizzle-orm';

import { aiCalls } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { Currency } from './pricing.js';
import { unpricedCountSql } from './unpriced.js';

/**
 * Потолок расхода по счёту, а не по человеку (задача 3.79).
 *
 * **Зачем понадобился, дословно из случившегося.** 05.09.2026 Yandex
 * начал отвечать 403 на любой запрос: у облака кончились деньги. Расход
 * за двенадцать дней — около 5 900 ₽, из них 1 977 ₽ за одни сутки
 * 04.09, при плане «около 125 ₽ в день». Никто этого не заметил: узнали
 * из отказа, когда бот встал.
 *
 * **Почему мягкий лимит §10.5 этого не поймал, хотя он есть и работает.**
 * Он считает расход **одного человека за календарный месяц** и при
 * превышении переводит тяжёлые стадии на лёгкую модель. Оба свойства
 * здесь бесполезны: деньги сожгли прогоны набора и сквозного, где
 * пользователей то нет вовсе, то они разные и одноразовые, — а на счёт
 * они складываются. И перевод на лёгкую модель грант не спасает: он
 * замедляет сжигание, но не останавливает.
 *
 * Значит нужен второй, независимый счёт: **сколько потратил счёт целиком**
 * — все люди, все прогоны, все стадии.
 *
 * **Считается по той базе, к которой подключён процесс, и это не мелочь.**
 * Ключ Yandex у нас один, а баз четыре: боевая, разработки, набора,
 * сквозного. Боевая — всего 15% расхода. Значит потолок в боевой базе
 * защищает от разгона бота, а от разгона прогонов защищает потолок,
 * заданный **прогону**. Общую картину по всем базам даёт отдельный
 * отчёт — `scripts/spend.ts`.
 */

export interface SpendCeiling {
  /** Потолок в микроединицах валюты. */
  readonly micros: number;
  readonly currency: Currency;
}

export interface AccountSpend {
  readonly calls: number;
  /** Потрачено в валюте потолка, микроединицы. */
  readonly spentMicros: number;
  /**
   * У части вызовов цена неизвестна: потраченное — **нижняя** оценка.
   *
   * Для потолка это не то же, что для мягкого лимита. Тот при незнании
   * цены отказывается работать: он ухудшает выдачу человеку, и делать
   * это на догадке нельзя. Потолок же сравнивает с нижней оценкой, и
   * если она уже перешла потолок — перешёл и настоящий расход. Ошибиться
   * можно только в одну сторону: пропустить превышение, а не выдумать.
   */
  readonly partial: boolean;
  /** Расход в других валютах есть, и он в счёт не вошёл. */
  readonly otherCurrencies: boolean;
}

/** Окно, за которое считается расход. */
export type SpendWindow = 'day' | 'all';

/**
 * Границы окна в поясе UTC.
 *
 * Сутки считаются по UTC намеренно: потолок защищает **счёт**, а счёт у
 * провайдера один и живёт не в поясе человека. Привязать его к чьему-то
 * местному дню значило бы, что у двух людей из разных поясов один и тот
 * же счёт кончается в разные моменты.
 */
export function windowStart(window: SpendWindow, now: Date): Date | undefined {
  if (window === 'all') return undefined;

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Сколько потратил счёт за окно.
 *
 * Без разбивки по пользователям: здесь важна сумма, а не чья она.
 */
export async function accountSpend(
  db: Executor,
  params: {
    readonly currency: Currency;
    readonly since?: Date | undefined;
    readonly until?: Date | undefined;
  },
): Promise<AccountSpend> {
  const bounds = [
    params.since === undefined ? undefined : gte(aiCalls.createdAt, params.since),
    params.until === undefined ? undefined : lt(aiCalls.createdAt, params.until),
  ].filter((one) => one !== undefined);

  const rows = await db
    .select({
      currency: aiCalls.costCurrency,
      calls: sql<number>`count(*)::int`,
      /**
       * Неизвестная цена считается **только у удавшихся** вызовов.
       *
       * У отказа цены нет и быть не может: 403 не тарифится. Считай их
       * вместе — и одного отказа за всё время хватит, чтобы счёт
       * назывался неполным навсегда. Предупреждение, которое горит
       * всегда, перестаёт значить что-либо, а настоящий случай — модели
       * нет в прайсе — от него не отличить.
       *
       * Тот же фильтр стоит в `scripts/spend.ts`; здесь он сперва был
       * забыт, и одно и то же число считалось двумя разными способами.
       */
      unknownPrices: unpricedCountSql(),
      // bigint приходит из node-postgres строкой: драйвер не рискует
      // точностью. Преобразование ниже, тип здесь честный.
      total: sql<string>`coalesce(sum(${aiCalls.costMicros}), 0)::bigint`,
    })
    .from(aiCalls)
    .where(bounds.length === 0 ? undefined : and(...bounds))
    .groupBy(aiCalls.costCurrency);

  let calls = 0;
  let spentMicros = 0;
  let unknown = 0;
  let otherCurrencies = false;

  for (const row of rows) {
    calls += row.calls;
    unknown += row.unknownPrices;

    if (row.currency === params.currency) {
      spentMicros += Number(row.total);
    } else if (row.currency !== null && Number(row.total) > 0) {
      otherCurrencies = true;
    }
  }

  return { calls, spentMicros, partial: unknown > 0, otherCurrencies };
}

export interface CeilingVerdict {
  /** Потолок перейдён: тратить больше нельзя. */
  readonly exceeded: boolean;
  /** Доля потолка, которую уже потратили. 1 — ровно потолок. */
  readonly share: number;
  /** Пора предупредить: доля перешла порог предупреждения. */
  readonly warn: boolean;
  readonly spentMicros: number;
  readonly ceilingMicros: number;
  /** Счёт неполон: настоящий расход не меньше этого. */
  readonly partial: boolean;
}

/**
 * Решение по потолку — чистой функцией.
 *
 * Отдельно от запроса к базе, потому что решение и есть то, что надо
 * проверять тестом: «сколько потратили» — арифметика драйвера, «пора ли
 * останавливаться» — правило, от которого зависит, ответит ли бот.
 */
export function ceilingVerdict(
  spend: Pick<AccountSpend, 'spentMicros' | 'partial'>,
  ceiling: SpendCeiling,
  warnShare: number,
): CeilingVerdict {
  /**
   * Потолок в ноль или отрицательный не имеет смысла, и «превышен
   * всегда» — худший из возможных ответов: бот встанет молча из-за
   * опечатки в настройке. Такой потолок считается невыставленным.
   */
  if (!Number.isFinite(ceiling.micros) || ceiling.micros <= 0) {
    return {
      exceeded: false,
      share: 0,
      warn: false,
      spentMicros: spend.spentMicros,
      ceilingMicros: ceiling.micros,
      partial: spend.partial,
    };
  }

  const share = spend.spentMicros / ceiling.micros;

  return {
    exceeded: spend.spentMicros >= ceiling.micros,
    share,
    warn: share >= warnShare,
    spentMicros: spend.spentMicros,
    ceilingMicros: ceiling.micros,
    partial: spend.partial,
  };
}

/** Микрорубли в рубли — для журнала и реплик, не для сравнений. */
export function rublesOf(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}

/**
 * Потолок из переменной окружения.
 *
 * Рубли снаружи, микрорубли внутри: расход складывается целыми
 * микроединицами, чтобы дробные копейки не расходились со счётом
 * провайдера.
 */
export function ceilingFromEnv(rubles: number | undefined): SpendCeiling | undefined {
  if (rubles === undefined) return undefined;

  return { micros: Math.round(rubles * 1_000_000), currency: 'rub' };
}
