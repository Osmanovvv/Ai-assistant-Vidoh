import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { userSettings } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { AWAITING, AWAITING_TTL_MS, awaitingOf, setAwaiting } from './awaiting.js';

/**
 * Окно ожидания ответа словами (задача 3.61, вторая страховка).
 *
 * Связка целиком — нажал, переключил настройки, через час написал —
 * проверяется в `bot/handlers/edit-words.int.test.ts`. Здесь то, чего
 * через бота не разыграть: строка, поставленная **до** миграции 0044,
 * когда момент нажатия ещё не записывался.
 */

let userId: string;

beforeEach(async () => {
  userId = (await upsertUser(testDb(), { tgId: 7101, firstName: 'Аня' })).id;
});

describe('окно ожидания', () => {
  it('нажатие записывает момент, и до четверти часа ожидание живо', async () => {
    const before = Date.now();
    await setAwaiting(testDb(), userId, AWAITING.name);

    const [row] = await testDb()
      .select({ since: userSettings.awaitingSince })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));

    expect(row?.since?.getTime()).toBeGreaterThanOrEqual(before);

    const later = new Date(Date.now() + AWAITING_TTL_MS - 60_000);
    expect(await awaitingOf(testDb(), userId, later)).toEqual({
      awaiting: { kind: 'name' },
      expired: false,
    });
  });

  it('снятие ожидания уносит и момент', async () => {
    // Иначе момент пережил бы своё ожидание и лежал бы в строке как
    // факт о нажатии, которого больше нет.
    await setAwaiting(testDb(), userId, AWAITING.name);
    await setAwaiting(testDb(), userId, null);

    const [row] = await testDb()
      .select({ value: userSettings.awaitingInput, since: userSettings.awaitingSince })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));

    expect(row).toEqual({ value: null, since: null });
  });

  it('строка до миграции 0044: момент неизвестен — просрочено', async () => {
    /**
     * На боевом в минуту выкладки могут лежать ожидания без момента:
     * человек нажал «Изменить» и ушёл. Обещать ему четверть часа нечем,
     * а стороны ошибки неравны — принять запоздавшую мысль за текст дела
     * значит потерять её. Такое ожидание снимается, мысль идёт в разбор.
     */
    await setAwaiting(testDb(), userId, AWAITING.name);
    await testDb()
      .update(userSettings)
      .set({ awaitingSince: null })
      .where(eq(userSettings.userId, userId));

    expect(await awaitingOf(testDb(), userId)).toEqual({ expired: true });
  });
});
