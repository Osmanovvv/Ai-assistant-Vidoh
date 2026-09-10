import { eq } from 'drizzle-orm';
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

/**
 * «Сейчас» для задания. Своё, а не машинное: выгрузки в этой проверке
 * заводятся строкой в базу от того же значения, и обе стороны
 * неравенства «тишина выдержана» обязаны считаться от одних часов.
 */
const NOW = new Date('2026-09-10T09:00:00.000Z');

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
  const said = new Date(NOW.getTime() - agoMs);

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
      /**
       * Часы швом: остаток окна считается от них, и без шва проверка
       * закладывалась бы на то, сколько миллисекунд заняли вставка
       * выгрузки и чтение настроек.
       */
      now: () => NOW,
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

    /**
     * Задание переставлено, а не брошено: прежде выгрузку подхватывал
     * досмотр, обвиняя очередь в том, чего она не делала.
     *
     * И на **остаток** окна, а не на окно целиком (ревизия этапа 4,
     * пункт 2.2): последнее слово сказано минуту назад, окно пять минут —
     * значит ждать осталось четыре. Прежде здесь стояло 300 000, то есть
     * человеку добавляли минуту молчания на ровном месте.
     *
     * Число точное, а не диапазон: часы у задания швом (`deps.now`),
     * иначе нижняя граница была бы ставкой на скорость машины.
     */
    expect(seen.rescheduled).toEqual([{ batchId, delayMs: 240_000 }]);
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

describe('выгрузка, закрытая не этим заданием', () => {
  /**
   * **Ловушка починки: круг без конца.**
   *
   * `closeBatchOnSilence` отдавал `false` на два разных случая — «человек
   * ещё говорит» и «выгрузку закрыли без нас», — а задание переставляло
   * себя на любой `false`. Пока переставка была инертна (BullMQ молча не
   * ставил на занятый идентификатор), круг разрывал сам дефект. Почини
   * переставку, не разведя случаи, — и на каждой выгрузке, закрытой
   * потолком сообщений или возраста прямо в приёме, останется задание,
   * которое ставит себя заново каждое окно тишины и не кончается никогда.
   *
   * Случай не редкий: потолок в приёме срабатывает на каждой длинной
   * серии, а отложенное закрытие от предыдущего сообщения остаётся висеть.
   */

  it('на закрытой выгрузке задание молчит, а не переставляет себя', async () => {
    const batchId = await openBatch(1_000);

    // Закрыл кто-то другой: потолок сообщений в приёме, досмотр, соседний
    // заход. Тишина при этом заведомо не выдержана — иначе задание
    // закрыло бы выгрузку само, и ловушка бы не проверялась.
    await testDb()
      .update(batches)
      .set({ status: 'queued', closedAt: NOW })
      .where(eq(batches.id, batchId));

    const { seen, deps } = watching();

    const outcome = await runCloseBatchJob(
      { ...deps, settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }) },
      { batchId, userId },
    );

    expect(outcome.closed).toBe(false);
    expect(outcome.rescheduled, 'задание переставило себя на закрытой выгрузке').toBe(false);
    expect(seen.rescheduled).toEqual([]);

    // И разбор второй раз не ставится: его поставил тот, кто закрыл.
    expect(seen.processed).toEqual([]);
  });

  it('исчезнувшая выгрузка тоже не заводит круг', async () => {
    // Данные человека удалены по §16 между постановкой задания и заходом.
    // Строки нет вовсе — «не открыта» обязано покрыть и этот случай.
    const batchId = await openBatch(1_000);
    await testDb().delete(batches).where(eq(batches.id, batchId));

    const { seen, deps } = watching();

    const outcome = await runCloseBatchJob(
      { ...deps, settings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }) },
      { batchId, userId },
    );

    expect(outcome.rescheduled).toBe(false);
    expect(seen.rescheduled).toEqual([]);
  });
});
