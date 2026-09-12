import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { moveItemsToOwnTopics } from '../onboarding/backfill.js';
import { outputContextOf } from '../users/state.repo.js';
import type { TopicGateway } from './gateway.js';
import { refreshSummaries } from './summary.service.js';
import { removeThread } from './topics.service.js';
import { archiveTopicsExcept, listTopics, topicsFor, type ArchivedTopic } from './topics.repo.js';

export interface RetireTopicsDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** Без шлюза ветки в чате не трогаются, а сводки не обновляются. */
  readonly gateway?: TopicGateway | undefined;
}

export interface RetireTopicsResult {
  readonly archived: readonly ArchivedTopic[];
  /** Сколько записей переехало в тему по умолчанию. */
  readonly moved: number;
  /** Имена тем, из которых переехали записи (для журнала и §6.4). */
  readonly orphaned: readonly string[];
  readonly summaries: number;
}

/**
 * Сферы, которых человек не оставил, уходят целиком (ревизия этапа 3, E1).
 *
 * Четыре шага, и все четыре обязаны идти вместе: тема в архив → её
 * записи в тему по умолчанию (§6.4) → ветка снятой темы убирается из
 * чата → сводки оставшихся тем обновляются. Онбординг делал так с задачи
 * 2.14, а настройки — только первый шаг: пять дел из «здоровья» пропадали
 * из «Все задачи», ветка со сводкой висела в чате навсегда, а при
 * возврате галочки бот заводил вторую такую же. Теперь связка одна на
 * оба входа.
 *
 * Каждый шаг падает отдельно и пишется в журнал: запись не в той теме —
 * беда меньшая, чем застрявший опрос или настройка без ответа.
 */
export async function retireTopics(
  deps: RetireTopicsDeps,
  params: {
    readonly userId: string;
    readonly keep: readonly string[];
    /** Чат человека — для веток и сводок; без него они не трогаются. */
    readonly chatId?: number | undefined;
  },
): Promise<RetireTopicsResult> {
  const { db, logger, gateway } = deps;
  const { userId, chatId } = params;

  let archived: readonly ArchivedTopic[] = [];
  try {
    archived = await archiveTopicsExcept(db, userId, params.keep);
  } catch (error) {
    logger.error({ err: error, userId }, 'Не удалось убрать сферы в архив');
  }

  let moved = 0;
  let orphaned: readonly string[] = [];
  try {
    const retopic = await moveItemsToOwnTopics(db, userId, await topicsFor(db, userId));
    moved = retopic.moved;
    orphaned = retopic.orphaned;
  } catch (error) {
    logger.error({ err: error, userId }, 'Не удалось перенести записи в темы человека');
  }

  let summaries = 0;

  if (gateway && chatId !== undefined) {
    /**
     * Ветки архивных сфер убираются из чата: оставить их — значит
     * показывать человеку структуру, от которой он только что отказался.
     * Пропавшая ветка — не ошибка: он мог удалить её сам.
     */
    for (const topic of archived) {
      if (topic.tgThreadId === null) continue;
      try {
        await removeThread({ db, gateway, logger }, { chatId, threadId: topic.tgThreadId });
      } catch (error) {
        logger.warn({ err: error, topic: topic.name }, 'Не удалось убрать ветку архивной сферы');
      }
    }

    // §8.2: переехавшие записи должны появиться в сводках оставшихся тем.
    const context = await outputContextOf(db, userId);
    summaries = await refreshSummaries(
      { db, gateway, logger },
      {
        userId,
        chatId,
        topicNames: (await listTopics(db, userId)).map((topic) => topic.name),
        timeZone: context.timeZone,
        profile: context.textProfile,
      },
    );
  }

  return { archived, moved, orphaned, summaries };
}
