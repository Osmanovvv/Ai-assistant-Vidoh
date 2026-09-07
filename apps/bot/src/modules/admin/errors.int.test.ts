import { beforeEach, describe, expect, it } from 'vitest';

import {
  aiCalls,
  batches,
  billingEvents,
  billingInvoices,
  billingSubscriptions,
  broadcastDeliveries,
  broadcasts,
  users,
} from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { createInvoice, markInvoiceFailed, nextInvId } from '../billing/billing.repo.js';
import { upsertUser } from '../users/users.repo.js';
import { errorsView, restartBatch } from './errors.js';

/**
 * Журнал сбоев (§15 ТЗ, задачи 4.10 и 4.2).
 *
 * До этого файла у журнала была только браузерная проверка: она открывает
 * страницу и читает её глазами. Между базой и страницей есть шов — имена
 * полей в ответе, — и он там покрыт, но **устройство запросов** нет:
 * границы периода, обезличенные строки, порядок, потолок списка.
 *
 * **Главное здесь — неудачные платежи.** Не увидеть сорвавшуюся выгрузку
 * значит не ответить человеку; не увидеть недоплату значит взять деньги и
 * не выдать услугу. Второе разбирается руками и разбирается срочно, а
 * молчание журнала означает, что разбирать никто и не придёт.
 */

let anya = '';
let olya = '';

beforeEach(async () => {
  await testDb().delete(aiCalls);
  await testDb().delete(broadcastDeliveries);
  await testDb().delete(broadcasts);
  await testDb().delete(billingEvents);
  await testDb().delete(billingSubscriptions);
  await testDb().delete(billingInvoices);
  await testDb().delete(batches);
  await testDb().delete(users);

  anya = (await upsertUser(testDb(), { tgId: 9_101, firstName: 'Аня' })).id;
  olya = (await upsertUser(testDb(), { tgId: 9_102, firstName: 'Оля' })).id;
});

/** Счёт, который не удался: сумма не сошлась. */
async function underpaid(params: {
  readonly userId: string;
  readonly ref: string;
  readonly received: string;
  readonly currency?: 'RUB' | 'XTR';
}): Promise<void> {
  const invoice = await createInvoice(testDb(), {
    provider: params.currency === 'XTR' ? 'telegram:stars' : 'robokassa:smz',
    userId: params.userId,
    plan: 'monthly',
    kind: 'initial',
    amountMinor: params.currency === 'XTR' ? 150 : 39_900,
    currency: params.currency ?? 'RUB',
    ref: params.ref,
    ...(params.currency === 'XTR' ? {} : { invId: await nextInvId(testDb()) }),
  });

  await markInvoiceFailed(testDb(), {
    id: invoice.id,
    errorText: 'заплачено меньше, чем в счёте',
    outSumReceived: params.received,
  });
}

describe('неудачные платежи в журнале (задача 4.2)', () => {
  it('видны с обеими суммами: сколько ждали и сколько пришло', async () => {
    /**
     * Разница между этими двумя числами и есть весь разбор. Показать
     * одну сумму значило бы отправить разбирающего в журнал провайдера
     * за второй.
     */
    await underpaid({ userId: anya, ref: 'мало', received: '1.00' });

    const view = await errorsView(testDb(), 30);

    expect(view.payments).toHaveLength(1);
    expect(view.paymentsTotal).toBe(1);

    const [row] = view.payments;

    expect(row?.who).toBe('Аня');
    expect(row?.expectedMinor).toBe(39_900);
    expect(row?.currency).toBe('RUB');
    expect(row?.received).toBe('1.00');
    expect(row?.errorText).toContain('меньше');
  });

  it('удачные счёта в журнал не попадают', async () => {
    // Иначе журнал ошибок стал бы журналом платежей, и в нём перестали
    // бы искать ошибки.
    await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId: anya,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 39_900,
      currency: 'RUB',
      ref: 'хороший',
      invId: await nextInvId(testDb()),
    });

    expect((await errorsView(testDb(), 30)).payments).toEqual([]);
  });

  it('обезличенный счёт остаётся видимым', async () => {
    /**
     * Человек удалил данные, а неудачный платёж был. Деньги в учёте
     * наши (§16: выручка — не его данные), и спрятать строку значило бы
     * потерять след денег.
     */
    await underpaid({ userId: olya, ref: 'ушёл', received: '1.00' });
    await testDb().delete(users);

    const view = await errorsView(testDb(), 30);

    expect(view.payments).toHaveLength(1);
    expect(view.payments[0]?.who).toBe('данные удалены');
    expect(view.payments[0]?.userId).toBeNull();
  });

  it('звёзды показываются штуками, а не копейками', async () => {
    await underpaid({ userId: anya, ref: 'звёзды', received: '1', currency: 'XTR' });

    const [row] = (await errorsView(testDb(), 30)).payments;

    expect(row?.rail).toBe('telegram:stars');
    expect(row?.expectedMinor).toBe(150);
    expect(row?.currency).toBe('XTR');
  });

  it('старые неудачи за границу периода не попадают', async () => {
    await underpaid({ userId: anya, ref: 'старый', received: '1.00' });

    await testDb()
      .update(billingInvoices)
      .set({ createdAt: new Date(Date.now() - 40 * 24 * 3_600_000) });

    expect((await errorsView(testDb(), 30)).payments).toEqual([]);
    expect((await errorsView(testDb(), 60)).payments).toHaveLength(1);
  });

  it('журнал говорит, что повтора у платежей нет', async () => {
    /**
     * Повторить списание — значит взять деньги второй раз. Молчание об
     * этом читалось бы как «кнопку забыли сделать», и её однажды
     * сделали бы.
     */
    const view = await errorsView(testDb(), 30);

    expect(view.missing.some((note) => note.includes('повтора нет'))).toBe(true);
  });
});

describe('прочие источники журнала (задача 4.10)', () => {
  it('сорвавшаяся выгрузка видна, а её текст — нет', async () => {
    /**
     * §16: журнал ошибок читают часто и мимоходом, и содержимому чужих
     * мыслей в нём делать нечего. Видно, что сорвалось и у кого; сами
     * слова — в карточке, где доступ к ним журналируется.
     */
    await testDb().insert(batches).values({
      userId: anya,
      status: 'failed',
      attempts: 3,
      error: 'TransientSpeechError: распознавание не ответило',
      combinedText: 'надо купить корм коту',
    });

    const view = await errorsView(testDb(), 30);

    expect(view.batches).toHaveLength(1);
    expect(view.batches[0]?.who).toBe('Аня');
    // Длина сказанного есть, самих слов нет.
    expect(view.batches[0]?.length).toBe('надо купить корм коту'.length);
    expect(JSON.stringify(view.batches)).not.toContain('корм');
  });

  it('неудачный вызов модели помечен, платили за него или нет', async () => {
    // 429 не тарифится, а таймаут после отправки — да. Отчёт без этой
    // разницы не позволяет понять, за что заплатили.
    await testDb()
      .insert(aiCalls)
      .values([
        {
          userId: anya,
          stage: 'classifier',
          model: 'yandex:yandexgpt/latest',
          costMicros: 0,
          costCurrency: 'rub',
          latencyMs: 100,
          ok: false,
          error: '429 Too Many Requests',
        },
        {
          userId: anya,
          stage: 'classifier',
          model: 'yandex:yandexgpt/latest',
          costMicros: 8_000_000,
          costCurrency: 'rub',
          latencyMs: 60_000,
          ok: false,
          error: 'таймаут после отправки',
        },
      ]);

    const view = await errorsView(testDb(), 30);

    expect(view.calls).toHaveLength(2);
    expect(view.calls.filter((one) => one.paid)).toHaveLength(1);
  });

  it('удачный вызов в журнал не попадает', async () => {
    await testDb().insert(aiCalls).values({
      userId: anya,
      stage: 'router',
      model: 'yandex:yandexgpt-lite/latest',
      costMicros: 1_000,
      costCurrency: 'rub',
      latencyMs: 100,
      ok: true,
    });

    expect((await errorsView(testDb(), 30)).calls).toEqual([]);
  });
});

describe('перезапуск сорвавшейся выгрузки', () => {
  it('возвращает хозяина выгрузки — его и надо поставить в очередь', async () => {
    const [batch] = await testDb()
      .insert(batches)
      .values({ userId: anya, status: 'failed', attempts: 3, error: 'сбой' })
      .returning({ id: batches.id });

    const outcome = await restartBatch(testDb(), batch?.id ?? '');

    expect(outcome).toEqual({ ok: true, userId: anya });
  });

  it('неcорванную выгрузку перезапускать отказывается', async () => {
    /**
     * Иначе кнопка в панели умела бы гонять по конвейеру уже
     * разобранное — и платить за это второй раз.
     */
    const [batch] = await testDb()
      .insert(batches)
      .values({ userId: anya, status: 'done' })
      .returning({ id: batches.id });

    expect((await restartBatch(testDb(), batch?.id ?? '')).ok).toBe(false);
  });
});
