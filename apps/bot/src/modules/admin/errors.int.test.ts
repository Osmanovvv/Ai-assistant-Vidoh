import { and, eq } from 'drizzle-orm';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  aiCalls,
  batches,
  billingEvents,
  billingInvoices,
  billingSubscriptions,
  broadcastDeliveries,
  broadcasts,
  reminders,
  users,
} from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { createInvoice, markInvoiceFailed, nextInvId } from '../billing/billing.repo.js';
import { createBroadcast } from '../broadcast/broadcast.repo.js';
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

/**
 * Счёт, заведённый в один день и отвергнутый в другой.
 *
 * Так это и выглядит в бою: счёт заводится нажатием кнопки и живёт до
 * `expires_at`, а недоплата приходит уведомлением провайдера тогда, когда
 * человек соберётся заплатить. `refused: null` — счёт, помеченный
 * неудачным до появления колонки `failed_at`: времени отказа у него нет.
 */
async function refused(params: {
  readonly userId: string;
  readonly ref: string;
  readonly invoiced: Date;
  readonly refused: Date | null;
  readonly errorText: string;
}): Promise<void> {
  const invoice = await createInvoice(testDb(), {
    provider: 'robokassa:smz',
    userId: params.userId,
    plan: 'monthly',
    kind: 'initial',
    amountMinor: 39_900,
    currency: 'RUB',
    ref: params.ref,
    invId: await nextInvId(testDb()),
  });

  await markInvoiceFailed(testDb(), {
    id: invoice.id,
    errorText: params.errorText,
    ...(params.refused === null ? {} : { now: params.refused }),
  });

  await testDb()
    .update(billingInvoices)
    .set({
      createdAt: params.invoiced,
      ...(params.refused === null ? { failedAt: null } : {}),
    })
    .where(eq(billingInvoices.id, invoice.id));
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
    /**
     * За границу уводится **время отказа**, а не только дата счёта:
     * журнал отбирает по нему (ревизия панели). Прежде проверка сдвигала
     * дату счёта, и после починки отбора она мерила бы не то — счёт
     * сорокадневной давности, отвергнутый сегодня, в срезе за месяц
     * обязан быть виден.
     */
    await refused({
      userId: anya,
      ref: 'старый',
      invoiced: new Date(Date.now() - 41 * 24 * 3_600_000),
      refused: new Date(Date.now() - 40 * 24 * 3_600_000),
      errorText: 'давняя недоплата',
    });

    expect((await errorsView(testDb(), 30)).payments).toEqual([]);
    expect((await errorsView(testDb(), 60)).payments).toHaveLength(1);
  });

  it('отбираются по времени отказа, а не по дате счёта', async () => {
    /**
     * Ревизия панели. Счёт заведён нажатием кнопки, а недоплата приходит
     * уведомлением провайдера тогда, когда человек соберётся заплатить:
     * счёт трёхдневной давности, недоплаченный сегодня, при выборе
     * «сутки» в журнале не появлялся вовсе, — то есть самое дорогое
     * событие журнала было не видно как раз в том срезе, с которого
     * разбор и начинают.
     *
     * Обстановка боя нарочно: у одного счёта отказ пришёл через три дня
     * после выставления, у другого — в тот же день. При отборе по дате
     * счёта первый выпадает из суток, а порядок двух строк
     * переворачивается.
     */
    const now = Date.now();

    await refused({
      userId: anya,
      ref: 'заплатил-на-третий-день',
      invoiced: new Date(now - 3 * 24 * 3_600_000),
      refused: new Date(now - 3_600_000),
      errorText: 'отказ час назад',
    });

    await refused({
      userId: olya,
      ref: 'заплатил-сразу',
      invoiced: new Date(now - 2 * 24 * 3_600_000),
      refused: new Date(now - 2 * 24 * 3_600_000),
      errorText: 'отказ два дня назад',
    });

    const day = await errorsView(testDb(), 1);

    expect(day.payments.map((one) => one.errorText)).toEqual(['отказ час назад']);
    expect(day.paymentsTotal).toBe(1);

    const week = await errorsView(testDb(), 7);

    // Порядок — по времени отказа: по дате счёта он был бы обратным.
    expect(week.payments.map((one) => one.errorText)).toEqual([
      'отказ час назад',
      'отказ два дня назад',
    ]);

    // И «Когда» в таблице — время отказа, а не дата счёта.
    expect(week.payments[0]?.at).toBe(new Date(now - 3_600_000).toISOString());
  });

  it('счёт, помеченный до появления времени отказа, из журнала не пропадает', async () => {
    /**
     * У неудачных счетов боевой базы времени отказа нет: колонка
     * появилась позже, а выдумывать им дату — значит записать догадку в
     * данные. Отбор по одному `failed_at` спрятал бы такие строки
     * совсем: починка отбора обошлась бы потерей прежних неудач, то есть
     * ровно тех, из-за которых журнал и читают.
     */
    const now = Date.now();

    await refused({
      userId: anya,
      ref: 'из-прежних',
      invoiced: new Date(now - 2 * 24 * 3_600_000),
      refused: null,
      errorText: 'без времени отказа',
    });

    const week = await errorsView(testDb(), 7);

    expect(week.payments.map((one) => one.errorText)).toEqual(['без времени отказа']);
    expect(week.paymentsTotal).toBe(1);
    // У таких «Когда» — дата счёта: прежнее поведение, лучшего нет.
    expect(week.payments[0]?.at).toBe(new Date(now - 2 * 24 * 3_600_000).toISOString());
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

  it('у неуспешного вызова видно, у кого он сорвался', async () => {
    /**
     * Ревизия панели. Жалоба приходит от конкретного человека и в
     * конкретное время, а строка вызова не называла ни имени, ни чего-то
     * ещё, чем её связать: `user_id` в базе лежит и уже читается в
     * разрезах расходов, но в выборку журнала не входил. У соседней
     * таблицы сорвавшихся разборов «У кого» есть.
     */
    await testDb().insert(aiCalls).values({
      userId: anya,
      stage: 'classifier',
      model: 'yandex:yandexgpt/latest',
      latencyMs: 4_000,
      ok: false,
      error: '429 Too Many Requests',
    });

    const view = await errorsView(testDb(), 30);

    expect(view.calls).toHaveLength(1);
    expect(view.calls[0]?.who).toBe('Аня');
  });

  it('вызов ушедшего человека называет удаление словами', async () => {
    /**
     * `user_id` у вызова гасится при удалении данных (§16), и пустая
     * клетка читалась бы как «неизвестно кто» — то есть как поломка
     * учёта. Слова отличают удаление от промаха связи.
     */
    await testDb().insert(aiCalls).values({
      userId: olya,
      stage: 'router',
      model: 'yandex:yandexgpt-lite/latest',
      latencyMs: 100,
      ok: false,
      error: 'таймаут',
    });

    await testDb().delete(users);

    expect((await errorsView(testDb(), 30)).calls[0]?.who).toBe('данные удалены');
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

describe('журнал сбоев: период и пятый источник (ревизия четвёртого этапа)', () => {
  it('не дошедшие письма подчиняются периоду и имеют итог', async () => {
    /**
     * Прежде границы периода у этого источника не было вовсе: при выборе
     * «сутки» в списке стояли письма месячной давности. А пятьдесят
     * строк без итога читались как полный список — три соседних
     * источника фильтруются по периоду и печатают своё число, этот один
     * молчал.
     */
    // Двум людям, а не одному дважды: на пару «рассылка и человек»
    // стоит уникальность — второе письмо тому же человеку не завести.
    const anya = await upsertUser(testDb(), { tgId: 8_101, firstName: 'Аня' });
    const olya = await upsertUser(testDb(), { tgId: 8_102, firstName: 'Оля' });

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    /**
     * Строки доставки правятся, а не заводятся: `createBroadcast` уже
     * завёл их всем людям сегмента, и на пару «рассылка и человек»
     * стоит уникальность.
     */
    await testDb()
      .update(broadcastDeliveries)
      .set({ status: 'failed', error: 'вчера', at: new Date(Date.now() - 24 * 3_600_000) })
      .where(
        and(eq(broadcastDeliveries.broadcastId, made.id), eq(broadcastDeliveries.userId, anya.id)),
      );

    await testDb()
      .update(broadcastDeliveries)
      .set({ status: 'failed', error: 'давно', at: new Date(Date.now() - 40 * 24 * 3_600_000) })
      .where(
        and(eq(broadcastDeliveries.broadcastId, made.id), eq(broadcastDeliveries.userId, olya.id)),
      );

    const week = await errorsView(testDb(), 7);

    expect(week.sends.map((one) => one.error)).toEqual(['вчера']);
    expect(week.sendsTotal).toBe(1);

    const quarter = await errorsView(testDb(), 90);

    expect(quarter.sendsTotal).toBe(2);
  });

  it('в строке не дошедшего письма названы рассылка и получатель', async () => {
    /**
     * **Подпись под таблицей велела идти к «нужной рассылке», а сказать,
     * какая это, было нечем** (ревизия панели). `broadcastId` приезжал и
     * не рисовался: раздел «Рассылка» идентификаторов не печатает, так
     * что сопоставлять оставалось по времени — при том что журнал
     * смотрит до 366 дней, а список рассылок обрезан двадцатью. И «Кому»
     * было сырым телеграмным номером: поиск в «Пользователях» ищет по
     * имени и @имени, найти по номеру человека нечем.
     */
    const person = await upsertUser(testDb(), { tgId: 8_301, firstName: 'Ася' });

    const made = await createBroadcast(testDb(), {
      text: 'Пробные разборы кончились, вот тарифы.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await testDb()
      .update(broadcastDeliveries)
      .set({ status: 'failed', error: '403', at: new Date() })
      .where(
        and(
          eq(broadcastDeliveries.broadcastId, made.id),
          eq(broadcastDeliveries.userId, person.id),
        ),
      );

    const [row] = (await errorsView(testDb(), 7)).sends;

    expect(row?.who).toBe('Ася');
    expect(row?.broadcastText).toContain('Пробные разборы кончились');
    // Время рассылки, а не письма: по нему её и видно в разделе рассылки.
    expect(Number.isNaN(Date.parse(row?.broadcastAt ?? ''))).toBe(false);
  });

  it('у человека без имени в клетке «Кому» остаётся его номер', async () => {
    /**
     * Удаление данных снимает имя, а строка доставки живёт своим
     * номером-копией. Пустая клетка здесь читалась бы как «неизвестно
     * кому» — а известно.
     */
    const person = await upsertUser(testDb(), { tgId: 8_302, firstName: 'Без имени' });

    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: 'аня',
      trialLimit: 10,
    });

    await testDb()
      .update(users)
      .set({ firstName: null, username: null })
      .where(eq(users.id, person.id));

    await testDb()
      .update(broadcastDeliveries)
      .set({ status: 'failed', error: '403', at: new Date() })
      .where(
        and(
          eq(broadcastDeliveries.broadcastId, made.id),
          eq(broadcastDeliveries.userId, person.id),
        ),
      );

    const rows = (await errorsView(testDb(), 7)).sends;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.who).toBe('id 8302');
  });

  it('сорвавшиеся напоминания видны — пятый источник', async () => {
    /**
     * Прежде их не было в журнале вовсе, и о их отсутствии не было
     * сказано словами: человек не получал утреннего письма, а панель
     * молчала. Колонку `skipped_reason` читал только сам планировщик.
     */
    const person = await upsertUser(testDb(), { tgId: 8_103, firstName: 'Оля' });

    await testDb()
      .insert(reminders)
      .values([
        {
          userId: person.id,
          kind: 'morning',
          dueAt: new Date(Date.now() - 2 * 3_600_000),
          dedupeKey: 'у-которого-сорвалось',
          skippedReason: 'failed',
        },
        {
          userId: person.id,
          kind: 'evening',
          dueAt: new Date(Date.now() - 3 * 3_600_000),
          dedupeKey: 'пропущенное-по-тишине',
          skippedReason: 'quiet',
        },
      ]);

    const view = await errorsView(testDb(), 7);

    // Только сорвавшееся: пропуск по тишине — не сбой, а решение.
    expect(view.reminders).toHaveLength(1);
    expect(view.reminders[0]?.kind).toBe('morning');
    expect(view.reminders[0]?.firstName).toBe('Оля');
    expect(view.remindersTotal).toBe(1);
  });

  it('у напоминаний в списке оговорок есть своя строка', async () => {
    const view = await errorsView(testDb(), 7);

    expect(view.missing.join(' ')).toContain('напоминаний повтора нет');
  });
});
