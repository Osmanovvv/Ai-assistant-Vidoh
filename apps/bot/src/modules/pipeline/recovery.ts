import { and, eq, lt, or, sql } from 'drizzle-orm';

import { batches } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { DEFAULT_LIMITS, silenceThreshold, type BufferLimits } from '../buffer/buffer.service.js';

/**
 * Восстановление после перезапуска (задача 1.18).
 *
 * §9.1 правило 4 ТЗ: выгрузки в обработке переподхватываются при старте
 * сервиса, незавершённая обработка возобновляется, а не теряется.
 *
 * Второй сценарий, которого в §17 ТЗ нет: потеря Redis. Очередь и
 * отложенные задания живут там, и после очистки Redis открытая выгрузка
 * никогда не закроется — закрывающее задание исчезло вместе с очередью.
 * Поэтому при старте мы дозакрываем всё, что провисело дольше потолка.
 */

export interface RecoveryReport {
  /** Выгрузки, застрявшие в обработке из-за падения процесса. */
  readonly requeuedProcessing: number;
  /** Открытые выгрузки, чьё закрывающее задание потерялось. */
  readonly closedOrphanedOpen: number;
  /** Пользователи, которых надо поставить в очередь заново. */
  readonly userIds: readonly string[];
}

export async function recoverStuckBatches(
  db: Database,
  params: { readonly now?: Date; readonly limits?: BufferLimits } = {},
): Promise<RecoveryReport> {
  const now = params.now ?? new Date();
  const limits = params.limits ?? DEFAULT_LIMITS;

  return await db.transaction(async (tx): Promise<RecoveryReport> => {
    /**
     * Процесс умер посреди обработки: статус processing остался висеть.
     * Возвращаем в очередь — обработка идемпотентна на уровне выгрузки.
     *
     * **Но только застрявшую, а не идущую.** Досмотр зовёт это правило
     * раз в минуту, и без порога оно возвращало в очередь живой
     * разбор: боевое 04.09.2026, 18:25:31 — выгрузка закрыта в 18:24:49,
     * разбор шёл, и через сорок секунд досмотр счёл его умершим. Замок на
     * пользователя спас от двойного ответа, но журнал врал «очередь
     * забыла», а с потерянным замком ответ пришёл бы дважды.
     *
     * Возраст считается от **начала разбора**, а не от закрытия.
     *
     * От закрытия он врал на целый класс выгрузок: пролежавшая в очереди
     * час из-за нашего же простоя (доступ к модели кончился, попытка
     * нарочно не тратится) выглядела застрявшей в первую же миллисекунду
     * работы. Закрытие и открытие остаются запасными: у выгрузок,
     * взятых в работу до появления столбца, отметки нет.
     */
    const processingThreshold = new Date(now.getTime() - limits.maxProcessingMs);

    const requeued = await tx
      .update(batches)
      .set({ status: 'queued' })
      .where(
        and(
          eq(batches.status, 'processing'),
          sql`coalesce(${batches.processingAt}, ${batches.closedAt}, ${batches.openedAt}) <= ${processingThreshold}`,
        ),
      )
      .returning({ userId: batches.userId });

    // Открытая выгрузка старше жёсткого потолка: либо Redis потерял
    // задание, либо процесс не дожил до его постановки. Закрываем.
    const staleThreshold = new Date(now.getTime() - limits.maxBatchAgeMs);

    // Порог тишины — общей функцией с закрытием по тишине: это одно и то
    // же число, и посчитай мы его здесь вторым способом, расхождение
    // выглядело бы как «очередь потеряла задание».
    const silenceAt = silenceThreshold(now, limits.silenceWindowMs);

    const closed = await tx
      .update(batches)
      .set({ status: 'queued', closedAt: now })
      .where(
        and(
          eq(batches.status, 'open'),
          or(lt(batches.openedAt, staleThreshold), sql`${batches.lastMessageAt} <= ${silenceAt}`),
        ),
      )
      .returning({ userId: batches.userId });

    const userIds = [...new Set([...requeued, ...closed].map((row) => row.userId))];

    return {
      requeuedProcessing: requeued.length,
      closedOrphanedOpen: closed.length,
      userIds,
    };
  });
}

/**
 * Пользователи, чьи выгрузки ждут разбора.
 *
 * Ждать своей очереди выгрузка может по двум причинам: её только что
 * закрыли — тогда задание уже стоит и досмотр просто не успеет вперёд
 * него, — либо задание потерялось. Второе снаружи не отличить от
 * первого, поэтому берём всех: лишний заход стоит одного запроса и
 * упирается в замок, а пропущенная выгрузка стоит человеку ответа.
 *
 * Живёт здесь, а не в досмотре, потому что читателей теперь двое —
 * досмотр и подъём процесса. Второй такой же запрос рядом однажды
 * разошёлся бы с этим.
 */
export async function usersAwaitingWork(db: Database): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ userId: batches.userId })
    .from(batches)
    .where(eq(batches.status, 'queued'));

  return rows.map((row) => row.userId);
}

/** Отчёт восстановления при подъёме процесса. */
export interface RestartRecoveryReport extends RecoveryReport {
  /** Пользователи, чьи выгрузки ждали в очереди ещё до перезапуска. */
  readonly awaitingUsers: number;
}

/**
 * Восстановление при подъёме процесса (§9.1 правило 4, задача 1.18).
 *
 * От досмотра отличается двумя вещами, и обе — про порог.
 *
 * **Потолок обработки здесь ноль.** Три минуты писались для досмотра,
 * чтобы он не возвращал в очередь разбор, идущий прямо сейчас (боевое
 * 04.09.2026). При подъёме такого разбора нет: воркер в боевой сборке
 * один, он родился секунду назад, а всё, что осталось в `processing`,
 * осталось от убитого предшественника. С общим порогом человек, чью
 * выгрузку убила выкладка, ждал бы ответа три минуты вместо секунд — и
 * добирал бы его досмотр со строкой «Подобрал выгрузки, о которых
 * очередь забыла», хотя забыли не в очереди, а здесь.
 *
 * **Выгрузки, уже ждущие в очереди, тоже наши.** В отчёт правок они не
 * попадают — статус у них верный, потерялось задание. Так остаются
 * лежать закрытые потолком между записью в базу и постановкой задания,
 * возвращённые в очередь нашим простоем и перезапущенные из панели
 * перед самой выкладкой.
 *
 * **Первого прохода досмотра сразу после этого не делается нарочно.**
 * Это была бы та же работа второй раз, и хуже: досмотр возвращает в
 * очередь то, что подъём миллисекундой раньше отдал воркеру. Досмотр —
 * страховка от потерь **после** подъёма, и его минута здесь ни при чём.
 */
export async function recoverAfterRestart(
  db: Database,
  params: { readonly now?: Date; readonly limits?: BufferLimits } = {},
): Promise<RestartRecoveryReport> {
  const limits = params.limits ?? DEFAULT_LIMITS;

  const report = await recoverStuckBatches(db, {
    ...(params.now === undefined ? {} : { now: params.now }),
    limits: { ...limits, maxProcessingMs: 0 },
  });

  // Тех, кого мы только что вернули в очередь, уже посчитали выше: без
  // вычитания одно и то же число уехало бы в журнал дважды под разными
  // именами.
  const awaiting = (await usersAwaitingWork(db)).filter((id) => !report.userIds.includes(id));

  return {
    ...report,
    awaitingUsers: awaiting.length,
    userIds: [...report.userIds, ...awaiting],
  };
}
