import { beforeEach, describe, expect, it } from 'vitest';

import { appSettings, batches, messagesRaw, users } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { putSetting, SettingsRegistry } from '../settings/settings.repo.js';
import { upsertUser } from '../users/users.repo.js';
import { runCloseBatchJob } from './close-job.js';

/**
 * Окно ожидания тишины из панели действует **на закрытие выгрузки**
 * (§9.1, §15; условие готовности задачи 4.9; ревизия четвёртого этапа).
 *
 * Прежде окно правилось в панели и уходило только в **задержку задания**,
 * а само закрытие сверялось с константой из кода. Одно и то же число
 * двумя способами, и расходились они в обе стороны:
 *  - окно меньше тридцати секунд не применялось вовсе: задание
 *    срабатывало, а выгрузка не закрывалась;
 *  - окно больше доезжало только досмотром, с опозданием до минуты, и в
 *    журнал шла строка «подобрал выгрузки, о которых очередь забыла» —
 *    обвинение очереди в чужой ошибке.
 *
 * Единственная прежняя проверка условия готовности сверяла только
 * задержку задания и покраснеть от этого не могла.
 */

let userId = '';

beforeEach(async () => {
  await testDb().delete(appSettings);
  await testDb().delete(messagesRaw);
  await testDb().delete(batches);
  await testDb().delete(users);

  userId = (await upsertUser(testDb(), { tgId: 5_101, firstName: 'Аня' })).id;
});

/**
 * Открытая выгрузка, чьё последнее сообщение сказано `agoMs` назад.
 *
 * Строкой прямо в базу, а не через приём сообщений: приём ставит
 * `lastMessageAt` из «сейчас», и выдержанную тишину им не изобразить, не
 * ожидая её по-настоящему.
 */
async function openBatch(agoMs: number): Promise<string> {
  const said = new Date(Date.now() - agoMs);

  const [row] = await testDb()
    .insert(batches)
    .values({
      userId,
      status: 'open',
      openedAt: said,
      lastMessageAt: said,
      messageCount: 1,
    })
    .returning({ id: batches.id });

  if (row === undefined) throw new Error('выгрузка не создалась');

  return row.id;
}

interface Seen {
  readonly rescheduled: { readonly batchId: string; readonly delayMs: number }[];
  readonly processed: string[];
}

function watching(): {
  readonly seen: Seen;
  readonly deps: Omit<Parameters<typeof runCloseBatchJob>[0], 'settings'>;
} {
  const seen: Seen = { rescheduled: [], processed: [] };

  return {
    seen,
    deps: {
      db: testDb(),
      reschedule: async (again) => {
        seen.rescheduled.push({ batchId: again.batchId, delayMs: again.delayMs });
        await Promise.resolve();
      },
      process: async (who) => {
        seen.processed.push(who);
        await Promise.resolve();
      },
    },
  };
}

describe('окно из панели решает, закрывать ли выгрузку', () => {
  it('окно 5 секунд закрывает выгрузку, которой шесть — прежде не закрывало', async () => {
    /**
     * **Ровно тот случай, который не работал.** Константа в коде — тридцать
     * секунд; при окне пять задание срабатывало через пять, а закрытие
     * говорило «тишина ещё не выдержана». Выгрузка висела до досмотра.
     */
    await putSetting(testDb(), { name: 'silenceWindowMs', value: '5000' });

    const batchId = await openBatch(6_000);
    const { seen, deps } = watching();

    const outcome = await runCloseBatchJob(
      { ...deps, settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }) },
      { batchId, userId },
    );

    expect(outcome.silenceWindowMs).toBe(5_000);
    expect(outcome.closed).toBe(true);
    expect(seen.processed).toEqual([userId]);
    expect(seen.rescheduled).toEqual([]);
  });

  it('окно 5 минут не закрывает выгрузку, которой минута — и ставит задание заново', async () => {
    /**
     * Обратная сторона того же: при удлинённом окне закрытие сверялось с
     * тридцатью секундами и закрывало раньше времени, обрывая человека
     * на середине мысли.
     */
    await putSetting(testDb(), { name: 'silenceWindowMs', value: '300000' });

    const batchId = await openBatch(60_000);
    const { seen, deps } = watching();

    const outcome = await runCloseBatchJob(
      { ...deps, settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }) },
      { batchId, userId },
    );

    expect(outcome.closed).toBe(false);
    expect(seen.processed).toEqual([]);

    // Задание переставлено, а не брошено: прежде выгрузку подхватывал
    // досмотр, обвиняя очередь в том, чего она не делала.
    expect(seen.rescheduled).toEqual([{ batchId, delayMs: 300_000 }]);
  });

  it('без реестра работает умолчание из кода', async () => {
    // Законное состояние: так собраны стенды и часть проверок.
    const batchId = await openBatch(40_000);
    const { seen, deps } = watching();

    const outcome = await runCloseBatchJob(deps, { batchId, userId });

    expect(outcome.silenceWindowMs).toBe(30_000);
    expect(outcome.closed).toBe(true);
    expect(seen.processed).toEqual([userId]);
  });

  it('мусор в настройке не ломает закрытие: берётся умолчание', async () => {
    await putSetting(testDb(), { name: 'silenceWindowMs', value: 'вечность' });

    const batchId = await openBatch(40_000);
    const { seen, deps } = watching();

    const outcome = await runCloseBatchJob(
      { ...deps, settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }) },
      { batchId, userId },
    );

    expect(outcome.silenceWindowMs).toBe(30_000);
    expect(seen.processed).toEqual([userId]);
  });
});
