import { and, desc, eq, gte, ne } from 'drizzle-orm';

import { batches, items, users, userSettings } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Факты для живой строки, которых у конвейера ещё нет (22.09.2026):
 * имя, прошлая выгрузка, недавно закрытое. Открытые дела он читает сам —
 * до вставки, чтобы новое не показалось прежним.
 */
export interface ContextFacts {
  readonly name: string | undefined;
  readonly previousBatchAt: Date | undefined;
  readonly doneItems: readonly {
    readonly text: string;
    readonly deadlineAt: Date | null;
    readonly deadlineAccuracy: 'day' | 'week' | 'month' | null;
    readonly isProject: boolean;
    readonly sourceBatchId: string | null;
    readonly completedAt: Date | null;
  }[];
}

const DONE_WINDOW_DAYS = 3;
const MAX_DONE = 3;

export async function loadContextFacts(
  db: Executor,
  params: { readonly userId: string; readonly batchId: string; readonly now: Date },
): Promise<ContextFacts> {
  const [person] = await db
    .select({ preferred: userSettings.preferredName, first: users.firstName })
    .from(users)
    .leftJoin(userSettings, eq(userSettings.userId, users.id))
    .where(eq(users.id, params.userId))
    .limit(1);

  // Прошлая выгрузка — по времени открытия любой прежней, кроме этой:
  // сорвавшаяся тоже была её словами, «первая ли это выгрузка» — про них.
  const [previous] = await db
    .select({ at: batches.openedAt })
    .from(batches)
    .where(and(eq(batches.userId, params.userId), ne(batches.id, params.batchId)))
    .orderBy(desc(batches.openedAt))
    .limit(1);

  const since = new Date(params.now.getTime() - DONE_WINDOW_DAYS * 24 * 60 * 60_000);
  const done = await db
    .select({
      text: items.text,
      deadlineAt: items.deadlineAt,
      deadlineAccuracy: items.deadlineAccuracy,
      isProject: items.isProject,
      sourceBatchId: items.sourceBatchId,
      completedAt: items.completedAt,
    })
    .from(items)
    .where(
      and(eq(items.userId, params.userId), eq(items.status, 'done'), gte(items.completedAt, since)),
    )
    .orderBy(desc(items.completedAt))
    .limit(MAX_DONE);

  const name = person?.preferred ?? person?.first ?? '';

  return {
    name: name.trim() === '' ? undefined : name,
    previousBatchAt: previous?.at,
    doneItems: done,
  };
}
