import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, messagesRaw, pendingQuestions, telegramUpdates } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { attachMessageToBatch } from '../buffer/buffer.service.js';
import { askQuestion } from '../resolver/questions.repo.js';
import { upsertUser } from '../users/users.repo.js';
import { sweepOnce } from './sweeper.js';

/**
 * Досмотр застрявших выгрузок.
 *
 * Проверяется то, ради чего он появился: выгрузка, о которой очередь
 * забыла, всё равно доходит до обработки — без перезапуска сервиса.
 */

const logger = createLogger({ level: 'silent' });

const T0 = new Date('2026-08-25T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

let userId: string;
let seq = 0;

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 800, firstName: 'Аня' });
  userId = user.id;
  seq = 0;
});

/** Открытая выгрузка с одним сообщением, полученным в заданный момент. */
async function openBatchAt(offsetMs: number): Promise<string> {
  seq++;
  const [row] = await testDb()
    .insert(messagesRaw)
    .values({
      userId,
      updateId: 8000 + seq,
      tgChatId: 800,
      tgMessageId: seq,
      kind: 'text',
      text: 'мысль',
      receivedAt: at(offsetMs),
    })
    .returning({ id: messagesRaw.id });

  const attached = await attachMessageToBatch(testDb(), {
    userId,
    messageId: row!.id,
    now: at(offsetMs),
  });

  return attached.batchId;
}

async function statusOf(batchId: string): Promise<string | undefined> {
  const [row] = await testDb()
    .select({ status: batches.status })
    .from(batches)
    .where(eq(batches.id, batchId));
  return row?.status;
}

describe('sweepOnce', () => {
  it('подбирает выгрузку, о которой очередь забыла', async () => {
    // Ровно тот случай, ради которого досмотр появился: после перезапуска
    // Redis воркер перестал разбирать отложенные задания, и выгрузка
    // висела бы открытой вечно.
    const batchId = await openBatchAt(0);
    const processed: string[] = [];

    const result = await sweepOnce({
      db: testDb(),
      logger,
      // Тишина уже прошла: последнее сообщение было минуту назад.
      now: () => at(60_000),
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(result.closed).toBe(1);
    expect(processed).toEqual([userId]);
    expect(await statusOf(batchId)).toBe('queued');
  });

  it('не трогает выгрузку, в которую только что писали', async () => {
    // Иначе досмотр закрывал бы мысль на полуслове.
    const batchId = await openBatchAt(0);
    const processed: string[] = [];

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => at(5_000),
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(result.users).toBe(0);
    expect(processed).toEqual([]);
    expect(await statusOf(batchId)).toBe('open');
  });

  it('возвращает в очередь выгрузку, застрявшую в обработке', async () => {
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, batchId));

    const result = await sweepOnce({
      db: testDb(),
      logger,
      // Потолок обработки три минуты; четыре — точно застряла (задача 3.58).
      now: () => at(4 * 60_000),
      process: () => Promise.resolve(),
    });

    expect(result.requeued).toBe(1);
    expect(await statusOf(batchId)).toBe('queued');
  });

  it('живую обработку не трогает', async () => {
    /**
     * Боевое 04.09.2026, 18:25:31: досмотр вернул в очередь выгрузку,
     * разбор которой шёл и закончился через четыре секунды. Замок на
     * пользователя спас от двойного ответа, но журнал врал «очередь
     * забыла».
     */
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'processing' }).where(eq(batches.id, batchId));

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => at(60_000),
      process: () => Promise.resolve(),
    });

    expect(result.requeued).toBe(0);
    expect(await statusOf(batchId)).toBe('processing');
  });

  it('на пустой базе ничего не делает и никого не будит', async () => {
    const processed: string[] = [];

    const result = await sweepOnce({
      db: testDb(),
      logger,
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    // Уборка на пустой базе тоже проходит — и говорит «убрал ноль», а не
    // молчит: `null` здесь означал бы, что она сорвалась.
    expect(result).toEqual({
      requeued: 0,
      closed: 0,
      users: 0,
      pruned: 0,
      expiredQuestions: 0,
    });
    expect(processed).toEqual([]);
  });

  it('сбой на одном пользователе не останавливает остальных', async () => {
    // Досмотр — последний рубеж. Если он падает на первом же споткнувшемся
    // пользователе, остальные так и остаются без ответа.
    const first = await upsertUser(testDb(), { tgId: 801, firstName: 'Первая' });
    const second = await upsertUser(testDb(), { tgId: 802, firstName: 'Вторая' });

    for (const [index, user] of [first, second].entries()) {
      const [row] = await testDb()
        .insert(messagesRaw)
        .values({
          userId: user.id,
          updateId: 8100 + index,
          tgChatId: 801 + index,
          tgMessageId: 900 + index,
          kind: 'text',
          text: 'мысль',
          receivedAt: at(0),
        })
        .returning({ id: messagesRaw.id });

      await attachMessageToBatch(testDb(), { userId: user.id, messageId: row!.id, now: at(0) });
    }

    const seen: string[] = [];

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => at(60_000),
      process: (id) => {
        seen.push(id);
        return seen.length === 1
          ? Promise.reject(new Error('база моргнула'))
          : Promise.resolve(undefined);
      },
    });

    expect(result.users).toBe(2);
    expect(seen).toHaveLength(2);
  });

  it('подбирает выгрузку, оставшуюся в очереди без задания', async () => {
    // Временный сбой возвращает выгрузку в очередь. Если задание при этом
    // потерялось, подобрать её больше некому — кроме досмотра.
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'queued' }).where(eq(batches.id, batchId));

    const processed: string[] = [];

    const result = await sweepOnce({
      db: testDb(),
      logger,
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(result.users).toBe(1);
    expect(processed).toEqual([userId]);
  });
});

describe('уборка за собой', () => {
  /**
   * Ревизия этапов 1–2, находка 6 и её близнец.
   *
   * `pruneUpdates` и `expireQuestions` были написаны, покрыты зелёными
   * тестами и не звались ниоткуда. Обе ждали планировщика (задача 3.14),
   * которого в продукте нет, — и обе оказались тем самым «написано,
   * покрыто тестами и недостижимо».
   *
   * Проверяется здесь не сама уборка — её проверяют тесты у себя дома, —
   * а **связка**: что уборка случается на живом повторяющемся проходе.
   */

  it('чистит журнал апдейтов старше суток, свежие не трогает', async () => {
    /**
     * Сутки набраны здесь вручную, а не взяты из `UPDATE_LOG_RETENTION_MS`:
     * возьми проверка боевую константу — и подмена срока на неделю сдвинула
     * бы вместе с ним границу самой проверки. Страж, зеленеющий от
     * диверсии, хуже отсутствующего.
     */
    const DAY_MS = 24 * 60 * 60_000;

    await testDb()
      .insert(telegramUpdates)
      .values([
        { updateId: 8_900_001, receivedAt: at(-DAY_MS - 60_000) },
        { updateId: 8_900_002, receivedAt: at(-DAY_MS + 60_000) },
      ]);

    // Ни одной выгрузки: проход тихий, и уборка обязана случиться всё
    // равно — иначе она стоит после раннего возврата.
    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => T0,
      process: () => Promise.resolve(),
    });

    const left = await testDb()
      .select({ updateId: telegramUpdates.updateId })
      .from(telegramUpdates);

    expect(
      left.map((one) => one.updateId),
      'из журнала ушло не то: сутки — это граница, а не «всё» и не «ничего»',
    ).toEqual([8_900_002]);

    expect(result.pruned).toBe(1);
  });

  it('закрывает протухший вопрос, не дожидаясь человека', async () => {
    /**
     * `openQuestionOf` закрывает такой вопрос при первом же обращении
     * человека. У ушедшего человека обращения не будет: в панели его
     * вопрос висит открытым вечно, а доля исходов «время вышло» занижена
     * ровно на таких людей.
     */
    const [batch] = await testDb()
      .insert(batches)
      .values({ userId, status: 'processing' })
      .returning({ id: batches.id });

    const [item] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Записать сына к врачу в четверг',
        type: 'TASK',
        priority: 'SOON',
        topic: 'здоровье',
      })
      .returning({ id: items.id });

    await askQuestion(testDb(), {
      userId,
      itemId: item?.id ?? '',
      batchId: batch?.id ?? '',
      segment: 'нет, в пятницу',
      action: 'update',
      changes: {
        note: '',
        text: '',
        deadline: '2026-09-04',
        deadlineAccuracy: 'day',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
      },
      // Вопрос заведён сутки назад: к T0 его шестичасовой срок давно вышел.
      now: at(-24 * 60 * 60_000),
    });

    const result = await sweepOnce({
      db: testDb(),
      logger,
      now: () => T0,
      process: () => Promise.resolve(),
    });

    const [row] = await testDb().select().from(pendingQuestions);

    expect(row?.outcome, 'протухший вопрос остался открытым').toBe('timeout');
    expect(row?.resolvedAt).not.toBeNull();
    expect(result.expiredQuestions).toBe(1);
  });

  it('сорвавшаяся уборка не оставляет человека без ответа и не молчит', async () => {
    /**
     * Уборка стоит внутри последнего рубежа. Упади она — и человек остался
     * бы без разбора вовсе, а это дороже любой таблицы.
     *
     * Наверх при этом уходит `null`, а не ноль: пустая колонка в этом
     * проекте читается как факт, и сорвавшаяся чистка, отданная нулём, была
     * бы неотличима от честного «убирать было нечего».
     */
    const batchId = await openBatchAt(0);
    await testDb().update(batches).set({ status: 'queued' }).where(eq(batches.id, batchId));

    const live = testDb();
    const broken = new Proxy(live, {
      get(target, key, receiver) {
        if (key === 'delete') {
          return () => {
            throw new Error('база отказала');
          };
        }

        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    const processed: string[] = [];

    const result = await sweepOnce({
      db: broken,
      logger,
      now: () => T0,
      process: (id) => {
        processed.push(id);
        return Promise.resolve();
      },
    });

    expect(processed, 'упавшая уборка унесла с собой весь проход').toEqual([userId]);
    expect(
      result.pruned,
      'сорвавшаяся чистка отдана нулём — её не отличить от «нечего чистить»',
    ).toBeNull();
  });
});
