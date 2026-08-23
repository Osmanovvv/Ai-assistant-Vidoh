import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, batches, messagesRaw, userSettings, users } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { attachMessageToBatch } from '../buffer/buffer.service.js';
import { recordAiCall } from '../metering/ai-calls.repo.js';
import { recordConsent, upsertUser } from '../users/users.repo.js';
import { deleteUserData, exportUserData } from './privacy.service.js';

let userId: string;
let seq = 0;

/** Пользователь с данными во всех таблицах. */
async function seedUser(tgId: number): Promise<string> {
  const user = await upsertUser(testDb(), {
    tgId,
    firstName: 'Аня',
    username: 'anya',
    referralSource: 'blog',
  });
  await recordConsent(testDb(), user.id);

  for (const text of ['купить продукты', 'записать к врачу']) {
    seq++;
    const [message] = await testDb()
      .insert(messagesRaw)
      .values({
        userId: user.id,
        updateId: 3000 + seq,
        tgChatId: tgId,
        tgMessageId: seq,
        kind: 'text',
        text,
      })
      .returning({ id: messagesRaw.id });

    await attachMessageToBatch(testDb(), { userId: user.id, messageId: message!.id });
  }

  await recordAiCall(testDb(), {
    context: { stage: 'speech', model: 'mock', userId: user.id },
    usage: { audioSeconds: 30 },
    latencyMs: 100,
    ok: true,
  });

  return user.id;
}

beforeEach(async () => {
  seq = 0;
  userId = await seedUser(500);
});

describe('exportUserData', () => {
  it('отдаёт профиль, настройки, выгрузки и сообщения', async () => {
    const data = await exportUserData(testDb(), userId);

    expect(data?.profile.tgId).toBe(500);
    expect(data?.profile.username).toBe('anya');
    expect(data?.profile.referralSource).toBe('blog');
    expect(data?.profile.consentAt).not.toBeNull();
    expect(data?.settings?.energyDefault).toBe('normal');
    expect(data?.messages).toHaveLength(2);
    expect(data?.dumps).toHaveLength(1);
  });

  it('сохраняет порядок сообщений', async () => {
    const data = await exportUserData(testDb(), userId);

    expect(data?.messages.map((m) => m.text)).toEqual(['купить продукты', 'записать к врачу']);
  });

  it('не отдаёт служебные идентификаторы', async () => {
    const data = await exportUserData(testDb(), userId);

    // Человеку нужны его тексты, а не наши первичные ключи.
    expect(JSON.stringify(data)).not.toContain(userId);
  });

  it('формат машиночитаемый: даты в ISO', async () => {
    const data = await exportUserData(testDb(), userId);

    expect(data?.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(data?.profile.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('возвращает null для неизвестного пользователя', async () => {
    await expect(
      exportUserData(testDb(), '00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeNull();
  });
});

describe('deleteUserData', () => {
  it('удаляет профиль, настройки, сообщения и выгрузки', async () => {
    const report = await deleteUserData(testDb(), userId);

    expect(report.deleted).toBe(true);
    expect(report.messages).toBe(2);
    expect(report.dumps).toBe(1);

    expect(await testDb().select().from(users)).toHaveLength(0);
    expect(await testDb().select().from(userSettings)).toHaveLength(0);
    expect(await testDb().select().from(messagesRaw)).toHaveLength(0);
    expect(await testDb().select().from(batches)).toHaveLength(0);
  });

  it('после удаления бот начинает с нуля: критерий приёмки 13', async () => {
    await deleteUserData(testDb(), userId);

    // Повторный вход создаёт чистого пользователя без прежней истории.
    const fresh = await upsertUser(testDb(), { tgId: 500, firstName: 'Аня' });

    expect(fresh.id).not.toBe(userId);
    expect(fresh.consentAt).toBeNull();
    expect(fresh.referralSource).toBeNull();
    expect(await testDb().select().from(messagesRaw)).toHaveLength(0);
  });

  it('обезличивает записи учёта расхода, но не удаляет их', async () => {
    // В них нет ни строчки пользовательского текста, а без них рассыпется
    // история себестоимости, по которой считается цена подписки.
    await deleteUserData(testDb(), userId);

    const calls = await testDb().select().from(aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userId).toBeNull();
    expect(calls[0]?.audioSeconds).toBe(30);
  });

  it('не задевает данные другого пользователя', async () => {
    const otherId = await seedUser(600);

    await deleteUserData(testDb(), userId);

    const remaining = await testDb().select().from(users);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(otherId);
    expect(await testDb().select().from(messagesRaw)).toHaveLength(2);
  });

  it('удаление неизвестного пользователя не ошибка', async () => {
    await expect(deleteUserData(testDb(), '00000000-0000-0000-0000-000000000000')).resolves.toEqual(
      { deleted: false, messages: 0, dumps: 0 },
    );
  });

  it('повторное удаление идемпотентно', async () => {
    await deleteUserData(testDb(), userId);

    await expect(deleteUserData(testDb(), userId)).resolves.toEqual({
      deleted: false,
      messages: 0,
      dumps: 0,
    });
  });
});
