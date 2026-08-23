import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, messagesRaw } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { attachMessageToBatch, closeBatchOnSilence } from '../buffer/buffer.service.js';
import { upsertUser } from '../users/users.repo.js';
import { recoverStuckBatches } from './recovery.js';

const T0 = new Date('2026-08-23T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

let userId: string;
let seq = 0;

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 500, firstName: 'Аня' });
  userId = user.id;
  seq = 0;
});

async function openBatchAt(offsetMs: number): Promise<string> {
  seq++;
  const [message] = await testDb()
    .insert(messagesRaw)
    .values({
      userId,
      updateId: 7000 + seq,
      tgChatId: 500,
      tgMessageId: seq,
      kind: 'text',
      text: `сообщение ${String(seq)}`,
      receivedAt: at(offsetMs),
    })
    .returning({ id: messagesRaw.id });

  const { batchId } = await attachMessageToBatch(testDb(), {
    userId,
    messageId: message!.id,
    now: at(offsetMs),
  });
  return batchId;
}

async function statusOf(batchId: string): Promise<string | undefined> {
  const [row] = await testDb().select().from(batches).where(eq(batches.id, batchId));
  return row?.status;
}

describe('выгрузка, застрявшая в обработке', () => {
  it('возвращается в очередь', async () => {
    const batchId = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });
    // Имитация падения процесса посреди обработки.
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, batchId));

    const report = await recoverStuckBatches(testDb(), { now: at(60_000) });

    expect(report.requeuedProcessing).toBe(1);
    expect(await statusOf(batchId)).toBe('queued');
  });

  it('возвращает пользователя для повторной постановки в очередь', async () => {
    const batchId = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, batchId));

    const report = await recoverStuckBatches(testDb(), { now: at(60_000) });

    expect(report.userIds).toEqual([userId]);
  });
});

describe('открытая выгрузка с потерянным заданием', () => {
  it('закрывается, если человек давно замолчал', async () => {
    // Сценарий потери Redis: задание на закрытие исчезло вместе с очередью,
    // и без восстановления выгрузка осталась бы открытой навсегда.
    const batchId = await openBatchAt(0);

    const report = await recoverStuckBatches(testDb(), { now: at(120_000) });

    expect(report.closedOrphanedOpen).toBe(1);
    expect(await statusOf(batchId)).toBe('queued');
  });

  it('закрывается по возрасту, даже если сообщения шли непрерывно', async () => {
    const batchId = await openBatchAt(0);
    await openBatchAt(4 * 60_000);

    const report = await recoverStuckBatches(testDb(), { now: at(6 * 60_000) });

    expect(report.closedOrphanedOpen).toBe(1);
    expect(await statusOf(batchId)).toBe('queued');
  });

  it('не трогает выгрузку, в которую только что писали', async () => {
    // Человек говорит прямо сейчас, задание на закрытие в очереди живо.
    const batchId = await openBatchAt(0);

    const report = await recoverStuckBatches(testDb(), { now: at(5_000) });

    expect(report.closedOrphanedOpen).toBe(0);
    expect(await statusOf(batchId)).toBe('open');
  });
});

describe('восстановление в целом', () => {
  it('на чистой базе ничего не делает', async () => {
    await expect(recoverStuckBatches(testDb(), { now: at(0) })).resolves.toEqual({
      requeuedProcessing: 0,
      closedOrphanedOpen: 0,
      userIds: [],
    });
  });

  it('не трогает уже обработанные выгрузки', async () => {
    const batchId = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });
    await testDb().update(batches).set({ status: 'done' }).where(eq(batches.id, batchId));

    const report = await recoverStuckBatches(testDb(), { now: at(600_000) });

    expect(report.requeuedProcessing).toBe(0);
    expect(await statusOf(batchId)).toBe('done');
  });

  it('не трогает сбойные выгрузки: их перезапускают вручную из админки', async () => {
    const batchId = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });
    await testDb()
      .update(batches)
      .set({ status: 'failed', error: 'модель недоступна' })
      .where(eq(batches.id, batchId));

    await recoverStuckBatches(testDb(), { now: at(600_000) });

    expect(await statusOf(batchId)).toBe('failed');
  });

  it('не задваивает пользователя, если у него застряли обе выгрузки', async () => {
    const stuck = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), stuck, { now: at(31_000) });
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, stuck));
    await openBatchAt(120_000);

    const report = await recoverStuckBatches(testDb(), { now: at(300_000) });

    expect(report.requeuedProcessing).toBe(1);
    expect(report.closedOrphanedOpen).toBe(1);
    expect(report.userIds).toEqual([userId]);
  });
});
