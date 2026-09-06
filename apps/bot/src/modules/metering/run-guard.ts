import type { Logger } from 'pino';

import type { Executor } from '../../infra/db.js';
import { ceilingFromEnv, type SpendCeiling } from './account-spend.js';
import { costLine, runCost } from './run-cost.js';
import { createSpendGuard, type SpendGuard } from './spend-guard.js';

/**
 * Обвязка платного прогона: потолок до, цена после (задача 3.79).
 *
 * **Вынесено потому, что платных прогонов пять, а не два.** Первый заход
 * закрыл `run-eval` и сквозной — и встречная проверка сразу показала
 * остальные: `run-resolver-eval` гоняет целый набор по полной модели,
 * `check-crisis` прогоняет десятки текстов через маршрутизатор,
 * `check-deadlines` — классификацию. Тот, кто 04.09.2026 запускал
 * прогоны «по многу раз в день», с равной вероятностью запускал бы и
 * эти: имя другое, цена того же порядка, защиты не было.
 *
 * Копипаста здесь опаснее обычной: разойдутся пять копий — и часть
 * прогонов останется без потолка молча, а именно молчание и стоило
 * гранта.
 */

export interface RunGuardEnv {
  readonly ACCOUNT_SPEND_CEILING_RUB?: number | undefined;
  readonly ACCOUNT_SPEND_DAILY_RUB?: number | undefined;
  readonly ACCOUNT_SPEND_WARN_SHARE: number;
}

export interface RunGuard {
  readonly ceilings: { readonly total?: SpendCeiling | undefined };
  readonly spendGuard: SpendGuard;
  /**
   * Проверить потолок до первого платного вызова.
   *
   * Возвращает причину отказа или `undefined`. Не бросает: решение, что
   * делать с отказом — печатать и выйти или продолжить, — принимает сам
   * прогон, а не обвязка.
   */
  readonly checkBefore: () => Promise<string | undefined>;
  /** Цена прогона строкой. Никогда не бросает. */
  readonly costReport: () => Promise<string>;
  /** Потолок перейдён к концу прогона: замер мерил деньги, а не качество. */
  readonly stoppedByCeiling: () => Promise<boolean>;
}

export function createRunGuard(params: {
  readonly db: Executor;
  readonly env: RunGuardEnv;
  readonly logger?: Logger | undefined;
  readonly startedAt: Date;
}): RunGuard {
  const total = ceilingFromEnv(params.env.ACCOUNT_SPEND_CEILING_RUB);
  const daily = ceilingFromEnv(params.env.ACCOUNT_SPEND_DAILY_RUB);

  const ceilings = {
    ...(total === undefined ? {} : { total }),
    ...(daily === undefined ? {} : { daily }),
  };

  const spendGuard = createSpendGuard({
    db: params.db,
    ceilings,
    warnShare: params.env.ACCOUNT_SPEND_WARN_SHARE,
    ...(params.logger === undefined ? {} : { logger: params.logger }),
  });

  return {
    ceilings,
    spendGuard,

    checkBefore: async (): Promise<string | undefined> => {
      try {
        await spendGuard.beforeCall();
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },

    costReport: async (): Promise<string> => {
      try {
        const cost = await runCost(params.db, { startedAt: params.startedAt, now: new Date() });
        return costLine(cost, ceilings);
      } catch (error) {
        /**
         * Цена — не итог прогона: её потеря не должна ни менять код
         * выхода, ни рушить прогон. В `run-eval` эту обёртку сперва
         * забыли, и три запроса про деньги могли объявить зелёный
         * прогон провалившимся.
         */
        return `Цену прогона посчитать не удалось: ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    stoppedByCeiling: async (): Promise<boolean> => {
      try {
        return (await spendGuard.report()).some((notice) => notice.exceeded);
      } catch {
        // Не знаем — значит не мешаем: замер сохранится, как раньше.
        return false;
      }
    },
  };
}
