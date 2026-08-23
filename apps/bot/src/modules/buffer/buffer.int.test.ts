import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, messagesRaw } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import {
  DEFAULT_LIMITS,
  attachMessageToBatch,
  closeBatchOnSilence,
  combineBatch,
  isOverDumpLimit,
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

    const closed = await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });

    expect(closed).toBe(true);
    expect((await currentBatch())?.status).toBe('queued');
  });

  it('не закрывает, если окно тишины ещё не вышло', async () => {
    const { batchId } = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'раз' }),
      now: at(0),
    });

    const closed = await closeBatchOnSilence(testDb(), batchId, { now: at(20_000) });

    expect(closed).toBe(false);
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

    const closed = await closeBatchOnSilence(testDb(), batchId, { now: at(30_000) });

    expect(closed).toBe(false);
    expect((await currentBatch())?.status).toBe('open');
  });

  it('повторный вызов на уже закрытой выгрузке ничего не делает', async () => {
    const { batchId } = await attachMessageToBatch(testDb(), {
      userId,
      messageId: await putMessage({ text: 'раз' }),
      now: at(0),
    });
    await closeBatchOnSilence(testDb(), batchId, { now: at(31_000) });

    await expect(closeBatchOnSilence(testDb(), batchId, { now: at(60_000) })).resolves.toBe(false);
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
});
