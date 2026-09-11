import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, messagesRaw } from '../../db/schema.js';
import type { Transaction } from '../../infra/db.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import {
  DEFAULT_LIMITS,
  attachMessageToBatch,
  closeBatchOnSilence,
  combineBatch,
  isOverDumpLimit,
  type AttachResult,
} from './buffer.service.js';

const T0 = new Date('2026-08-23T10:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

let userId: string;
let nextTgMessageId = 1;

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 500, firstName: 'Аня' });
  userId = user.id;
  nextTgMessageId = 1;
});

/** Кладёт сырое сообщение и возвращает его идентификатор. */
async function putMessage(
  params: { text?: string; transcript?: string; receivedAt?: Date } = {},
): Promise<string> {
  const id = nextTgMessageId++;
  const [row] = await testDb()
    .insert(messagesRaw)
    .values({
      userId,
      updateId: 1000 + id,
      tgChatId: 500,
      tgMessageId: id,
      kind: params.transcript === undefined ? 'text' : 'voice',
      text: params.text ?? null,
      transcript: params.transcript ?? null,
      receivedAt: params.receivedAt ?? at(id),
    })
    .returning({ id: messagesRaw.id });

  if (!row) throw new Error('сообщение не сохранилось');
  return row.id;
}

async function currentBatch() {
  const [batch] = await testDb().select().from(batches).where(eq(batches.userId, userId));
  return batch;
}

/**
 * Ждёт, пока `expected` соединений этой базы не встанут в очередь за
 * замком. Спрашивается у самого Postgres, а не выжидается таймером:
 * тест с «подождём двести миллисекунд» зеленеет на быстрой машине и
 * краснеет на занятой, и ни то ни другое ничего не доказывает.
 *
 * `pg_stat_clear_snapshot()` перед каждым опросом обязателен: внутри
 * транзакции `pg_stat_activity` замораживается на первом обращении, и
 * без сброса опрос десять секунд видел бы одну картину — ту, что застал
 * первый заход, когда за замком ещё не все, — и валил бы тест на
 * собранной гонке (проверено: без сброса — «ждут 1 вместо 2» через 10 с).
 */
async function waitUntilBlockedOnLock(tx: Transaction, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    await tx.execute(sql`select pg_stat_clear_snapshot()`);
    const result = await tx.execute<{ waiting: number }>(sql`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `);
    const waiting = result.rows[0]?.waiting ?? 0;
    if (waiting >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `за замком ждут ${String(waiting)} соединений вместо ${String(expected)}: гонка не собралась`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Присоединяет сообщения к выгрузке **одновременно**, и обстановка гонки
 * собирается, а не ловится случайно: сторонняя транзакция держит строку
 * выгрузки под замком, все присоединяющие успевают прочитать её и
 * встают в очередь на UPDATE — и только тогда замок отпускается. Это
 * ровно то чередование, на котором прибавка счётчика терялась.
 */
async function attachConcurrently(
  batchId: string,
  messageIds: readonly string[],
  firstNow: Date,
): Promise<AttachResult[]> {
  let pending: readonly Promise<AttachResult>[] = [];
  await testDb().transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${batches} where ${batches.id} = ${batchId} for update`);
    pending = messageIds.map((messageId, i) =>
      attachMessageToBatch(testDb(), {
        userId,
        messageId,
        now: new Date(firstNow.getTime() + i * 1_000),
      }),
    );
    await waitUntilBlockedOnLock(tx, messageIds.length);
  });
  return await Promise.all(pending);
}

describe('attachMessageToBatch', () => {
  it('первое сообщение открывает выгрузку', async () => {
    const messageId = await putMessage({ text: 'купить продукты' });

    const result = await attachMessageToBatch(testDb(), { userId, messageId, now: at(0) });

    expect(result.closed).toBe(false);
    expect(result.messageCount).toBe(1);

    const batch = await currentBatch();
    expect(batch?.status).toBe('open');
  });

  it('серия сообщений попадает в одну выгрузку', async () => {
    const first = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'раз' }),
      now: at(0),
    });
    const second = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'два' }),
      now: at(10_000),
    });
    const third = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'три' }),
      now: at(20_000),
    });

    expect(second.batchId).toBe(first.batchId);
    expect(third.batchId).toBe(first.batchId);
    expect(third.messageCount).toBe(3);
    expect(await testDb().select().from(batches)).toHaveLength(1);
  });

  it('каждое сообщение сдвигает отметку последнего сообщения', async () => {
    await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'раз' }),
      now: at(0),
    });
    await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'два' }),
      now: at(25_000),
    });

    const batch = await currentBatch();
    expect(batch?.lastMessageAt.getTime()).toBe(at(25_000).getTime());
  });

  it('сообщение привязывается к выгрузке', async () => {
    const messageId = await putMessage({ text: 'раз' });

    const { batchId } = await attachMessageToBatch(testDb(), { userId, messageId, now: at(0) });

    const [message] = await testDb()
      .select()
      .from(messagesRaw)
      .where(eq(messagesRaw.id, messageId));
    expect(message?.batchId).toBe(batchId);
  });

  it('одновременная вставка двух сообщений не создаёт двух выгрузок', async () => {
    const [a, b] = await Promise.all([
      putMessage({ text: 'раз' }).then((id) =>
        attachMessageToBatch(testDb(), { userId, messageId: id, now: at(0) }),
      ),
      putMessage({ text: 'два' }).then((id) =>
        attachMessageToBatch(testDb(), { userId, messageId: id, now: at(1) }),
      ),
    ]);

    expect(a.batchId).toBe(b.batchId);
    expect(await testDb().select().from(batches)).toHaveLength(1);
  });

  /**
   * Гонка не на создании, а на **уже открытой** выгрузке. На создании
   * проигравший ждёт фиксации победителя — за него это делает уникальный
   * индекс. На открытой ждать некому: вставка на закреплённой строке
   * отдаёт ноль строк без замка, чтение идёт без замка, и два сообщения,
   * пришедшие одновременно, читали одно и то же число и писали одно и то
   * же — прибавка терялась (ревизия этапов 1–2, дефект 14).
   */
  it('одновременные сообщения в открытую выгрузку не теряют прибавку счётчика', async () => {
    const first = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'раз' }),
      now: at(0),
    });

    const later = await attachConcurrently(
      first.batchId,
      [await putMessage({ text: 'два' }), await putMessage({ text: 'три' })],
      at(1_000),
    );

    expect(later.map((r) => r.batchId)).toEqual([first.batchId, first.batchId]);
    // Три сообщения — три в счётчике, и ответы несут разные числа: второй
    // присоединившийся считал уже после первого, а не вместе с ним.
    expect((await currentBatch())?.messageCount).toBe(3);
    expect(later.map((r) => r.messageCount).sort()).toEqual([2, 3]);
  });

  describe('жёсткие потолки', () => {
    it('выгрузка закрывается на пятнадцатом сообщении', async () => {
      let last;
      for (let i = 0; i < DEFAULT_LIMITS.maxMessagesPerBatch; i++) {
        last = await attachMessageToBatch(testDb(), {
          userId,
          messageId: await putMessage({ text: `сообщение ${String(i)}` }),
          now: at(i * 1_000),
        });
      }

      expect(last?.closed).toBe(true);
      expect(last?.closeReason).toBe('message_limit');
      expect((await currentBatch())?.status).toBe('queued');
    });

    /**
     * Цена потерянной прибавки — здесь: два последних сообщения серии
     * приходят вместе, оба считают четырнадцать, и пятнадцатое не
     * закрывает выгрузку. Потолок, который иногда пропускает, — не
     * потолок.
     */
    it('потолок держит и когда последние сообщения пришли одновременно', async () => {
      const before = DEFAULT_LIMITS.maxMessagesPerBatch - 2;
      let batchId = '';
      for (let i = 0; i < before; i++) {
        ({ batchId } = await attachMessageToBatch(testDb(), {
          userId,
          messageId: await putMessage({ text: `сообщение ${String(i)}` }),
          now: at(i * 1_000),
        }));
      }

      const last = await attachConcurrently(
        batchId,
        [await putMessage({ text: 'предпоследнее' }), await putMessage({ text: 'последнее' })],
        at(before * 1_000),
      );

      expect(last.filter((r) => r.closed).map((r) => r.closeReason)).toEqual(['message_limit']);
      const batch = await currentBatch();
      expect(batch?.messageCount).toBe(DEFAULT_LIMITS.maxMessagesPerBatch);
      expect(batch?.status).toBe('queued');
    });

    it('выгрузка закрывается по возрасту, даже если человек говорит без пауз', async () => {
      await attachMessageToBatch(testDb(), {
        userId,
        messageId: await putMessage({ text: 'начало' }),
        now: at(0),
      });

      const result = await attachMessageToBatch(testDb(), {
        userId,
        messageId: await putMessage({ text: 'спустя пять минут' }),
        now: at(DEFAULT_LIMITS.maxBatchAgeMs),
      });

      expect(result.closed).toBe(true);
      expect(result.closeReason).toBe('age_limit');
    });

    it('после закрытия следующее сообщение открывает новую выгрузку', async () => {
      for (let i = 0; i < DEFAULT_LIMITS.maxMessagesPerBatch; i++) {
        await attachMessageToBatch(testDb(), {
          userId,
          messageId: await putMessage({ text: `x${String(i)}` }),
          now: at(i * 1_000),
        });
      }

      const next = await attachMessageToBatch(testDb(), {
        userId,
        messageId: await putMessage({ text: 'новая мысль' }),
        now: at(60_000),
      });

      expect(next.messageCount).toBe(1);
      expect(await testDb().select().from(batches)).toHaveLength(2);
    });
  });
});

describe('closeBatchOnSilence', () => {
  it('закрывает выгрузку, если человек замолчал', async () => {
    const { batchId } = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'раз' }),
      now: at(0),
    });

    const outcome = await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });

    expect(outcome).toEqual({ closed: true });
    expect((await currentBatch())?.status).toBe('queued');
  });

  it('не закрывает, если окно тишины ещё не вышло', async () => {
    const { batchId } = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'раз' }),
      now: at(0),
    });

    const outcome = await closeBatchOnSilence(testDb(), batchId, { now: at(20_000) });

    // Окно тридцать секунд, слово сказано в нулевую, «сейчас» — двадцатая:
    // ждать осталось ровно десять. Это число едет в задание закрытия, и
    // ждать заново целое окно после него значило бы молчать вдвое дольше.
    expect(outcome).toEqual({ closed: false, reason: 'still_talking', retryInMs: 10_000 });
    expect((await currentBatch())?.status).toBe('open');
  });

  it('опоздавшее задание не закрывает выгрузку, в которую только что дописали', async () => {
    // Задание поставлено на 30-ю секунду, но на 25-й пришло ещё сообщение.
    // Без проверки времени последнего сообщения выгрузка закрылась бы
    // посреди речи — ровно то, что §9 ТЗ запрещает.
    const { batchId } = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'раз' }),
      now: at(0),
    });
    await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'два' }),
      now: at(25_000),
    });

    const outcome = await closeBatchOnSilence(testDb(), batchId, { now: at(30_000) });

    // Последнее слово — на 25-й секунде, окно тридцать: остаток двадцать пять.
    expect(outcome).toEqual({ closed: false, reason: 'still_talking', retryInMs: 25_000 });
    expect((await currentBatch())?.status).toBe('open');
  });

  it('повторный вызов на уже закрытой выгрузке ничего не делает', async () => {
    const { batchId } = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'раз' }),
      now: at(0),
    });
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });

    // «Не открыта», а не «человек ещё говорит» — и разница не косметическая:
    // на первом задание закрытия себя переставляет, на втором обязано
    // замолчать. Иначе выгрузка, закрытая потолком, получает задание,
    // которое ставит себя заново каждое окно и не кончается никогда.
    await expect(closeBatchOnSilence(testDb(), batchId, { now: at(60_000) })).resolves.toEqual({
      closed: false,
      reason: 'not_open',
    });
  });
});

describe('combineBatch', () => {
  it('склеивает тексты в порядке получения', async () => {
    const { batchId } = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'купить продукты', receivedAt: at(1) }),
      now: at(0),
    });
    await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'записать к врачу', receivedAt: at(2) }),
      now: at(1_000),
    });

    await expect(combineBatch(testDb(), batchId)).resolves.toBe(
      'купить продукты\nзаписать к врачу',
    );
  });

  it('использует расшифровку голосового', async () => {
    const { batchId } = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ transcript: 'наговорила голосом', receivedAt: at(1) }),
      now: at(0),
    });

    await expect(combineBatch(testDb(), batchId)).resolves.toBe('наговорила голосом');
  });

  it('смешивает голос и текст в одном порядке', async () => {
    const { batchId } = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ transcript: 'первое голосом', receivedAt: at(1) }),
      now: at(0),
    });
    await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'второе текстом', receivedAt: at(2) }),
      now: at(1_000),
    });
    await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ transcript: 'третье голосом', receivedAt: at(3) }),
      now: at(2_000),
    });

    await expect(combineBatch(testDb(), batchId)).resolves.toBe(
      'первое голосом\nвторое текстом\nтретье голосом',
    );
  });

  it('пропускает сообщения без содержимого', async () => {
    const { batchId } = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'есть текст', receivedAt: at(1) }),
      now: at(0),
    });
    await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ receivedAt: at(2) }),
      now: at(1_000),
    });

    await expect(combineBatch(testDb(), batchId)).resolves.toBe('есть текст');
  });

  it('сохраняет склейку в выгрузке', async () => {
    const { batchId } = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'мысль', receivedAt: at(1) }),
      now: at(0),
    });

    await combineBatch(testDb(), batchId);

    expect((await currentBatch())?.combinedText).toBe('мысль');
  });
});

describe('isOverDumpLimit', () => {
  it('под лимитом при обычном использовании', async () => {
    await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'раз' }),
      now: at(0),
    });

    await expect(isOverDumpLimit(testDb(), userId, { now: at(0) })).resolves.toBe(false);
  });

  it('срабатывает после превышения суточной нормы', async () => {
    for (let i = 0; i < DEFAULT_LIMITS.maxDumpsPerDay; i++) {
      const messageId = await putMessage({ text: `выгрузка ${String(i)}` });
      const { batchId } = await attachMessageToBatch(testDb(), {
        userId,
        messageId,
        now: at(i * 1_000),
      });
      await closeBatchOnSilence(testDb(), batchId, { now: at(i * 1_000 + 31_000) });
    }

    await expect(isOverDumpLimit(testDb(), userId, { now: at(0) })).resolves.toBe(true);
  });

  it('не учитывает выгрузки старше суток', async () => {
    await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'вчера' }),
      now: at(0),
    });

    const tomorrow = at(25 * 60 * 60_000);
    await expect(isOverDumpLimit(testDb(), userId, { now: tomorrow })).resolves.toBe(false);
  });

  /**
   * Открытая выгрузка — не повод отказывать: сообщение продолжит её, а
   * не заведёт новую. Потолок §10.5 — про число выгрузок, а серия
   * сообщений внутри одной — §9.1 правило 2. Прежде открытая только что
   * выгрузка входила в счёт, и последняя разрешённая принимала лишь
   * первое сообщение серии.
   */
  it('последняя разрешённая выгрузка открыта — её продолжение проходит', async () => {
    const closedBefore = DEFAULT_LIMITS.maxDumpsPerDay - 1;
    for (let i = 0; i < closedBefore; i++) {
      const { batchId } = await attachMessageToBatch(testDb(), {
        userId,
        messageId: await putMessage({ text: `выгрузка ${String(i)}` }),
        now: at(i * 1_000),
      });
      await closeBatchOnSilence(testDb(), batchId, { now: at(i * 1_000 + 31_000) });
    }

    const last = closedBefore * 1_000;
    await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'первое голосовое' }),
      now: at(last),
    });

    // Выгрузок за сутки ровно потолок, одна из них открыта.
    await expect(isOverDumpLimit(testDb(), userId, { now: at(last + 5_000) })).resolves.toBe(false);
  });

  it('открытая выгрузка проходит и когда закрытых уже потолок', async () => {
    // Потолок в настройках могли опустить, пока человек говорил: его
    // начатая мысль всё равно дописывается, режется только следующая.
    for (let i = 0; i < DEFAULT_LIMITS.maxDumpsPerDay; i++) {
      const { batchId } = await attachMessageToBatch(testDb(), {
        userId,
        messageId: await putMessage({ text: `выгрузка ${String(i)}` }),
        now: at(i * 1_000),
      });
      await closeBatchOnSilence(testDb(), batchId, { now: at(i * 1_000 + 31_000) });
    }

    const last = DEFAULT_LIMITS.maxDumpsPerDay * 1_000;
    await testDb()
      .insert(batches)
      .values({ userId, openedAt: at(last), lastMessageAt: at(last) });

    await expect(isOverDumpLimit(testDb(), userId, { now: at(last + 5_000) })).resolves.toBe(false);
  });

  it('а закрылась последняя — потолок снова держит', async () => {
    // Обратная сторона послабления: оно про продолжение, не про новую.
    let batchId = '';
    for (let i = 0; i < DEFAULT_LIMITS.maxDumpsPerDay; i++) {
      ({ batchId } = await attachMessageToBatch(testDb(), {
        userId,
        messageId: await putMessage({ text: `выгрузка ${String(i)}` }),
        now: at(i * 1_000),
      }));
      if (i < DEFAULT_LIMITS.maxDumpsPerDay - 1) {
        await closeBatchOnSilence(testDb(), batchId, { now: at(i * 1_000 + 31_000) });
      }
    }

    const last = (DEFAULT_LIMITS.maxDumpsPerDay - 1) * 1_000;
    await expect(isOverDumpLimit(testDb(), userId, { now: at(last + 5_000) })).resolves.toBe(false);

    await closeBatchOnSilence(testDb(), batchId, { now: at(last + 31_000) });

    await expect(isOverDumpLimit(testDb(), userId, { now: at(last + 32_000) })).resolves.toBe(true);
  });
});
