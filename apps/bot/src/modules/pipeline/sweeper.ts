import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import type { BufferLimits } from '../buffer/buffer.service.js';
import { pruneUpdates, UPDATE_LOG_RETENTION_MS } from '../gateway/updates.repo.js';
import { expireQuestions } from '../resolver/questions.repo.js';
import { recoverStuckBatches, usersAwaitingWork } from './recovery.js';

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
  /**
   * Пределы — **получателем**, а не значением (ревизия четвёртого этапа).
   *
   * Окно ожидания тишины правится в панели, и §15 обещает, что правка
   * действует без перезапуска. Снимок, взятый при подъёме бота, этого
   * обещания не исполняет: досмотр закрывал бы выгрузки по числу,
   * которое было верным месяц назад.
   *
   * Функция, а не значение, ещё и потому, что чтение идёт к базе: делать
   * его на каждом проходе можно (проход раз в минуту), а на каждой
   * выгрузке — незачем.
   */
  readonly limits?: (() => Promise<BufferLimits> | BufferLimits) | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface SweepResult {
  readonly requeued: number;
  readonly closed: number;
  readonly users: number;
  /**
   * Убрано из журнала апдейтов и закрыто протухших вопросов.
   *
   * `null` — не «ноль», а «не удалось». Пустая колонка в этом проекте
   * читается как факт, и сорвавшаяся уборка, отданная наверх нулём,
   * была бы неотличима от честного «убирать было нечего»: таблица
   * росла бы при зелёном здоровье.
   */
  readonly pruned: number | null;
  readonly expiredQuestions: number | null;
}

/**
 * Уборка, у которой не было своего дома (ревизия этапов 1–2).
 *
 * Обе функции были написаны, покрыты зелёными тестами и не звались
 * ниоткуда — тот самый образец «написано, покрыто тестами и
 * недостижимо», за который проект платил уже трижды. Планировщика,
 * которого они ждали (задача 3.14), в продукте нет; единственный
 * повторяющийся проход бота — этот, и дом у них здесь.
 *
 * **Чистка журнала апдейтов.** Он нужен ровно затем, чтобы отличить
 * повтор от нового; через сутки Telegram переотправлять перестаёт, и
 * всё старше — вечный рост таблицы плюс индекс
 * `telegram_updates_received_at_idx`, который платится на каждой
 * вставке в горячем пути и не окупался ничем.
 *
 * **Протухшие вопросы.** `openQuestionOf` закрывает такой вопрос при
 * первом же обращении человека — но у ушедшего человека обращения не
 * будет, и в панели его вопрос висит открытым вечно, а доля исходов
 * «время вышло» занижена ровно на таких людей.
 *
 * **Отказ не роняет проход и не молчит.** Досмотр — последний рубеж:
 * упавшая уборка не должна оставить человека без ответа. Но и
 * промолчать ей нельзя, иначе таблица росла бы при зелёном здоровье —
 * поэтому наверх уходит `null`, а не ноль.
 */
async function tidyUp(
  deps: SweepDeps,
  now: Date,
): Promise<Pick<SweepResult, 'pruned' | 'expiredQuestions'>> {
  let pruned: number | null = null;
  let expiredQuestions: number | null = null;

  try {
    pruned = await pruneUpdates(deps.db, new Date(now.getTime() - UPDATE_LOG_RETENTION_MS));
  } catch (error) {
    deps.logger.error({ err: error }, 'Не удалось почистить журнал апдейтов');
  }

  try {
    expiredQuestions = await expireQuestions(deps.db, now);
  } catch (error) {
    deps.logger.error({ err: error }, 'Не удалось закрыть протухшие вопросы');
  }

  if ((pruned ?? 0) > 0 || (expiredQuestions ?? 0) > 0) {
    deps.logger.info({ pruned, expiredQuestions }, 'Прибрано за собой');
  }

  return { pruned, expiredQuestions };
}
/** Один проход досмотра. Вынесен отдельно, чтобы тест не ждал таймера. */
export async function sweepOnce(deps: SweepDeps): Promise<SweepResult> {
  // Окно читается на каждом проходе: правка из панели обязана
  // действовать без перезапуска (§15).
  const limits = deps.limits === undefined ? undefined : await deps.limits();

  // Часы читаются один раз на проход: срок уборки и границы
  // восстановления обязаны считаться от одного и того же «сейчас».
  const now = deps.now === undefined ? new Date() : deps.now();

  const report = await recoverStuckBatches(deps.db, {
    ...(deps.now === undefined ? {} : { now }),
    ...(limits === undefined ? {} : { limits }),
  });

  const tidy = await tidyUp(deps, now);

  const userIds = [...new Set([...report.userIds, ...(await usersAwaitingWork(deps.db))])];

  if (userIds.length === 0) {
    return { requeued: 0, closed: 0, users: 0, ...tidy };
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
    ...tidy,
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
  /**
   * Проходы не накладываются — как у планировщика и у продления.
   *
   * Проход идёт по всем ждущим людям и зовёт настоящий разбор, а он
   * легко переваливает за минуту. Два прохода разом спорили бы за одни и
   * те же выгрузки: от двойного ответа спасал бы только замок на
   * человека, а спасать он должен от перезапуска, а не от нас самих.
   * С уборкой внутри прохода наложение стало ещё и двойным `delete`.
   */
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;

    void sweepOnce(deps)
      .catch((error: unknown) => {
        deps.logger.error({ err: error }, 'Досмотр застрявших выгрузок не удался');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
