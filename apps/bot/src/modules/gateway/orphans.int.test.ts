import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { messagesRaw } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { confirmConsent, upsertUser } from '../users/users.repo.js';
import { adoptOrphanedMessages, countOrphanedMessages } from './orphans.js';

/**
 * Голос без расшифровки — потерянное слово, а не «нарочно без выгрузки»
 * (бой 18.09.2026, найдено 22.09).
 *
 * SpeechKit в тот час отвечал по десять минут и дважды не ответил вовсе;
 * голосовое в 16:30 осталось без расшифровки, без выгрузки и без ответа
 * — женщина не получила ничего. В счёт сирот оно не попало: правило
 * считало «нарочными» все сообщения без текста и без расшифровки, а
 * именно так выглядит сорвавшееся распознавание.
 *
 * Теперь такие голосовые — сироты, и уборщик заводит им выгрузку: слова
 * человека возвращаются в разбор сами, без жалобы и без скриншота.
 */
const HOUR = 60 * 60_000;
const now = new Date('2026-09-22T12:00:00.000Z');
const ago = (ms: number): Date => new Date(now.getTime() - ms);

let userId = '';
let seq = 0;

async function message(
  kind: 'voice' | 'text',
  extra: {
    readonly text?: string | null;
    readonly transcript?: string | null;
    readonly receivedAt?: Date;
    readonly batchId?: string | null;
    readonly refusedReason?: 'trial' | 'dumpLimit' | null;
    readonly consumedAt?: Date | null;
  } = {},
): Promise<string> {
  seq += 1;
  const [row] = await testDb()
    .insert(messagesRaw)
    .values({
      userId,
      updateId: 900_000 + seq,
      tgChatId: 900,
      tgMessageId: 900_000 + seq,
      kind,
      text: extra.text ?? null,
      transcript: extra.transcript ?? null,
      receivedAt: extra.receivedAt ?? ago(2 * HOUR),
      ...(extra.refusedReason === undefined ? {} : { refusedReason: extra.refusedReason }),
      ...(extra.consumedAt === undefined ? {} : { consumedAt: extra.consumedAt }),
    })
    .returning({ id: messagesRaw.id });

  return row?.id ?? '';
}

beforeEach(async () => {
  seq += 1;
  const user = await upsertUser(testDb(), { tgId: 9_100_000 + seq, firstName: 'Оля' });
  userId = user.id;
  await confirmConsent(testDb(), userId, { edition: '2026-09-14', now: ago(3 * HOUR) });
});

describe('сообщения без выгрузки', () => {
  it('голос без расшифровки — сирота: распознавание сорвалось, слово потеряно', async () => {
    await message('voice');

    expect(await countOrphanedMessages(testDb(), { now })).toBe(1);
  });

  it('свежий голос не трогаем: расшифровка идёт прямо сейчас', async () => {
    await message('voice', { receivedAt: ago(5 * 60_000) });

    expect(await countOrphanedMessages(testDb(), { now })).toBe(0);
  });

  it('команда, отказ по потолку и съеденный ответ сиротами не считаются', async () => {
    await message('text', { text: '/menu' });
    await message('voice', { transcript: 'что там с банком', refusedReason: 'dumpLimit' });
    await message('text', { text: '7:30', consumedAt: ago(HOUR) });

    expect(await countOrphanedMessages(testDb(), { now })).toBe(0);
  });

  it('уборщик заводит сиротам выгрузку и называет, кого разбирать', async () => {
    const voice = await message('voice');
    const text = await message('text', { text: 'ещё купить хлеб' });

    const adopted = await adoptOrphanedMessages(testDb(), { now });

    expect(adopted.messages).toBe(2);
    expect(adopted.users).toEqual([userId]);

    const rows = await testDb()
      .select({ id: messagesRaw.id, batchId: messagesRaw.batchId })
      .from(messagesRaw)
      .where(eq(messagesRaw.userId, userId));

    expect(rows.every((row) => row.batchId !== null)).toBe(true);
    expect(rows.map((row) => row.id).sort()).toEqual([voice, text].sort());
    // Подобранное второй раз не подбирается: выгрузка у него уже есть.
    expect((await adoptOrphanedMessages(testDb(), { now })).messages).toBe(0);
  });
});

describe('связка: уборщик подбирает, а не только считает', () => {
  /**
   * Страж по исходнику: подбор написан и покрыт — но его ещё должны
   * позвать, и подобранных надо поставить в очередь, иначе выгрузка
   * заведена, а разбора нет.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const sweeper = readFileSync(resolve(here, '../pipeline/sweeper.ts'), 'utf8');

  it('уборщик зовёт подбор и ставит подобранных в работу', () => {
    expect(sweeper, 'сироты снова только считаются').toContain('adoptOrphanedMessages(');
    const call = /adoptOrphanedMessages\([\s\S]{0,600}/u.exec(sweeper)?.[0] ?? '';
    expect(call, 'подобранных никто не разбирает').toMatch(/process\(/u);
  });
});
