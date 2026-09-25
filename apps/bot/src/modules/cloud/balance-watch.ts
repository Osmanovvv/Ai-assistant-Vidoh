import { readFile } from 'node:fs/promises';

import type { Logger } from 'pino';

import type { Alert } from '../../infra/monitoring.js';
import {
  parseServiceAccountKey,
  YandexBalanceWatch,
  YandexBillingClient,
  type BalanceStatus,
} from './yandex-billing.js';

/**
 * Запуск сторожа баланса при старте бота (проджект, 21.09.2026).
 *
 * Файл ключа не задан — сторожа нет, и это законное состояние: бот от
 * баланса не зависит, плитка в панели скажет «не настроено». Файл не
 * читается — отказ словами в журнал, без содержимого файла, и бот
 * поднимается без сторожа: падать из-за плитки нельзя.
 *
 * Проверка идёт сразу при старте и потом раз в полчаса; облако при этом
 * спрашивается не чаще раза в десять минут (кэш внутри сторожа).
 */

/** Как часто сторож сверяет остаток с порогом. */
const CHECK_EVERY_MS = 30 * 60_000;

export interface BalanceWatchHandle {
  readonly watch: { readonly status: () => Promise<BalanceStatus> };
  readonly stop: () => void;
}

export interface StartBalanceWatchParams {
  readonly keyFile: string | undefined;
  readonly thresholdRub: () => Promise<number>;
  readonly alert: (alert: Alert) => Promise<boolean>;
  /** Стереть память о предупреждении, когда баланс снова выше порога. */
  readonly forget?: ((key: string) => Promise<void>) | undefined;
  readonly logger: Logger;
  /** Подмена сторожа — для проверки расписания без сети и без ключа. */
  readonly watch?:
    | { readonly status: () => Promise<BalanceStatus>; readonly check: () => Promise<void> }
    | undefined;
  readonly everyMs?: number | undefined;
}

export async function startBalanceWatch(
  params: StartBalanceWatchParams,
): Promise<BalanceWatchHandle | undefined> {
  const { logger } = params;

  let watch = params.watch;

  if (watch === undefined) {
    if (params.keyFile === undefined) {
      logger.info(
        'YANDEX_SA_KEY_FILE не задан: плитки баланса Yandex Cloud в панели нет — это нормально',
      );
      return undefined;
    }

    try {
      const text = await readFile(params.keyFile, 'utf8');
      const key = parseServiceAccountKey(text, params.keyFile);
      watch = new YandexBalanceWatch({
        client: new YandexBillingClient({ key }),
        thresholdRub: params.thresholdRub,
        alert: params.alert,
        forget: params.forget,
        logger,
      });
      logger.info({ файл: params.keyFile }, 'Сторож баланса Yandex Cloud запущен');
    } catch (error) {
      // Содержимое файла в журнал не попадает: ошибки разбора называют
      // только имя файла и недостающие поля.
      logger.error(
        { why: error instanceof Error ? error.message : String(error) },
        'Сторож баланса Yandex Cloud не запустился: ключ не прочитался',
      );
      return undefined;
    }
  }

  const running = watch;
  const tick = (): void => {
    void running.check().catch((error: unknown) => {
      logger.warn(
        { why: error instanceof Error ? error.message : String(error) },
        'Проверка баланса Yandex Cloud не удалась',
      );
    });
  };

  const first = setTimeout(tick, 0);
  first.unref();
  const timer = setInterval(tick, params.everyMs ?? CHECK_EVERY_MS);
  timer.unref();

  return {
    watch: running,
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
