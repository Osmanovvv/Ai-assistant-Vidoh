import { describe, expect, it } from 'vitest';

import { testDb } from '../../test/db.js';
import { recipientsOf } from '../broadcast/broadcast.repo.js';
import { findByTgId, markBlocked, upsertUser } from './users.repo.js';

/**
 * Пометка блокировки: кому писать нельзя (§15 ТЗ).
 *
 * **Спрашиваем ту функцию, которой пользуется бой** (ревизия панели).
 * Прежде здесь звалась `activeUserIds` — экспорт, у которого не было ни
 * одного вызывающего, кроме этой проверки. Она была зелёной, а
 * проверяла запрос, который никто не выполняет: рассылка набирает
 * адресатов `recipientsOf`, планировщик — своим запросом. Про сегменты
 * `activeUserIds` уже не знала, и «правило кому можно писать» жило в
 * двух местах, из которых одно устаревало молча.
 */

/** Кому уйдёт рассылка «всем» — тем же вызовом, каким её составляют. */
async function canWrite(): Promise<readonly string[]> {
  const people = await recipientsOf(testDb(), { segment: 'all', trialLimit: 10 });

  return people.map((one) => one.userId);
}

describe('пометка блокировки', () => {
  it('заблокированный пользователь исключается из рассылки', async () => {
    const db = testDb();
    const active = await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    await upsertUser(db, { tgId: 200, firstName: 'Оля' });
    await markBlocked(db, 200);

    await expect(canWrite()).resolves.toEqual([active.id]);
  });

  it('разблокировка возвращает пользователя в рассылку', async () => {
    const db = testDb();
    const user = await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    await markBlocked(db, 100);
    expect(await canWrite()).toEqual([]);

    // Любое сообщение или апдейт о разблокировке снимает пометку.
    await upsertUser(db, { tgId: 100, firstName: 'Аня' });

    await expect(canWrite()).resolves.toEqual([user.id]);
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
    await expect(canWrite()).resolves.toEqual([]);
  });
});
