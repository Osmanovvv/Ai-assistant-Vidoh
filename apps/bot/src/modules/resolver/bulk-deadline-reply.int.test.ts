import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, messagesRaw } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { handleBulkDeadlineReply } from './bulk-deadline-reply.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');
let seq = 0;

describe('голосовая групповая правка срока', () => {
  beforeEach(() => {
    seq += 1;
  });

  it('меняет только дела из процитированного списка и съедает голосовое', async () => {
    const db = testDb();
    const user = await upsertUser(db, { tgId: 40_000 + seq, firstName: 'Оля' });
    const [batch] = await db
      .insert(batches)
      .values({ userId: user.id, status: 'done', statusMessageId: 700 + seq })
      .returning();
    if (!batch) throw new Error('выгрузка не создалась');

    const [selected, other] = await db
      .insert(items)
      .values([
        {
          userId: user.id,
          sourceBatchId: batch.id,
          text: 'Позвонить Анжеле',
          type: 'TASK',
          priority: 'SOON',
          topic: 'личное',
        },
        {
          userId: user.id,
          sourceBatchId: batch.id,
          text: 'Купить шампунь',
          type: 'TASK',
          priority: 'SOON',
          topic: 'покупки',
        },
      ])
      .returning();
    if (!selected || !other) throw new Error('дела не создались');

    const [message] = await db
      .insert(messagesRaw)
      .values({
        userId: user.id,
        updateId: 80_000 + seq,
        tgChatId: 900 + seq,
        tgMessageId: 901 + seq,
        kind: 'voice',
        fileId: 'voice-file',
        audioDurationSec: 5,
        batchId: batch.id,
        replyToMessageId: batch.statusMessageId,
        replyToText: 'Личное\n— Позвонить Анжеле',
      })
      .returning();
    if (!message) throw new Error('голосовое не создалось');

    const replies: string[] = [];
    const handled = await handleBulkDeadlineReply(
      { db },
      {
        userId: user.id,
        messageId: message.id,
        text: 'Назначь этим задачам дату на 2.10',
        replyToMessageId: batch.statusMessageId ?? undefined,
        replyToText: 'Личное\n— Позвонить Анжеле',
        chatId: 900 + seq,
        timeZone: 'Europe/Moscow',
        textProfile: null,
        now: NOW,
        reply: async (text) => {
          replies.push(text);
        },
      },
    );

    expect(handled).toBe(true);
    const [afterSelected, afterOther, consumed] = await Promise.all([
      db.select().from(items).where(eq(items.id, selected.id)),
      db.select().from(items).where(eq(items.id, other.id)),
      db
        .select({ consumedAt: messagesRaw.consumedAt })
        .from(messagesRaw)
        .where(eq(messagesRaw.id, message.id)),
    ]);
    expect(afterSelected[0]?.deadlineAt?.toISOString()).toBe('2026-10-01T21:00:00.000Z');
    expect(afterOther[0]?.deadlineAt).toBeNull();
    expect(consumed[0]?.consumedAt).not.toBeNull();
    expect(replies.join('\n')).toContain('Позвонить Анжеле');
  });
});
