import { describe, expect, it } from 'vitest';

import { testDb } from '../../test/db.js';
import { activeUserIds, findByTgId, markBlocked, upsertUser } from './users.repo.js';

describe('пометка блокировки', () => {
  it('заблокированный пользователь исключается из рассылки', async () => {
    const db = testDb();
    const active = await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    await upsertUser(db, { tgId: 200, firstName: 'Оля' });
    await markBlocked(db, 200);

    await expect(activeUserIds(db)).resolves.toEqual([active.id]);
  });

  it('разблокировка возвращает пользователя в рассылку', async () => {
    const db = testDb();
    const user = await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    await markBlocked(db, 100);
    expect(await activeUserIds(db)).toEqual([]);

    // Любое сообщение или апдейт о разблокировке снимает пометку.
    await upsertUser(db, { tgId: 100, firstName: 'Аня' });

    await expect(activeUserIds(db)).resolves.toEqual([user.id]);
  });

  it('повторная блокировка не меняет дату первой', async () => {
    const db = testDb();
    await upsertUser(db, { tgId: 100, firstName: 'Аня' });

    await markBlocked(db, 100);
    const first = (await findByTgId(db, 100))?.blockedAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await markBlocked(db, 100);
    const second = (await findByTgId(db, 100))?.blockedAt;

    expect(second?.getTime()).toBeGreaterThanOrEqual(first!.getTime());
  });

  it('пустая база даёт пустой список активных', async () => {
    await expect(activeUserIds(testDb())).resolves.toEqual([]);
  });
});
