import { and, eq, isNull, lte } from 'drizzle-orm';

import { pendingQuestions, type PendingQuestion, type QuestionOutcome } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { ResolverAnswer } from '../ai/schemas/index.js';

/**
 * Открытый уточняющий вопрос (§7.3 ТЗ, задача 3.5).
 *
 * «Пока вопрос не отвечен, сегмент хранится в таблице открытых вопросов
 * и не теряется. Если пользовательница не ответила и прислала новую
 * выгрузку, вопрос снимается, сегмент трактуется как новая запись, и бот
 * к нему больше не возвращается: продукт не имеет права превращаться в
 * допрос.»
 *
 * Жизненный цикл ТЗ описывает наполовину, остальное решено здесь:
 *
 * - **один открытый вопрос на человека** — иначе это допрос;
 * - **шесть часов** — и вопрос снимается сам. Числа в ТЗ нет: сутки
 *   значили бы вопрос про позавчерашнее, час — что отошедший от телефона
 *   человек его не увидит вовсе;
 * - **снятый вопрос отвечает, что неактуален**, а не молчит и не падает:
 *   кнопка остаётся в чате навсегда.
 *
 * Во всех трёх случаях сегмент не теряется — он становится новой
 * записью. §9.1: сказанное человеком не пропадает.
 */

/** Сколько живёт неотвеченный вопрос. */
export const QUESTION_TTL_HOURS = 6;

export interface AskParams {
  readonly userId: string;
  readonly itemId: string;
  /** Выгрузка, из которой родился вопрос. */
  readonly batchId: string;
  /** Сказанное человеком: то, что ждёт ответа. */
  readonly segment: string;
  readonly action: string;
  readonly changes: ResolverAnswer['changes'];
  readonly now?: Date | undefined;
  readonly ttlHours?: number | undefined;
}

/**
 * Заводит вопрос, сняв предыдущий.
 *
 * Предыдущий снимается здесь, а не отдельным вызовом: два открытых
 * вопроса запрещены индексом, и попытка завести второй иначе просто
 * упала бы. Снимается он как `superseded` — человек занят новым, к
 * старому бот не вернётся.
 */
export async function askQuestion(db: Executor, params: AskParams): Promise<PendingQuestion> {
  const now = params.now ?? new Date();
  const ttl = params.ttlHours ?? QUESTION_TTL_HOURS;

  await closeOpenQuestion(db, params.userId, 'superseded', now);

  const [row] = await db
    .insert(pendingQuestions)
    .values({
      userId: params.userId,
      itemId: params.itemId,
      batchId: params.batchId,
      segment: params.segment,
      action: params.action,
      changes: params.changes,
      expiresAt: new Date(now.getTime() + ttl * 60 * 60_000),
    })
    .returning();

  if (!row) throw new Error('Вопрос не записался');
  return row;
}

/**
 * Открытый вопрос человека, если он есть и ещё не протух.
 *
 * Протухший не возвращается и тут же закрывается: срок вышел, и
 * возвращаться к нему бот не станет.
 */
export async function openQuestionOf(
  db: Executor,
  userId: string,
  now = new Date(),
): Promise<PendingQuestion | undefined> {
  const [row] = await db
    .select()
    .from(pendingQuestions)
    .where(and(eq(pendingQuestions.userId, userId), isNull(pendingQuestions.resolvedAt)))
    .limit(1);

  if (!row) return undefined;

  if (row.expiresAt.getTime() <= now.getTime()) {
    await closeOpenQuestion(db, userId, 'timeout', now);
    return undefined;
  }

  return row;
}

/** Закрывает открытый вопрос человека. Возвращает закрытый, если он был. */
export async function closeOpenQuestion(
  db: Executor,
  userId: string,
  outcome: QuestionOutcome,
  now = new Date(),
): Promise<PendingQuestion | undefined> {
  const [row] = await db
    .update(pendingQuestions)
    .set({ resolvedAt: now, outcome })
    .where(and(eq(pendingQuestions.userId, userId), isNull(pendingQuestions.resolvedAt)))
    .returning();

  return row;
}

export type AnswerOutcome =
  /** Вопрос был открыт и теперь закрыт этим ответом. */
  | { readonly kind: 'answered'; readonly question: PendingQuestion }
  /** Вопрос уже снят: ответом, новой выгрузкой или временем. */
  | { readonly kind: 'stale' };

/**
 * Отвечает на конкретный вопрос.
 *
 * Идентификатор проверяется вместе с владельцем и вместе с тем, что
 * вопрос ещё открыт. Кнопка живёт в чате вечно, и нажатие по вчерашней —
 * обычное дело, а не ошибка.
 */
export async function answerQuestion(
  db: Executor,
  params: {
    readonly questionId: string;
    readonly userId: string;
    readonly outcome: Extract<QuestionOutcome, 'attached' | 'separate'>;
    readonly now?: Date | undefined;
  },
): Promise<AnswerOutcome> {
  const now = params.now ?? new Date();

  const [row] = await db
    .update(pendingQuestions)
    .set({ resolvedAt: now, outcome: params.outcome })
    .where(
      and(
        eq(pendingQuestions.id, params.questionId),
        eq(pendingQuestions.userId, params.userId),
        isNull(pendingQuestions.resolvedAt),
      ),
    )
    .returning();

  if (!row) return { kind: 'stale' };

  // Протухший вопрос считается снятым, даже если строка ещё открыта:
  // время вышло раньше, чем человек нажал.
  if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'stale' };

  return { kind: 'answered', question: row };
}

/**
 * Закрывает всё, у чего вышел срок.
 *
 * Нужна планировщику (3.14): пока его нет, протухшее закрывается при
 * первом же обращении к вопросу человека — но полагаться на то, что
 * человек придёт, нельзя.
 */
export async function expireQuestions(db: Executor, now = new Date()): Promise<number> {
  const rows = await db
    .update(pendingQuestions)
    .set({ resolvedAt: now, outcome: 'timeout' })
    .where(and(isNull(pendingQuestions.resolvedAt), lte(pendingQuestions.expiresAt, now)))
    .returning({ id: pendingQuestions.id });

  return rows.length;
}
