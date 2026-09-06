import type { Logger } from 'pino';

import { SpendCeilingError } from '../../infra/failures.js';
import type { Executor } from '../../infra/db.js';
import {
  accountSpend,
  ceilingVerdict,
  rublesOf,
  windowStart,
  type CeilingVerdict,
  type SpendCeiling,
  type SpendWindow,
} from './account-spend.js';

/**
 * Страж расхода: не даёт сжечь счёт молча (задача 3.79).
 *
 * **Что случилось без него.** За сутки 04.09.2026 прогоны сожгли 1 977 ₽
 * при плане 125 ₽ в день, накопленный расход перешёл несколько тысяч, и
 * 05.09 Yandex ответил 403 на любой запрос. Узнали из отказа.
 *
 * **Три свойства, каждое из которых важнее удобства.**
 *
 * 1. **Выключен по умолчанию.** Ни одна переменная не задана — страж не
 *    делает вовсе ничего, ни запроса в базу, ни проверки. Поведение бота
 *    ровно такое, как до него. Включение — осознанное действие человека,
 *    который назвал сумму.
 *
 * 2. **Своя поломка бота не останавливает.** Если запрос расхода упал —
 *    база моргнула, схема разъехалась, что угодно, — страж пропускает
 *    вызов и пишет предупреждение. Сторож, который запирает дом, когда
 *    сам сломался, хуже отсутствующего: он превращает свою мелкую
 *    неполадку в остановку продукта.
 *
 * 3. **Остановка не теряет слова человека.** Превышение поднимается
 *    ошибкой, которую конвейер считает **нашим простоем** — как отказ в
 *    доступе (3.72): выгрузка остаётся в очереди, попытку не тратит, и
 *    разберётся, когда потолок поднимут. Человеку говорится о задержке,
 *    а не «попробуй ещё раз».
 *
 * **Проверка стоит один запрос, и он кэшируется.** Считать сумму на
 * каждый вызов модели не нужно: расход между проверками страж знает сам —
 * он складывает то, что сам же и пропустил. Поэтому кэш не «примерно», а
 * точно: база плюс известное с тех пор.
 */

/** Превышение потолка ли это. Цепочку причин обходит `isOwnOutage`. */
export function isSpendCeiling(error: unknown): boolean {
  return error instanceof SpendCeilingError;
}

export interface SpendCeilings {
  /** Потолок за всё, что помнит эта база. */
  readonly total?: SpendCeiling | undefined;
  /** Потолок за календарные сутки UTC. */
  readonly daily?: SpendCeiling | undefined;
}

export interface SpendGuardDeps {
  readonly db: Executor;
  readonly ceilings: SpendCeilings;
  /** Доля потолка, после которой пора предупредить. По умолчанию 0,8. */
  readonly warnShare?: number | undefined;
  readonly logger?: Logger | undefined;
  /**
   * Куда сообщить о приближении к потолку.
   *
   * Отдельной зависимостью, а не прямым обращением к мониторингу: страж
   * живёт в общем пути всех обращений к модели, в том числе в прогонах
   * набора, где мониторинга нет вовсе.
   */
  readonly onWarn?: ((notice: SpendNotice) => void) | undefined;
  /**
   * Страж сломался — наружу, а не только в журнал (находка проверки).
   *
   * Мёртвый страж и страж под потолком снаружи выглядят одинаково: тихо.
   * Ровно так и потеряли деньги 05.09.2026. Отдельной зависимостью, а не
   * оттенком `SpendNotice`: у сломанного чтения нет вердикта, и врать
   * нулевым («0 ₽ из 1000 ₽») нельзя — это тот же «процент без строки».
   */
  readonly onBroken?: ((window: SpendWindow, error: unknown) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface SpendNotice {
  readonly window: SpendWindow;
  readonly verdict: CeilingVerdict;
  /** Потолок перейдён (в отличие от «подходим к нему»). */
  readonly exceeded: boolean;
  /**
   * Потолок считает не весь расход: цена части вызовов неизвестна.
   *
   * Отдельный признак, а не оттенок предупреждения: «подходим к потолку»
   * и «потолок не защищает» требуют разных действий.
   */
  readonly blind?: boolean | undefined;
}

export interface SpendGuard {
  /**
   * Зовётся перед обращением к модели. Бросает `SpendCeilingError`,
   * если тратить больше нельзя.
   */
  readonly beforeCall: () => Promise<void>;
  /** Учесть потраченное вызовом: между проверками счёт ведёт страж. */
  readonly noteSpent: (micros: number) => void;
  /** Состояние потолков — для отчётов и реплик прогонов. */
  readonly report: () => Promise<readonly SpendNotice[]>;
}

/** Как часто перечитывать расход из базы. */
const CACHE_MS = 15_000;

/** Пустой страж: ни одного потолка не задано. */
const IDLE: SpendGuard = {
  beforeCall: () => Promise.resolve(),
  noteSpent: () => undefined,
  report: () => Promise.resolve([]),
};

interface Cached {
  readonly at: number;
  readonly base: number;
  readonly partial: boolean;
  /**
   * Начало окна, за которое посчитан `base`.
   *
   * Без него кэш переживал смену суток: первые пятнадцать секунд нового
   * дня суточный потолок сравнивался со **вчерашней** суммой и мог
   * остановить бота, когда денег на сегодня полно.
   */
  readonly since: number;
}

export function createSpendGuard(deps: SpendGuardDeps): SpendGuard {
  const windows: readonly { window: SpendWindow; ceiling: SpendCeiling }[] = [
    ...(deps.ceilings.total === undefined
      ? []
      : [{ window: 'all' as const, ceiling: deps.ceilings.total }]),
    ...(deps.ceilings.daily === undefined
      ? []
      : [{ window: 'day' as const, ceiling: deps.ceilings.daily }]),
  ];

  // Ни одного потолка — страж отсутствует полностью, а не «включён и
  // ничего не делает»: ни запросов, ни ветвлений на горячем пути.
  if (windows.length === 0) return IDLE;

  const now = deps.now ?? ((): Date => new Date());
  const warnShare = deps.warnShare ?? 0.8;

  const cache = new Map<SpendWindow, Cached>();
  /** Потрачено с момента последнего чтения базы — по каждому окну. */
  const sinceRead = new Map<SpendWindow, number>();
  /** О чём уже предупредили: одно предупреждение на окно и состояние. */
  const told = new Set<string>();

  async function spentIn(window: SpendWindow, ceiling: SpendCeiling): Promise<Cached | undefined> {
    const moment = now();
    const since = windowStart(window, moment);
    const boundary = since?.getTime() ?? 0;

    const cached = cache.get(window);
    const fresh = cached !== undefined && moment.getTime() - cached.at < CACHE_MS;

    // Кэш от другого окна не годится, каким бы свежим ни был.
    if (fresh && cached.since === boundary) return cached;

    /**
     * Что было известно **до** запроса — вычтется после него.
     *
     * Обнулять счёт вслепую нельзя: пока идёт запрос, конвейер успевает
     * потратить ещё, и `noteSpent` об этом доложит. Обнуление стёрло бы
     * доложенное, и до следующего чтения страж считал бы расход меньше
     * настоящего.
     *
     * Вычитаем ровно то, что было известно к началу запроса: строки этих
     * трат легли в базу раньше снимка — значит снимок их уже видит.
     * Доложенное **во время** запроса снимок мог не застать, поэтому его
     * оставляем в счёте.
     */
    const knownBefore = sinceRead.get(window) ?? 0;

    const spend = await accountSpend(deps.db, {
      currency: ceiling.currency,
      ...(since === undefined ? {} : { since }),
    });

    if (spend.otherCurrencies) {
      deps.logger?.warn(
        { window, currency: ceiling.currency },
        'Потолок расхода видит не весь счёт: часть вызовов в другой валюте',
      );
    }

    const read = {
      at: moment.getTime(),
      base: spend.spentMicros,
      partial: spend.partial,
      since: boundary,
    };

    cache.set(window, read);
    sinceRead.set(window, Math.max(0, (sinceRead.get(window) ?? 0) - knownBefore));

    return read;
  }

  function verdictFor(window: SpendWindow, ceiling: SpendCeiling, cached: Cached): CeilingVerdict {
    return ceilingVerdict(
      { spentMicros: cached.base + (sinceRead.get(window) ?? 0), partial: cached.partial },
      ceiling,
      warnShare,
    );
  }

  /**
   * Сказать один раз — но один раз **на окно**, а не на жизнь процесса.
   *
   * Ключ памяти сперва не содержал дня, и это ломало главное: бот живёт
   * неделями, значит со вторых суток ни предупреждение на 80%, ни
   * сообщение о перейдённом суточном потолке не уходили **никогда**. Бот
   * встал бы во второй раз молча — то есть страж защищал от повторения
   * 05.09 только в первые сутки после каждого перезапуска.
   */
  function tell(
    window: SpendWindow,
    verdict: CeilingVerdict,
    exceeded: boolean,
    boundary: number,
  ): void {
    const key = `${window}:${String(boundary)}:${exceeded ? 'over' : 'warn'}`;
    if (told.has(key)) return;
    told.add(key);

    const where = window === 'day' ? 'за сутки' : 'за всё время';
    const message = exceeded
      ? `Потолок расхода ${where} перейдён: потрачено ${rublesOf(verdict.spentMicros)} ₽ из ${rublesOf(verdict.ceilingMicros)} ₽. Обращения к модели остановлены.`
      : `Расход ${where} подходит к потолку: ${rublesOf(verdict.spentMicros)} ₽ из ${rublesOf(verdict.ceilingMicros)} ₽.`;

    deps.logger?.warn({ window, exceeded, spentMicros: verdict.spentMicros }, message);
    deps.onWarn?.({ window, verdict, exceeded });
  }

  function blind(window: SpendWindow, verdict: CeilingVerdict, boundary: number): void {
    const key = `${window}:${String(boundary)}:blind`;
    if (told.has(key)) return;
    told.add(key);

    const message =
      `Потолок расхода считает не всё: у части удавшихся вызовов цена неизвестна. ` +
      `Известно ${rublesOf(verdict.spentMicros)} ₽ из ${rublesOf(verdict.ceilingMicros)} ₽, ` +
      `настоящий расход больше.`;

    deps.logger?.warn({ window, spentMicros: verdict.spentMicros }, message);
    deps.onWarn?.({ window, verdict, exceeded: false, blind: true });
  }

  return {
    beforeCall: async (): Promise<void> => {
      for (const { window, ceiling } of windows) {
        let cached: Cached | undefined;

        try {
          cached = await spentIn(window, ceiling);
        } catch (error) {
          /**
           * Своя поломка не останавливает бота — свойство 2.
           *
           * Пропустить вызов при сломанном страже значит, в худшем
           * случае, потратить лишнее. Остановить разбор — значит лишить
           * человека ответа из-за нашей неполадки в учёте. Второе хуже.
           */
          deps.logger?.error(
            { err: error, window },
            'Страж расхода не смог прочитать расход — пропускаю вызов',
          );

          // Один раз на окно: иначе сломанная база даст сотню оповещений.
          const key = `${window}:broken`;
          if (!told.has(key)) {
            told.add(key);
            deps.onBroken?.(window, error);
          }

          continue;
        }

        if (cached === undefined) continue;

        const verdict = verdictFor(window, ceiling, cached);

        /**
         * Слепой потолок молчать не должен.
         *
         * Ключ прайса — имя модели, каким его пишет провайдер, а `latest`
         * у Yandex однажды переедет на другое поколение. В этот день все
         * вызовы станут бесценовыми, расход посчитается нулём, и потолок
         * перестанет срабатывать — тихо. «Ошибаемся в безопасную
         * сторону» здесь означает «не защищаем вовсе», и об этом надо
         * знать: тот же урок, что с процентом без строки.
         */
        if (verdict.partial) blind(window, verdict, cached.since);

        if (verdict.exceeded) {
          tell(window, verdict, true, cached.since);

          throw new SpendCeilingError(
            `потолок расхода ${window === 'day' ? 'за сутки' : 'за всё время'} перейдён: ` +
              `${rublesOf(verdict.spentMicros)} ₽ из ${rublesOf(verdict.ceilingMicros)} ₽`,
          );
        }

        if (verdict.warn) tell(window, verdict, false, cached.since);
      }
    },

    noteSpent: (micros: number): void => {
      if (!Number.isFinite(micros) || micros <= 0) return;

      for (const { window } of windows) {
        sinceRead.set(window, (sinceRead.get(window) ?? 0) + micros);
      }
    },

    report: async (): Promise<readonly SpendNotice[]> => {
      const notices: SpendNotice[] = [];

      for (const { window, ceiling } of windows) {
        try {
          const cached = await spentIn(window, ceiling);
          if (cached === undefined) continue;

          const verdict = verdictFor(window, ceiling, cached);
          notices.push({
            window,
            verdict,
            exceeded: verdict.exceeded,
            ...(verdict.partial ? { blind: true } : {}),
          });
        } catch (error) {
          deps.logger?.error({ err: error, window }, 'Не удалось собрать отчёт о расходе');
        }
      }

      return notices;
    },
  };
}
