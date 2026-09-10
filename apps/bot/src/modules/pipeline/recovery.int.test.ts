import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, messagesRaw } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { attachMessageToBatch, closeBatchOnSilence } from '../buffer/buffer.service.js';
import { upsertUser } from '../users/users.repo.js';
import { recoverAfterRestart, recoverStuckBatches } from './recovery.js';

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

/** Закрыта на 31-й секунде; потолок обработки три минуты — значит, застряла. */
const STUCK = 31_000 + 4 * 60_000;

describe('выгрузка, застрявшая в обработке', () => {
  it('возвращается в очередь', async () => {
    const batchId = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });
    // Имитация падения процесса посреди обработки.
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, batchId));

    const report = await recoverStuckBatches(testDb(), { now: at(STUCK) });

    expect(report.requeuedProcessing).toBe(1);
    expect(await statusOf(batchId)).toBe('queued');
  });

  it('живая обработка в очередь не возвращается', async () => {
    /**
     * Боевое 04.09.2026, 18:25:31: досмотр вернул в очередь выгрузку,
     * разбор которой шёл сорок секунд и закончился через четыре. Замок на
     * пользователя спас от двойного ответа, но журнал врал «очередь
     * забыла», а без замка человек получил бы ответ дважды.
     */
    const batchId = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, batchId));

    const report = await recoverStuckBatches(testDb(), { now: at(31_000 + 40_000) });

    expect(report.requeuedProcessing).toBe(0);
    expect(await statusOf(batchId)).toBe('processing');
  });

  it('возвращает пользователя для повторной постановки в очередь', async () => {
    const batchId = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, batchId));

    const report = await recoverStuckBatches(testDb(), { now: at(STUCK) });

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

describe('подъём процесса', () => {
  /**
   * Ревизия этапов 1–2: разбор возобновлялся через три с лишним минуты,
   * а не через секунды.
   *
   * Подъём звал общее правило досмотра, у которого потолок обработки
   * три минуты. Порог этот писался для досмотра — чтобы он не трогал
   * живой разбор, — а на подъёме бессмыслен: воркер в боевой сборке
   * один, он родился секунду назад, и всё, что висит в `processing`,
   * осталось от убитого предшественника.
   *
   * Цена была не теоретическая: человек, чью выгрузку убила выкладка,
   * всё это время видел «Слушаю.» и тишину. Сквозная проверка этапа
   * (`ops/e2e-stage1.sh`) перезапускает бота на 31-й секунде и ждёт
   * разобранного через тридцать — по арифметике она уложиться не могла.
   */

  it('возвращает в очередь разбор, убитый секунду назад', async () => {
    const batchId = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });
    await testDb()
      .update(batches)
      .set({ status: 'processing', processingAt: at(31_000) })
      .where(eq(batches.id, batchId));

    // Секунда, а не три минуты.
    const report = await recoverAfterRestart(testDb(), { now: at(32_000) });

    expect(report.requeuedProcessing, 'подъём ждал потолка досмотра').toBe(1);
    expect(await statusOf(batchId)).toBe('queued');
    expect(report.userIds).toEqual([userId]);
  });

  it('досмотр при этом свой потолок сохраняет', async () => {
    // Тот же случай общим правилом: живой разбор трогать нельзя, иначе
    // вернётся боевое 04.09.2026 — досмотр счёл идущий разбор умершим.
    const batchId = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });
    await testDb()
      .update(batches)
      .set({ status: 'processing', processingAt: at(31_000) })
      .where(eq(batches.id, batchId));

    const report = await recoverStuckBatches(testDb(), { now: at(32_000) });

    expect(report.requeuedProcessing).toBe(0);
    expect(await statusOf(batchId)).toBe('processing');
  });

  it('подбирает выгрузку, ждавшую в очереди ещё до перезапуска', async () => {
    /**
     * Статус у неё верный — потерялось задание. В отчёт правок такая не
     * попадала, и на подъёме её не подбирал никто: она лежала до первого
     * прохода досмотра, то есть ещё минуту сверху.
     */
    const batchId = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });

    const report = await recoverAfterRestart(testDb(), { now: at(32_000) });

    expect(report.awaitingUsers).toBe(1);
    expect(report.userIds).toEqual([userId]);
  });

  it('одного человека не считает дважды', async () => {
    // Возвращённый в очередь и ждущий — один и тот же человек. Без
    // вычитания он уехал бы в журнал двумя числами и получил бы два
    // задания на разбор.
    const stuck = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), stuck, { now: at(31_000) });
    await testDb()
      .update(batches)
      .set({ status: 'processing', processingAt: at(31_000) })
      .where(eq(batches.id, stuck));

    const waiting = await openBatchAt(60_000);
    await closeBatchOnSilence(testDb(), waiting, { now: at(95_000) });

    const report = await recoverAfterRestart(testDb(), { now: at(120_000) });

    expect(report.userIds).toEqual([userId]);
    expect(report.awaitingUsers, 'ждущий и возвращённый посчитаны порознь').toBe(0);
  });

  it('живой разбор, взятый секунду назад, досмотр не трогает — даже если выгрузка ждала час', async () => {
    /**
     * Порог считался от закрытия, а не от начала работы. Выгрузка,
     * пролежавшая в очереди час — так бывает, когда у нас кончился
     * доступ к модели и попытка нарочно не тратится, — выглядела
     * застрявшей в первую же миллисекунду разбора: досмотр возвращал
     * живой разбор в очередь и писал «Подобрал выгрузки, о которых
     * очередь забыла», обвиняя очередь в чужой ошибке.
     */
    const batchId = await openBatchAt(0);
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });

    // Час пролежала, взяли в работу секунду назад.
    const HOUR = 60 * 60_000;
    await testDb()
      .update(batches)
      .set({ status: 'processing', processingAt: at(HOUR) })
      .where(eq(batches.id, batchId));

    const report = await recoverStuckBatches(testDb(), { now: at(HOUR + 1_000) });

    expect(report.requeuedProcessing, 'досмотр вернул в очередь живой разбор').toBe(0);
    expect(await statusOf(batchId)).toBe('processing');
  });
});
