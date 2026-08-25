import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import { batches } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import type { BufferLimits } from '../buffer/buffer.service.js';
import { recoverStuckBatches } from './recovery.js';

/**
 * Периодический досмотр застрявших выгрузок (задача 1.18).
 *
 * Восстановление при старте закрывает выгрузки, о которых забыла очередь,
 * — но только при старте. Этого мало, и вот почему.
 *
 * Перезапуск Redis на боевом сервере показал: соединения приложения
 * оживают, а воркер BullMQ отложенные задания больше не разбирает.
 * Выгрузка остаётся открытой навсегда, человек получает «Слушаю.» и
 * тишину до тех пор, пока кто-нибудь не перезапустит сервис. Отказ
 * молчаливый: ошибок нет, здоровье зелёное, всё «работает».
 *
 * Лечить перезапуском по обрыву связи — лечить один частный случай.
 * Задание может потеряться и иначе: сеть моргнула, Redis почистили,
 * процесс умер между постановкой и записью. Досмотр чинит любую из этих
 * причин, потому что смотрит не на очередь, а на состояние в базе —
 * единственный источник правды по §9.1 ТЗ.
 *
 * Обработка идёт напрямую, а не через очередь: если задание потерялось
 * из-за Redis, ставить новое туда же бессмысленно. Двойной обработки не
 * будет — она сериализуется тем же замком на пользователя, что и обычная.
 */

export interface SweepDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** Что делать с пользователем, у которого нашлась забытая выгрузка. */
  readonly process: (userId: string) => Promise<unknown>;
  readonly limits?: BufferLimits | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface SweepResult {
  readonly requeued: number;
  readonly closed: number;
  readonly users: number;
}

/**
 * Пользователи с выгрузками, ждущими разбора.
 *
 * Ждать своей очереди выгрузка может по двум причинам: её только что
 * закрыли — тогда задание уже стоит и досмотр просто не успеет вперёд
 * него, — либо задание потерялось. Второе снаружи не отличить от первого,
 * поэтому берём всех: лишний заход стоит одного запроса и упирается
 * в замок, а пропущенная выгрузка стоит человеку ответа.
 */
async function usersAwaitingWork(db: Database): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ userId: batches.userId })
    .from(batches)
    .where(eq(batches.status, 'queued'));

  return rows.map((row) => row.userId);
}

/** Один проход досмотра. Вынесен отдельно, чтобы тест не ждал таймера. */
export async function sweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const report = await recoverStuckBatches(deps.db, {
    ...(deps.now === undefined ? {} : { now: deps.now() }),
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
  });

  const userIds = [...new Set([...report.userIds, ...(await usersAwaitingWork(deps.db))])];

  if (userIds.length === 0) {
    return { requeued: 0, closed: 0, users: 0 };
  }

  // Ругаться стоит только когда что-то действительно пришлось исправлять.
  // Просто ждущая своей очереди выгрузка — обычное дело.
  if (report.requeuedProcessing > 0 || report.closedOrphanedOpen > 0) {
    deps.logger.warn(
      {
        requeued: report.requeuedProcessing,
        closed: report.closedOrphanedOpen,
        users: userIds.length,
      },
      'Подобрал выгрузки, о которых очередь забыла',
    );
  }

  for (const userId of userIds) {
    // Сбой на одном пользователе не должен останавливать досмотр:
    // остальные ждут своего разбора не меньше.
    try {
      await deps.process(userId);
    } catch (error) {
      deps.logger.error({ err: error, userId }, 'Не удалось дообработать выгрузку');
    }
  }

  return {
    requeued: report.requeuedProcessing,
    closed: report.closedOrphanedOpen,
    users: userIds.length,
  };
}

export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Запускает досмотр по таймеру. Возвращает функцию остановки — без неё
 * таймер удерживал бы процесс при штатном завершении.
 */
export function startRecoverySweep(
  deps: SweepDeps,
  intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void sweepOnce(deps).catch((error: unknown) => {
      deps.logger.error({ err: error }, 'Досмотр застрявших выгрузок не удался');
    });
  }, intervalMs);

  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
