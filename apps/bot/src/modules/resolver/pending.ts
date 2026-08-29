import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import type { ResolverAnswer } from '../ai/schemas/index.js';
import { saveDraft } from '../items/items.repo.js';
import { readAnswer } from './answer.js';
import { applyDecision, type Applied } from './patch.js';
import { answerQuestion, closeOpenQuestion, openQuestionOf } from './questions.repo.js';

/**
 * Судьба открытого вопроса при новой выгрузке (§7.3 ТЗ, задача 3.6).
 *
 * Две ветки, обе из ТЗ:
 *
 * - человек **ответил голосом** — «да, к прошлой», «это новое», «не
 *   знаю». Голосовой ответ обязан работать так же, как нажатие кнопки:
 *   весь продукт про то, чтобы говорить, а не нажимать;
 * - человек **не ответил и прислал новое** — «вопрос снимается, сегмент
 *   трактуется как новая запись, и бот к нему больше не возвращается:
 *   продукт не имеет права превращаться в допрос».
 *
 * **Запись заводится только там, где человек её попросил.** «Это новое»
 * — попросил, и сказанное уходит в разбор вместе с текущей выгрузкой.
 * «Не знаю» и молчание — не попросил, и сказанное сохраняется
 * черновиком: превратить «нет, в пятницу» в задачу «в пятницу» хуже, чем
 * не разобрать вовсе. Тот же довод второй этап уже применил к правкам.
 */

export type PendingKind =
  /** Открытого вопроса не было. */
  | 'none'
  /** «К прошлой»: изменение применено, есть что отменять. */
  | 'applied'
  /** «К прошлой», но запись уже в этом состоянии. */
  | 'nothingToApply'
  /** «Это новое»: сказанное пойдёт в разбор этой выгрузки. */
  | 'separate'
  /** Ответ есть, но прочитать его не вышло. */
  | 'unclear'
  /** Ответа не было: вопрос снят новой выгрузкой. */
  | 'superseded';

export interface PendingResult {
  readonly kind: PendingKind;
  readonly applied?: Applied | undefined;
  /**
   * Сказанное, которое надо разобрать вместе с этой выгрузкой.
   *
   * Не отдельным вызовом модели: выгрузка всё равно сейчас разбирается,
   * и лишний вызов стоил бы денег ради того же результата.
   */
  readonly carryOver?: string | undefined;
}

export interface SettleParams {
  readonly userId: string;
  readonly batchId: string;
  readonly timeZone: string;
  /** Текст сегмента с намерением `ANSWER`. Нет — человек не отвечал. */
  readonly answerText?: string | undefined;
  readonly now?: Date | undefined;
  readonly logger?: Logger | undefined;
}

export async function settlePendingQuestion(
  db: Database,
  params: SettleParams,
): Promise<PendingResult> {
  const now = params.now ?? new Date();
  const open = await openQuestionOf(db, params.userId, now);

  if (!open) return { kind: 'none' };

  /** Сказанное не пропадает ни в одном исходе (§9.1). */
  const park = async (reason: string): Promise<void> => {
    await saveDraft(db, {
      userId: params.userId,
      batchId: open.batchId,
      text: open.segment,
      reason,
    });
  };

  if (params.answerText === undefined) {
    await closeOpenQuestion(db, params.userId, 'superseded', now);
    await park('вопрос снят новой выгрузкой — ответа не было');

    params.logger?.info({ userId: params.userId }, 'Открытый вопрос снят новой выгрузкой');
    return { kind: 'superseded' };
  }

  const reading = readAnswer(params.answerText);

  if (reading === 'unclear') {
    // Ответ был, но что он значит — неизвестно. Переспрашивать §7.3
    // запрещает, угадывать тем более.
    await closeOpenQuestion(db, params.userId, 'superseded', now);
    await park('ответ на вопрос не прочитан');

    return { kind: 'unclear' };
  }

  const outcome = await answerQuestion(db, {
    questionId: open.id,
    userId: params.userId,
    outcome: reading === 'attach' ? 'attached' : 'separate',
    now,
  });

  // Между чтением и ответом вопрос мог снять кто-то ещё — например
  // нажатие кнопки, пришедшее пока шла расшифровка.
  if (outcome.kind === 'stale') return { kind: 'none' };

  if (reading === 'separate') return { kind: 'separate', carryOver: open.segment };

  const applied = await applyDecision(db, {
    userId: params.userId,
    itemId: open.itemId,
    action: open.action === 'complete' || open.action === 'cancel' ? open.action : 'update',
    changes: open.changes as ResolverAnswer['changes'],
    timeZone: params.timeZone,
    now,
    reason: 'человек подтвердил голосом',
    changedBy: 'user',
  });

  return applied === undefined ? { kind: 'nothingToApply' } : { kind: 'applied', applied };
}
