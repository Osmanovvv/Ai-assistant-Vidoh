import { and, eq, inArray } from 'drizzle-orm';

import { batches, items } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { markConsumed } from '../gateway/orphans.js';
import { resolveDeadline, localDateParts, startOfDayAfter } from '../classifier/dates.js';
import { itemsForBatch, OPEN_STATUSES } from '../items/items.repo.js';
import { titleWithoutDate } from './title-date.js';
import { applyBulkDeadline } from './bulk-deadline.js';
import { refreshSummaries } from '../topics/summary.service.js';
import type { TopicGateway } from '../topics/gateway.js';
import { textsFor } from '../../texts/index.js';

export type BulkDeadlineRequest =
  { readonly kind: 'valid'; readonly deadlineAt: Date } | { readonly kind: 'invalid' } | undefined;

/**
 * Узнаёт только однозначную команду групповой правки.
 *
 * Это намеренно закрытый разбор: без явной ссылки на «эти задачи» и без
 * конкретной даты сообщение остаётся обычной мыслью.
 */
export function bulkDeadlineRequest(
  text: string | undefined,
  context: { readonly now: Date; readonly timeZone: string },
): BulkDeadlineRequest {
  if (text === undefined) return undefined;
  const normalized = text.trim().toLowerCase().replace(/ё/gu, 'е');
  if (
    !/^(?:назначь|назначить|поставь|поставить|обозначь|обозначить|перенеси|перенести|измени|изменить)(?!\p{L})/u.test(
      normalized,
    ) ||
    !/(?:(?<!\p{L})эт(?:им|ими)\s+(?:задачам|делам|записям)(?!\p{L})|(?<!\p{L})эти\s+(?:задачи|дела|записи)(?!\p{L})|(?<!\p{L})для\s+этих\s+(?:задач|дел|записей)(?!\p{L})|(?<!\p{L})к\s+этим\s+(?:задачам|делам|записям)(?!\p{L}))/u.test(
      normalized,
    )
  ) {
    return undefined;
  }

  const match = /(?<!\d)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)/u.exec(normalized);
  if (match === null) {
    const relative = /(?<!\p{L})(сегодня|завтра|послезавтра)(?!\p{L})/u.exec(normalized)?.[1];
    if (relative === undefined) return { kind: 'invalid' };

    const days = relative === 'сегодня' ? 0 : relative === 'завтра' ? 1 : 2;
    return { kind: 'valid', deadlineAt: startOfDayAfter(context.now, days, context.timeZone) };
  }

  const today = localDateParts(context.now, context.timeZone);
  const rawYear = match[3];
  const year =
    rawYear === undefined
      ? today.year
      : rawYear.length === 2
        ? 2000 + Number(rawYear)
        : Number(rawYear);
  const day = Number(match[1]);
  const month = Number(match[2]);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const resolved = resolveDeadline(
    { deadline: `${String(year)}-${pad(month)}-${pad(day)}`, accuracy: 'day' },
    context,
  );

  return resolved.ok && resolved.deadline !== undefined
    ? { kind: 'valid', deadlineAt: resolved.deadline.at }
    : { kind: 'invalid' };
}

function shortDayAndMonth(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
  }).format(at);
}

export interface BulkDeadlineReplyDeps {
  readonly db: Database;
  readonly topics?: TopicGateway | undefined;
}

export interface BulkDeadlineReplyParams {
  readonly userId: string;
  readonly messageId: string;
  readonly text: string | undefined;
  readonly replyToMessageId: number | undefined;
  readonly replyToText: string | undefined;
  readonly chatId: number | undefined;
  readonly timeZone: string;
  readonly textProfile: string | null;
  readonly now?: Date | undefined;
  readonly reply: (text: string) => Promise<unknown>;
}

/**
 * Применяет команду к задачам ровно из процитированного статусного списка.
 * Возвращает `true`, если сообщение распознано как такая команда и потому
 * не должно становиться новой задачей.
 */
export async function handleBulkDeadlineReply(
  deps: BulkDeadlineReplyDeps,
  params: BulkDeadlineReplyParams,
): Promise<boolean> {
  const now = params.now ?? new Date();
  const request = bulkDeadlineRequest(params.text, { now, timeZone: params.timeZone });
  if (request === undefined) return false;

  const texts = textsFor(params.textProfile);
  if (params.replyToMessageId === undefined) {
    await params.reply(texts.resolver.whichRecord);
    await markConsumed(deps.db, params.messageId);
    return true;
  }

  const [batch] = await deps.db
    .select({ id: batches.id, mentionedItemIds: batches.mentionedItemIds })
    .from(batches)
    .where(
      and(eq(batches.userId, params.userId), eq(batches.statusMessageId, params.replyToMessageId)),
    )
    .limit(1);

  if (request.kind === 'invalid' || batch === undefined) {
    await params.reply(texts.resolver.whichRecord);
    await markConsumed(deps.db, params.messageId);
    return true;
  }

  const fromBatch = (await itemsForBatch(deps.db, batch.id)).filter(
    (item) =>
      !item.isDraft &&
      item.type !== 'EMOTION' &&
      OPEN_STATUSES.includes(item.status as (typeof OPEN_STATUSES)[number]),
  );
  const mentionedItems =
    batch.mentionedItemIds === null || batch.mentionedItemIds.length === 0
      ? []
      : (
          await deps.db
            .select()
            .from(items)
            .where(
              and(
                eq(items.userId, params.userId),
                inArray(items.id, batch.mentionedItemIds),
                inArray(items.status, [...OPEN_STATUSES]),
                eq(items.isDraft, false),
              ),
            )
        ).filter((item) => item.type !== 'EMOTION');
  const candidates = [
    ...new Map([...fromBatch, ...mentionedItems].map((item) => [item.id, item])).values(),
  ];
  const quotedLines = (params.replyToText ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^—\s+/u.test(line));
  const shownInReply = candidates.filter((item) =>
    quotedLines.some((line) => {
      const visible = line.replace(/^—\s+/u, '').trim();
      const title = titleWithoutDate(item.text);
      return (
        visible === item.text ||
        visible === title ||
        visible.startsWith(`${item.text} ·`) ||
        visible.startsWith(`${title} ·`)
      );
    }),
  );
  const ids =
    quotedLines.length > 0
      ? shownInReply.map((item) => item.id)
      : candidates.map((item) => item.id);

  if (ids.length === 0) {
    await params.reply(texts.resolver.whichRecord);
    await markConsumed(deps.db, params.messageId);
    return true;
  }

  const applied = await applyBulkDeadline(deps.db, {
    userId: params.userId,
    itemIds: ids,
    deadlineAt: request.deadlineAt,
    sourceMessageId: params.messageId,
    now,
  });

  if (applied.kind === 'missing') {
    await params.reply(texts.resolver.whichRecord);
    await markConsumed(deps.db, params.messageId);
    return true;
  }

  const date = shortDayAndMonth(request.deadlineAt, params.timeZone);
  const changedLines = applied.changed.map((item) => texts.resolver.movedDeadline(item.text, date));
  const confirmation =
    changedLines.length === 0
      ? texts.resolver.unchanged
      : changedLines.join('\n') +
        (applied.unchanged.length === 0 ? '' : `\n\n${texts.resolver.unchanged}`);
  await params.reply(confirmation);

  if (deps.topics !== undefined && params.chatId !== undefined && applied.changed.length > 0) {
    const topicNames = [
      ...new Set(applied.changed.flatMap((item) => (item.topic ? [item.topic] : []))),
    ];
    try {
      await refreshSummaries(
        { db: deps.db, gateway: deps.topics },
        {
          userId: params.userId,
          chatId: params.chatId,
          topicNames,
          timeZone: params.timeZone,
          profile: params.textProfile,
        },
      );
    } catch {
      // Срок уже сохранён; сводка обновится при следующей правке.
    }
  }

  await markConsumed(deps.db, params.messageId);
  return true;
}
