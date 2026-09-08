import { closeBatchOnSilence, DEFAULT_LIMITS } from '../buffer/buffer.service.js';
import { effectiveLimits, type SettingsRegistry } from '../settings/settings.repo.js';
import type { Database } from '../../infra/db.js';

/**
 * Задание «закрыть выгрузку по тишине» (§9.1, задачи 2.4 и 4.9).
 *
 * **Отдельным модулем, а не строками внутри воркера** — и это правка
 * ревизии четвёртого этапа. В воркере оно было непроверяемо: воркер
 * поднимается вместе с ботом, очередью и Redis, и проверка на него не
 * написана ни одна. Именно там и жил дефект: окно ожидания тишины
 * бралось константой из кода, хотя задание ставилось значением из
 * панели. Одно и то же число двумя способами.
 *
 * Что это стоило:
 *  - окно **меньше** тридцати секунд не применялось вовсе: задание
 *    срабатывало вовремя, а выгрузка не закрывалась — тишина «ещё не
 *    выдержана» по мнению константы;
 *  - окно **больше** доезжало только досмотром, то есть с опозданием до
 *    минуты, и в журнал попадала строка «подобрал выгрузки, о которых
 *    очередь забыла» — обвинение очереди в чужой ошибке.
 *
 * Условие готовности задачи 4.9 названо именно про это: «изменение из
 * админки применяется без перезапуска».
 */

export interface CloseJobDeps {
  readonly db: Database;
  /** Реестр настроек: окно читается в момент закрытия, а не при старте. */
  readonly settings?: SettingsRegistry | undefined;
  /** Поставить задание заново — на новое окно. */
  readonly reschedule: (params: {
    readonly batchId: string;
    readonly userId: string;
    readonly delayMs: number;
  }) => Promise<unknown>;
  /** Отдать выгрузки человека в разбор. */
  readonly process: (userId: string) => Promise<unknown>;
}

export interface CloseJobResult {
  readonly closed: boolean;
  /** Задание переставлено: человек дописал, тишину ждём снова. */
  readonly rescheduled: boolean;
  /** Окно, по которому решали. Ради журнала и проверок. */
  readonly silenceWindowMs: number;
}

/**
 * Закрыть выгрузку, если тишина выдержана; иначе — переставить задание.
 *
 * **Переставить, а не бросить.** Прежний комментарий в воркере
 * утверждал «человек дописал, и стоит новое задание», но нового задания
 * не было: `scheduleBatchClose` вызывается только из приёма сообщений, и
 * дописавший человек его не ставит. Выгрузку подхватывал досмотр — с
 * опозданием и с ложной записью в журнал.
 */
export async function runCloseBatchJob(
  deps: CloseJobDeps,
  params: { readonly batchId: string; readonly userId: string },
): Promise<CloseJobResult> {
  const limits = await effectiveLimits(deps.settings, DEFAULT_LIMITS);

  const closed = await closeBatchOnSilence(deps.db, params.batchId, {
    silenceWindowMs: limits.silenceWindowMs,
  });

  if (closed) {
    await deps.process(params.userId);

    return { closed: true, rescheduled: false, silenceWindowMs: limits.silenceWindowMs };
  }

  await deps.reschedule({
    batchId: params.batchId,
    userId: params.userId,
    delayMs: limits.silenceWindowMs,
  });

  return { closed: false, rescheduled: true, silenceWindowMs: limits.silenceWindowMs };
}
