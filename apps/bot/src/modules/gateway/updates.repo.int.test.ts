import { describe, expect, it } from 'vitest';

import { telegramUpdates } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { claimUpdate, pruneUpdates } from './updates.repo.js';

describe('claimUpdate', () => {
  it('первый вызов забирает апдейт', async () => {
    await expect(claimUpdate(testDb(), 1)).resolves.toBe(true);
  });

  it('повторный вызов сообщает, что апдейт уже обработан', async () => {
    const db = testDb();

    await claimUpdate(db, 1);

    await expect(claimUpdate(db, 1)).resolves.toBe(false);
  });

  it('разные апдейты не мешают друг другу', async () => {
    const db = testDb();

    await expect(claimUpdate(db, 1)).resolves.toBe(true);
    await expect(claimUpdate(db, 2)).resolves.toBe(true);
  });

  it('при одновременной заявке выигрывает ровно один', async () => {
    const db = testDb();

    const results = await Promise.all([claimUpdate(db, 7), claimUpdate(db, 7), claimUpdate(db, 7)]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('pruneUpdates', () => {
  it('удаляет записи старше границы', async () => {
    const db = testDb();
    await claimUpdate(db, 1);

    const deleted = await pruneUpdates(db, new Date(Date.now() + 60_000));

    expect(deleted).toBe(1);
    expect(await db.select().from(telegramUpdates)).toHaveLength(0);
  });

  it('не трогает свежие записи', async () => {
    const db = testDb();
    await claimUpdate(db, 1);

    const deleted = await pruneUpdates(db, new Date(Date.now() - 60_000));

    expect(deleted).toBe(0);
    expect(await db.select().from(telegramUpdates)).toHaveLength(1);
  });
});
