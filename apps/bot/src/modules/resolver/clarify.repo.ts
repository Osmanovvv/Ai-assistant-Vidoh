import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import { items } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { CLARIFY_REASON, CLARIFY_TTL_MS, type ClarifyKind } from './clarify.js';

/** Переспрос, который ждёт ответа: черновик невыполненной команды. */
export interface OpenClarification {
  readonly id: string;
  readonly kind: ClarifyKind;
  /** Команда человека, как он её сказал. */
  readonly command: string;
}

const KIND_BY_REASON = new Map(
  (Object.entries(CLARIFY_REASON) as [ClarifyKind, string][]).map(([kind, reason]) => [
    reason,
    kind,
  ]),
);

/** Последний переспрос за четверть часа, ещё без ответа. */
export async function openClarification(
  db: Executor,
  userId: string,
  now: Date,
): Promise<OpenClarification | undefined> {
  const [row] = await db
    .select({ id: items.id, text: items.text, reason: items.draftReason })
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        eq(items.isDraft, true),
        inArray(items.draftReason, [...KIND_BY_REASON.keys()]),
        gte(items.createdAt, new Date(now.getTime() - CLARIFY_TTL_MS)),
      ),
    )
    .orderBy(desc(items.createdAt))
    .limit(1);

  const kind =
    row?.reason === null || row === undefined ? undefined : KIND_BY_REASON.get(row.reason);
  return row === undefined || kind === undefined
    ? undefined
    : { id: row.id, kind, command: row.text };
}

/**
 * Переспрос закрыт следующей репликой — ответом или нет. Ждёт он только
 * одну реплику: иначе сказанное через три сообщения доделало бы команду,
 * о которой человек уже забыл. Черновик остаётся — пометка говорит, чем
 * кончилось.
 */
export async function closeClarification(
  db: Executor,
  clarification: OpenClarification,
  answered: boolean,
): Promise<void> {
  await db
    .update(items)
    .set({
      draftReason: `${CLARIFY_REASON[clarification.kind]} → ${answered ? 'уточнено' : 'не уточнено'}`,
    })
    .where(eq(items.id, clarification.id));
}
