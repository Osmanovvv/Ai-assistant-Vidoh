import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, messagesRaw, users } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import { testDb } from '../../test/db.js';
import { FakeTopicGateway } from '../topics/fake-gateway.js';
import { ensureThread } from '../topics/topics.service.js';
import { topics } from '../../db/schema.js';
import { upsertUser } from '../users/users.repo.js';
import { defaultTexts } from '../../texts/index.js';
import { retireInactive } from './inactivity.service.js';

/**
 * Удаление после 24 месяцев тишины (решение заказчицы 12.09.2026, ответ
 * 15; Политика п. 11.2, Согласие п. 4.4): предупредить сообщением, и если
 * за 30 дней человек не обратился — удалить тем же путём, что
 * /delete_my_data.
 */

const logger = createLogger({ level: 'silent' });
const NOW = new Date('2028-10-01T09:00:00.000Z');
const DAY = 24 * 60 * 60_000;

let outbox: { chatId: number; text: string }[] = [];
let sendFails = false;

const sender: QuestionSender = {
  ask: ({ chatId, text }) => {
    if (sendFails) return Promise.resolve(0);
    outbox.push({ chatId, text });
    return Promise.resolve(1);
  },
};

let seq = 0;

/** Человек с последней активностью столько-то месяцев назад. */
async function person(
  monthsSilent: number,
  tgId = 7000 + seq,
): Promise<{ id: string; tgId: number }> {
  seq += 1;
  const user = await upsertUser(testDb(), { tgId, firstName: 'Аня' });
  const lastActive = new Date(NOW);
  lastActive.setUTCMonth(lastActive.getUTCMonth() - monthsSilent);

  await testDb().update(users).set({ lastActiveAt: lastActive }).where(eq(users.id, user.id));
  await testDb()
    .insert(messagesRaw)
    .values({
      userId: user.id,
      updateId: 9_500_000 + seq,
      tgChatId: tgId,
      tgMessageId: seq,
      kind: 'text',
      text: 'давняя мысль',
      receivedAt: lastActive,
    });
  await testDb()
    .insert(items)
    .values({ userId: user.id, text: 'Давнее дело', type: 'TASK', priority: 'SOON', topic: 'быт' });

  return { id: user.id, tgId };
}

async function warnedAtOf(userId: string): Promise<Date | null | undefined> {
  const [row] = await testDb().select().from(users).where(eq(users.id, userId));
  return row === undefined ? undefined : row.inactivityWarnedAt;
}

function deps(gateway = new FakeTopicGateway()) {
  return { db: testDb(), logger, sender, topics: gateway, providers: {} };
}

beforeEach(() => {
  outbox = [];
  sendFails = false;
});

describe('предупреждение', () => {
  it('после 24 месяцев тишины — одно сообщение, отметка о нём, ничего не удалено', async () => {
    const { id, tgId } = await person(25);

    const result = await retireInactive(deps(), { now: NOW });

    expect(result).toMatchObject({ warned: 1, deleted: 0 });
    expect(outbox).toEqual([{ chatId: tgId, text: defaultTexts.privacy.inactivityWarning }]);
    expect(await warnedAtOf(id)).toEqual(NOW);
    expect(await testDb().select().from(items).where(eq(items.userId, id))).toHaveLength(1);
  });

  it('23 месяца — рано', async () => {
    const { id } = await person(23);

    const result = await retireInactive(deps(), { now: NOW });

    expect(result).toMatchObject({ warned: 0, deleted: 0 });
    expect(outbox).toEqual([]);
    expect(await warnedAtOf(id)).toBeNull();
  });

  it('второй раз не предупреждает: отметка уже стоит', async () => {
    await person(25);
    await retireInactive(deps(), { now: NOW });

    const again = await retireInactive(deps(), { now: new Date(NOW.getTime() + DAY) });

    expect(again.warned).toBe(0);
    expect(outbox).toHaveLength(1);
  });

  it('сообщение не ушло — отметка всё равно стоит, отказ в журнале, не в тишине', async () => {
    /**
     * Заблокировавшему бота предупреждение не доставить — но срок от этого
     * не останавливается: иначе данные заблокировавших хранились бы вечно,
     * а политика обещает обратное. Порядок для них — у юриста (пометка в
     * Политике), код делает то, что написано: попытка и отметка.
     */
    sendFails = true;
    const { id } = await person(25);

    const result = await retireInactive(deps(), { now: NOW });

    expect(result.warned).toBe(1);
    expect(await warnedAtOf(id)).toEqual(NOW);
  });
});

describe('удаление', () => {
  it('через 30 дней после предупреждения без ответа — удалено тем же путём, что /delete_my_data', async () => {
    const gateway = new FakeTopicGateway();
    const { id, tgId } = await person(25);
    await testDb()
      .insert(topics)
      .values([{ userId: id, name: 'быт', sortOrder: 0, isDefault: true }]);
    const [topic] = await testDb().select().from(topics).where(eq(topics.userId, id));
    await ensureThread({ db: testDb(), gateway }, { topicId: topic!.id, chatId: tgId });
    await retireInactive(deps(gateway), { now: NOW });

    const result = await retireInactive(deps(gateway), { now: new Date(NOW.getTime() + 31 * DAY) });

    expect(result).toMatchObject({ warned: 0, deleted: 1 });
    expect(await testDb().select().from(users).where(eq(users.id, id))).toHaveLength(0);
    expect(await testDb().select().from(items).where(eq(items.userId, id))).toHaveLength(0);
    // И ветки в чате сняты — как при удалении по команде.
    expect(gateway.deletedThreads.map((one) => one.chatId)).toEqual([tgId]);
  });

  it('30 дней ещё не прошли — ждём', async () => {
    const { id } = await person(25);
    await retireInactive(deps(), { now: NOW });

    const result = await retireInactive(deps(), { now: new Date(NOW.getTime() + 20 * DAY) });

    expect(result.deleted).toBe(0);
    expect(await testDb().select().from(users).where(eq(users.id, id))).toHaveLength(1);
  });

  it('обратилась после предупреждения — не удаляется, отметка снимается', async () => {
    const { id, tgId } = await person(25);
    await retireInactive(deps(), { now: NOW });
    // Через десять дней написала.
    const spoke = new Date(NOW.getTime() + 10 * DAY);
    await testDb().update(users).set({ lastActiveAt: spoke }).where(eq(users.id, id));
    await testDb().insert(messagesRaw).values({
      userId: id,
      updateId: 9_600_000,
      tgChatId: tgId,
      tgMessageId: 777,
      kind: 'text',
      text: 'я тут',
      receivedAt: spoke,
    });

    const result = await retireInactive(deps(), { now: new Date(NOW.getTime() + 31 * DAY) });

    expect(result).toMatchObject({ deleted: 0, spared: 1 });
    expect(await testDb().select().from(users).where(eq(users.id, id))).toHaveLength(1);
    // Отсчёт начнётся заново с новых 24 месяцев.
    expect(await warnedAtOf(id)).toBeNull();
  });
});
