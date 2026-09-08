import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  batches,
  billingEvents,
  billingInvoices,
  billingSubscriptions,
  users,
} from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { createInvoice, markInvoicePaid, nextInvId } from '../billing/billing.repo.js';
import { markTrialSpent } from '../billing/subscription.service.js';
import { upsertUser } from '../users/users.repo.js';
import { funnelOf } from './funnel.js';

/**
 * Воронка и разрез по источникам (§15, §14 и §19, задача 4.4).
 *
 * Условие готовности задачи: «в админке виден срез по источникам и
 * воронка „регистрация, первая выгрузка, конец пробного, оплата“».
 *
 * **Главное здесь — что ни одно число не выдумано.** Третий шаг считается
 * по записанному моменту, а не пересчётом по нынешнему пределу: предел
 * правится из панели, и пересчёт сдвигал бы прошлые недели задним числом.
 * Отчёт о запуске у блогера менялся бы от настройки, сделанной через
 * месяц, и заметить это было бы нечем.
 *
 * И второе: **ноль обязан отличаться от «данных нет»**. Моменты ведутся с
 * выкладки задачи; ноль без объяснения читается как «никто не дошёл».
 */

let anya = '';
let boris = '';

/** Разобранная выгрузка. Отметку о трате ставит `markTrialSpent`. */
async function dump(params: { readonly userId: string; readonly done?: boolean }): Promise<string> {
  const [row] = await testDb()
    .insert(batches)
    .values({ userId: params.userId, status: params.done === false ? 'failed' : 'done' })
    .returning({ id: batches.id });

  return row?.id ?? '';
}

async function paid(userId: string, ref: string): Promise<void> {
  const invoice = await createInvoice(testDb(), {
    provider: 'robokassa:smz',
    userId,
    plan: 'monthly',
    kind: 'initial',
    amountMinor: 39_900,
    currency: 'RUB',
    ref,
    invId: await nextInvId(testDb()),
  });

  await markInvoicePaid(testDb(), { id: invoice.id, now: new Date() });
}

beforeEach(async () => {
  await testDb().delete(billingEvents);
  await testDb().delete(billingSubscriptions);
  await testDb().delete(billingInvoices);
  await testDb().delete(batches);
  await testDb().delete(users);

  anya = (await upsertUser(testDb(), { tgId: 4_600_001, firstName: 'Аня' })).id;
  boris = (await upsertUser(testDb(), { tgId: 4_600_002, firstName: 'Борис' })).id;
});

describe('четыре шага', () => {
  it('пустая база даёт нули и говорит, что записей нет', async () => {
    await testDb().delete(users);

    const funnel = await funnelOf(testDb());

    expect(funnel.total.registered).toBe(0);
    expect(funnel.momentsSince).toBeNull();
    expect(funnel.missing.some((note) => note.includes('задним числом не досыпаются'))).toBe(true);
  });

  it('регистрация считается по людям, а не по выгрузкам', async () => {
    const funnel = await funnelOf(testDb());

    expect(funnel.total.registered).toBe(2);
    expect(funnel.total.firstDump).toBe(0);
  });

  it('первая выгрузка — это разобранная, а не любая', async () => {
    /**
     * Определение то же, каким обзор считает разобранные выгрузки:
     * `status = 'done'`. Третье определение одного и того же вопроса
     * было бы четвёртым способом на него ответить.
     */
    await dump({ userId: anya });
    await dump({ userId: boris, done: false });

    const funnel = await funnelOf(testDb());

    expect(funnel.total.firstDump).toBe(1);
  });

  it('конец пробного — записанный момент, а не пересчёт', async () => {
    /**
     * **Ключевая проверка задачи.** Предел правится из панели без
     * выкладки; посчитай мы третий шаг из нынешнего предела — и правка
     * сдвигала бы прошлые недели у всех сразу.
     *
     * Здесь предел два, и он записан в момент. Смена настройки после
     * этого ничего не меняет, потому что настройка тут вообще не
     * спрашивается.
     */
    await markTrialSpent(testDb(), { batchId: await dump({ userId: anya }), trialLimit: 2 });
    await markTrialSpent(testDb(), { batchId: await dump({ userId: anya }), trialLimit: 2 });

    const funnel = await funnelOf(testDb());

    expect(funnel.total.trialOver).toBe(1);
    expect(funnel.trialLimits).toEqual([2]);
    expect(funnel.momentsSince).not.toBeNull();
  });

  it('момент ставится один на человека, сколько бы выгрузок ни было дальше', async () => {
    /**
     * За это отвечает уникальный индекс, а не порядок вызовов: иначе
     * третий шаг посчитал бы одного человека дважды, и воронка стала бы
     * немонотонной по построению.
     */
    for (let index = 0; index < 5; index += 1) {
      await markTrialSpent(testDb(), { batchId: await dump({ userId: anya }), trialLimit: 2 });
    }

    const moments = await testDb()
      .select()
      .from(batches)
      .where(eq(batches.userId, anya))
      .then((rows) => rows.filter((row) => row.trialOverAt !== null));

    expect(moments).toHaveLength(1);
    expect((await funnelOf(testDb())).total.trialOver).toBe(1);
  });

  it('оплата считается состоянием счёта, а не датой', async () => {
    /**
     * У платящего звёздами продление живёт своей строкой, а `paid_at`
     * первой перезаписался бы, будь это иначе. Состояние «есть
     * оплаченный счёт» не зависит ни от одной даты.
     */
    await markTrialSpent(testDb(), { batchId: await dump({ userId: anya }), trialLimit: 1 });
    await paid(anya, 'анин');

    const funnel = await funnelOf(testDb());

    expect(funnel.total.paidAfterTrial).toBe(1);
    expect(funnel.total.paidWithoutTrialOver).toBe(0);
  });

  it('заплативший до конца пробного стоит ОТДЕЛЬНЫМ числом', async () => {
    /**
     * Платящему отметка о трате не ставится вовсе, поэтому до границы он
     * не доходит. Считать его «перешедшим из пробного в оплату» значило
     * бы отвечать на другой вопрос: перехода у него не было.
     */
    await dump({ userId: boris });
    await paid(boris, 'борисов');

    const funnel = await funnelOf(testDb());

    expect(funnel.total.trialOver).toBe(0);
    expect(funnel.total.paidAfterTrial).toBe(0);
    expect(funnel.total.paidWithoutTrialOver).toBe(1);
    expect(funnel.missing.some((note) => note.includes('не дойдя до границы'))).toBe(true);
  });

  it('идущий пробный период — тоже отдельное число', async () => {
    // Он не «не купил», он не дошёл до вопроса.
    await markTrialSpent(testDb(), { batchId: await dump({ userId: anya }), trialLimit: 10 });

    // Предел передаётся: «ещё выбирает» считается тем же правилом, по
    // которому пускает гейт (ревизия четвёртого этапа).
    const funnel = await funnelOf(testDb(), { trialLimit: 10 });

    expect(funnel.total.trialOver).toBe(0);
    expect(funnel.total.trialStillRunning).toBe(1);
    expect(funnel.total.trialOverUnrecorded).toBe(0);
    expect(funnel.missing.some((note) => note.includes('пробный период ещё идёт'))).toBe(true);
  });

  it('снижение предела переводит человека из «ещё выбирает» в «отказ без момента»', async () => {
    /**
     * **Ровно та неправда, которую нашла ревизия.** Момент конца пробного
     * пишется с выкладки 4.4 и задним числом не досыпается, а предел
     * правится из панели: снизь его с десяти до пяти, и человек с семью
     * тратами мгновенно оказывается за границей — бот ему отказывает.
     * Прежде он оставался в колонке «ещё выбирает», и заказчица читала
     * «человек думает» там, где человек упёрся в отказ.
     */
    for (let spent = 0; spent < 7; spent++) {
      await markTrialSpent(testDb(), { batchId: await dump({ userId: anya }) });
    }

    const before = await funnelOf(testDb(), { trialLimit: 10 });

    expect(before.total.trialStillRunning).toBe(1);
    expect(before.total.trialOverUnrecorded).toBe(0);

    const after = await funnelOf(testDb(), { trialLimit: 5 });

    expect(after.total.trialStillRunning).toBe(0);
    expect(after.total.trialOverUnrecorded).toBe(1);
  });

  it('без предела колонка не считается — и об этом сказано словами', async () => {
    // Пустая колонка читается как факт: «никто не выбирает» вместо «не
    // считали». Поэтому вместо нуля — строка.
    await markTrialSpent(testDb(), { batchId: await dump({ userId: anya }), trialLimit: 10 });

    const funnel = await funnelOf(testDb());

    expect(funnel.total.trialStillRunning).toBe(0);
    expect(funnel.missing.some((note) => note.includes('не посчитана'))).toBe(true);
  });

  it('ряд убывает: оплата ⊆ конец пробного ⊆ первая выгрузка ⊆ регистрация', async () => {
    /**
     * Монотонность получается устройством, а не проверкой после: момент
     * ставится только выгрузке с отметкой, отметка — только удавшемуся
     * разбору. Проверка стоит затем, что устройство можно сломать
     * незаметно.
     */
    await markTrialSpent(testDb(), { batchId: await dump({ userId: anya }), trialLimit: 1 });
    await paid(anya, 'анин');
    await dump({ userId: boris });

    const { total } = await funnelOf(testDb());

    expect(total.paidAfterTrial).toBeLessThanOrEqual(total.trialOver);
    expect(total.trialOver).toBeLessThanOrEqual(total.firstDump);
    expect(total.firstDump).toBeLessThanOrEqual(total.registered);
  });
});

describe('разные пределы за разные недели', () => {
  it('встреченные пределы показываются списком, а не одним числом', async () => {
    /**
     * Предел правится из панели, и у людей разных недель он разный. Одно
     * число здесь было бы неправдой ровно после первой правки.
     */
    await markTrialSpent(testDb(), { batchId: await dump({ userId: anya }), trialLimit: 1 });
    await markTrialSpent(testDb(), { batchId: await dump({ userId: boris }), trialLimit: 5 });
    await markTrialSpent(testDb(), { batchId: await dump({ userId: boris }), trialLimit: 5 });
    await markTrialSpent(testDb(), { batchId: await dump({ userId: boris }), trialLimit: 5 });
    await markTrialSpent(testDb(), { batchId: await dump({ userId: boris }), trialLimit: 5 });
    await markTrialSpent(testDb(), { batchId: await dump({ userId: boris }), trialLimit: 5 });

    const funnel = await funnelOf(testDb());

    expect(funnel.total.trialOver).toBe(2);
    expect(funnel.trialLimits).toEqual([1, 5]);
    expect(funnel.missing.some((note) => note.includes('менялся'))).toBe(true);
  });
});

describe('разрез по источникам (§14)', () => {
  it('источники считаются раздельно, а прямой заход назван словом', async () => {
    /**
     * Пустая ячейка читается как «нет данных», а человек-то есть: он
     * пришёл по прямой ссылке. Прочерк в агрегате недопустим.
     */
    await testDb().update(users).set({ referralSource: 'blogger7' }).where(eq(users.id, anya));

    await dump({ userId: anya });
    await dump({ userId: boris });

    const funnel = await funnelOf(testDb());

    const byBlogger = funnel.bySource.find((row) => row.source === 'blogger7');
    const direct = funnel.bySource.find((row) => row.source === null);

    expect(byBlogger?.registered).toBe(1);
    expect(byBlogger?.firstDump).toBe(1);
    expect(direct?.registered).toBe(1);
  });

  it('пустая строка источника и его отсутствие — один разрез, а не два', async () => {
    // Параметр ссылки может прийти пустым, и две строки «без источника»
    // выглядели бы как два разных источника.
    await testDb().update(users).set({ referralSource: '' }).where(eq(users.id, anya));

    const funnel = await funnelOf(testDb());

    expect(funnel.bySource.filter((row) => row.source === null)).toHaveLength(1);
    expect(funnel.bySource.find((row) => row.source === null)?.registered).toBe(2);
  });

  it('сумма по источникам сходится с общим числом', async () => {
    /**
     * Отчёт, не сходящийся сам с собой, разбирающий сочтёт поломкой — и
     * будет прав.
     */
    await testDb().update(users).set({ referralSource: 'blogger7' }).where(eq(users.id, anya));

    await dump({ userId: anya });
    await paid(anya, 'анин');

    const funnel = await funnelOf(testDb());

    const sum = funnel.bySource.reduce((all, row) => all + row.registered, 0);

    expect(sum).toBe(funnel.total.registered);
  });

  it('оплаченные счёта без человека видны отдельным числом', async () => {
    /**
     * Люди уходят каскадом, а счета обезличиваются: выручка — наша
     * история (§16). Без этого числа сумма по источникам оказалась бы
     * меньше общей выручки.
     */
    await paid(anya, 'анин');
    await testDb().delete(users).where(eq(users.id, anya));

    const funnel = await funnelOf(testDb());

    expect(funnel.paidWithoutPerson).toBe(1);
    expect(funnel.missing.some((note) => note.includes('данные удалены'))).toBe(true);
  });
});

describe('когорта, а не период', () => {
  it('окно задаёт регистрацию, а шаги случаются когда угодно после', async () => {
    /**
     * Смешивать «зарегистрировались в сентябре» и «заплатили в сентябре»
     * нельзя: это разные множества, и числа не сойдутся друг с другом.
     */
    await testDb()
      .update(users)
      .set({ createdAt: new Date('2026-01-10T10:00:00.000Z') })
      .where(eq(users.id, anya));

    await dump({ userId: anya });
    await paid(anya, 'анин');
    await dump({ userId: boris });

    const old = await funnelOf(testDb(), {
      since: new Date('2026-01-01T00:00:00.000Z'),
      until: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(old.total.registered).toBe(1);
    // Оплата случилась сегодня, а человек из январской когорты — и он в ней.
    expect(old.total.paidWithoutTrialOver).toBe(1);

    const fresh = await funnelOf(testDb(), { since: new Date('2026-02-01T00:00:00.000Z') });

    expect(fresh.total.registered).toBe(1);
    expect(fresh.total.paidWithoutTrialOver).toBe(0);
  });
});
