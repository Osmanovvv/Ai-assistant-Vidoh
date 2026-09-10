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
  /**
   * Часы — швом, а не `new Date()` внутри.
   *
   * Без него проверку на остаток окна пришлось бы писать диапазоном и
   * закладываться на скорость машины: «между вставкой выгрузки и заходом
   * прошло меньше секунды». На загруженной машине такой страж краснеет
   * не по делу, а страж, краснеющий не по делу, скоро перестают читать.
   */
  readonly now?: (() => Date) | undefined;
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
  /**
   * Остаток окна, на который переставлено задание. Есть только у
   * переставленного: закрытой выгрузке переставлять нечего.
   */
  readonly retryInMs?: number;
}

/**
 * Закрыть выгрузку, если тишина выдержана; иначе — переставить задание.
 *
 * **Переставить, а не бросить.** Прежний комментарий в воркере
 * утверждал «человек дописал, и стоит новое задание», но нового задания
 * не было: `scheduleBatchClose` вызывается только из приёма сообщений, и
 * дописавший человек его не ставит. Выгрузку подхватывал досмотр — с
 * опозданием и с ложной записью в журнал.
 *
 * **Но не на всякий отказ, и это ловушка для чинящего.** Выгрузку могли
 * закрыть и без нас — потолком сообщений или возраста прямо в приёме,
 * досмотром, соседним заходом. Задание, переставленное на закрытую
 * выгрузку, ставило бы себя заново каждое окно тишины и не кончилось бы
 * никогда. Поэтому причину отказа даёт `closeBatchOnSilence`, а не
 * догадка по булеву значению.
 *
 * **И на остаток окна, а не на окно целиком** (ревизия этапа 4, пункт
 * 2.2): ждать заново полминуты после слова, сказанного секунду назад, —
 * это лишние полминуты молчания бота.
 */
export async function runCloseBatchJob(
  deps: CloseJobDeps,
  params: { readonly batchId: string; readonly userId: string },
): Promise<CloseJobResult> {
  const limits = await effectiveLimits(deps.settings, DEFAULT_LIMITS);

  const outcome = await closeBatchOnSilence(deps.db, params.batchId, {
    silenceWindowMs: limits.silenceWindowMs,
    ...(deps.now === undefined ? {} : { now: deps.now() }),
  });

  if (outcome.closed) {
    await deps.process(params.userId);

    return { closed: true, rescheduled: false, silenceWindowMs: limits.silenceWindowMs };
  }

  if (outcome.reason === 'not_open') {
    // Закрыли без нас: потолок в приёме, досмотр, соседний заход. Разбор
    // человеку поставил тот, кто закрыл, — добавить нам нечего, а
    // переставить себя на закрытую выгрузку значит завести круг без конца.
    return { closed: false, rescheduled: false, silenceWindowMs: limits.silenceWindowMs };
  }

  await deps.reschedule({
    batchId: params.batchId,
    userId: params.userId,
    delayMs: outcome.retryInMs,
  });

  return {
    closed: false,
    rescheduled: true,
    silenceWindowMs: limits.silenceWindowMs,
    retryInMs: outcome.retryInMs,
  };
}
