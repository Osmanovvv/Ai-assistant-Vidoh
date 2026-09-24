import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import { batches, items, type Item } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { openItemsWhere } from '../items/items.repo.js';
import { sameTextKey } from '../items/same-text.js';
import { CLARIFY_REASON, CLARIFY_TTL_MS, hourClarifyTitle, type ClarifyKind } from './clarify.js';

/** Переспрос, который ждёт ответа: черновик невыполненной команды. */
export interface OpenClarification {
  readonly id: string;
  readonly kind: ClarifyKind;
  /** Команда человека, как он её сказал. */
  readonly command: string;
  /** Выгрузка, в которой бот переспросил: о каких делах тогда говорили. */
  readonly batchId: string | null;
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
    .select({
      id: items.id,
      text: items.text,
      reason: items.draftReason,
      batchId: items.sourceBatchId,
    })
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
    : { id: row.id, kind, command: row.text, batchId: row.batchId };
}

/**
 * Дело, о котором бот спросил «утро или вечер» (проверка Никиты
 * 24.09.2026): по названию из команды переспроса (`hourClarifyTitle`).
 * Совпало несколько открытых — то, о котором говорили в выгрузке
 * переспроса; иначе — последнее заведённое. Команда не такая — пусто:
 * её разберёт резолвер, как прежде.
 */
export async function hourClarifyTarget(
  db: Executor,
  userId: string,
  clarification: OpenClarification,
): Promise<Item | undefined> {
  const title = hourClarifyTitle(clarification.command);
  if (title === undefined) return undefined;

  const key = sameTextKey(title);
  const open = (await db.select().from(items).where(openItemsWhere(userId))).filter(
    (item) => sameTextKey(item.text) === key,
  );
  if (open.length <= 1) return open[0];

  const [talk] =
    clarification.batchId === null
      ? []
      : await db
          .select({ ids: batches.mentionedItemIds })
          .from(batches)
          .where(eq(batches.id, clarification.batchId))
          .limit(1);
  const mentioned = new Set(talk?.ids ?? []);
  const inTalk = open.filter((item) => mentioned.has(item.id));
  const pool = inTalk.length > 0 ? inTalk : open;
  return [...pool].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
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
