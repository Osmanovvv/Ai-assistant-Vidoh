import { beforeEach, describe, expect, it } from 'vitest';

import { batches, misunderstood, users } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import {
  misunderstoodCount,
  misunderstoodList,
  recordMisunderstood,
} from './misunderstood.repo.js';

/**
 * Журнал непонятого (заказчица, 16.09.2026, панель п. 3): «сколько раз
 * бот не понял пользователя за период; по клику — что написала и что
 * ответил».
 */

let anya = '';
let boris = '';

beforeEach(async () => {
  await testDb().delete(misunderstood);
  await testDb().delete(batches);
  await testDb().delete(users);

  anya = (await upsertUser(testDb(), { tgId: 9_601, firstName: 'Аня', username: 'anya' })).id;
  boris = (await upsertUser(testDb(), { tgId: 9_602, firstName: 'Борис' })).id;
});

describe('журнал непонятого', () => {
  it('записывает пару «сказала — ответил» с причиной и отдаёт её списком с именем', async () => {
    await recordMisunderstood(testDb(), {
      userId: anya,
      said: 'Покажи все мои задачи',
      replied: 'Про это у меня ничего не записано.',
      reason: 'backlog.nothing',
    });

    const rows = await misunderstoodList(testDb(), { days: 30 });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      who: 'Аня',
      said: 'Покажи все мои задачи',
      replied: 'Про это у меня ничего не записано.',
      reason: 'backlog.nothing',
    });
    expect(rows[0]?.at).toBeInstanceOf(Date);
  });

  it('считает за период и не считает старое', async () => {
    const DAY = 24 * 3_600_000;
    await recordMisunderstood(testDb(), {
      userId: anya,
      said: 'а',
      replied: 'б',
      reason: 'answer.nothingToParse',
    });
    await recordMisunderstood(testDb(), {
      userId: boris,
      said: 'в',
      replied: 'г',
      reason: 'backlog.nothing',
    });
    await testDb()
      .insert(misunderstood)
      .values({
        userId: boris,
        said: 'старое',
        replied: 'старое',
        reason: 'backlog.nothing',
        createdAt: new Date(Date.now() - 40 * DAY),
      });

    expect(await misunderstoodCount(testDb(), new Date(Date.now() - 30 * DAY))).toBe(2);
    expect(await misunderstoodCount(testDb(), new Date(Date.now() - 60 * DAY))).toBe(3);
    expect((await misunderstoodList(testDb(), { days: 30 })).map((row) => row.said)).toEqual([
      'в',
      'а',
    ]);
  });

  it('удаление человека уносит его строки; удаление выгрузки — нет', async () => {
    const [batch] = await testDb()
      .insert(batches)
      .values({ userId: anya, status: 'done', combinedText: 'что там с котом' })
      .returning({ id: batches.id });

    await recordMisunderstood(testDb(), {
      userId: anya,
      batchId: batch?.id,
      said: 'что там с котом',
      replied: 'Про это у меня ничего не записано.',
      reason: 'backlog.nothing',
    });

    await testDb().delete(batches);
    expect(await misunderstoodList(testDb(), { days: 30 })).toHaveLength(1);

    await testDb().delete(users);
    expect(await misunderstoodList(testDb(), { days: 30 })).toHaveLength(0);
  });
});
