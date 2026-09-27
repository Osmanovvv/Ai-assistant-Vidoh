import { and, desc, eq, gte, like } from 'drizzle-orm';

import { batches, items, type Item } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { openItemsWhere } from '../items/items.repo.js';
import { sameTextKey } from '../items/same-text.js';
import {
  CLARIFY_PREFIX,
  CLARIFY_REASON,
  CLARIFY_TIME_WAITING,
  CLARIFY_TTL_MS,
  hourClarifyTitle,
  type ClarifyKind,
} from './clarify.js';

/** Переспрос, который ждёт ответа: черновик невыполненной команды. */
export interface OpenClarification {
  readonly id: string;
  readonly kind: ClarifyKind;
  /** Команда человека, как он её сказал. */
  readonly command: string;
  /** Выгрузка, в которой бот переспросил: о каких делах тогда говорили. */
  readonly batchId: string | null;
  /** Вопрос о часе уже пережил чужую реплику (`keepWaiting`). */
  readonly waited?: boolean | undefined;
}

const KIND_BY_REASON = new Map<string, ClarifyKind>([
  ...(Object.entries(CLARIFY_REASON) as [ClarifyKind, string][]).map(
    ([kind, reason]) => [reason, kind] as const,
  ),
  [CLARIFY_TIME_WAITING, 'time'],
]);

/**
 * Последний переспрос за четверть часа, если он ещё без ответа.
 *
 * Именно последний, открытый или закрытый: вопрос о часе ждёт ответа и
 * через чужие реплики (`mentionsDeed`), и новый вопрос вытесняет прежний.
 * Иначе после ответа на новый «вечером» следом доделало бы старый, о
 * котором бот уже не спрашивает.
 */
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
        like(items.draftReason, `${CLARIFY_PREFIX}%`),
        gte(items.createdAt, new Date(now.getTime() - CLARIFY_TTL_MS)),
      ),
    )
    .orderBy(desc(items.createdAt))
    .limit(1);

  const kind =
    row?.reason === null || row === undefined ? undefined : KIND_BY_REASON.get(row.reason);
  return row === undefined || kind === undefined
    ? undefined
    : {
        id: row.id,
        kind,
        command: row.text,
        batchId: row.batchId,
        ...(row.reason === CLARIFY_TIME_WAITING ? { waited: true } : {}),
      };
}

/** Вопрос о часе ждёт дальше: реплика была о другом (`mentionsDeed`). */
export async function keepWaiting(db: Executor, clarification: OpenClarification): Promise<void> {
  await db
    .update(items)
    .set({ draftReason: CLARIFY_TIME_WAITING })
    .where(eq(items.id, clarification.id));
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
