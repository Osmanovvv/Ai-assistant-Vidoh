import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  appSettings,
  billingEvents,
  billingInvoices,
  billingSubscriptions,
  promoCodes,
  users,
} from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { putSetting, SettingsRegistry } from '../settings/settings.repo.js';
import { upsertUser } from '../users/users.repo.js';
import { createInvoice, markInvoicePaid, markInvoiceRefunded, nextInvId } from './billing.repo.js';
import { startCheckout } from './checkout.service.js';
import { normalizeCode, promoFor, promoRows, savePromo, setPromoEnabled } from './promo.service.js';
import type { PaymentProvider } from './provider.js';

/**
 * Промокоды на первый период (§14 ТЗ, задача 4.4).
 *
 * §14 дословно: «Поддержка кода на первый период. Нужны для запуска
 * через блогеров».
 *
 * **Главное здесь — что скидка не превращается в подарок навсегда.** Код
 * действует один раз и только до первой оплаты; промо-счёт уходит без
 * автопродления, иначе у звёзд Telegram продлевал бы подписку **по сумме
 * счёта**, то есть по скидочной цене, и заметить это можно было бы только
 * по выручке через месяц.
 *
 * Второе по важности — что скидка не ломает приём оплаты. Она меняет одно
 * число в одной строке **до** создания счёта, а сверка при уведомлении
 * идёт со суммой счёта. Проверяется тем, что счёт, подпись и цена в
 * ссылке считаются из одной переменной.
 */

const logger = createLogger({ level: 'silent' });

let userId = '';
let settings: SettingsRegistry;

/** Провайдер-заглушка: помнит, о чём просили. */
function fakeProvider(name: 'robokassa:smz' | 'telegram:stars'): PaymentProvider & {
  readonly asked: { amount: number; renewable?: boolean | undefined }[];
} {
  const asked: { amount: number; renewable?: boolean | undefined }[] = [];

  return {
    name,
    asked,
    createCheckout: (request) => {
      asked.push({ amount: request.amount, renewable: request.renewable });

      return Promise.resolve({
        url: `https://оплата.тест/${request.ref}`,
        autoRenews: request.renewable !== false && request.plan === 'monthly',
      });
    },
    readEvent: () => Promise.resolve(undefined),
    stopRenewal: () => Promise.resolve(),
    statusOf: () => Promise.resolve(undefined),
  };
}

beforeEach(async () => {
  await testDb().delete(billingEvents);
  await testDb().delete(billingSubscriptions);
  await testDb().delete(billingInvoices);
  await testDb().delete(promoCodes);
  await testDb().delete(appSettings);
  await testDb().delete(users);

  userId = (await upsertUser(testDb(), { tgId: 4_500_001, firstName: 'Вера' })).id;

  settings = new SettingsRegistry({ db: testDb(), logger, ttlMs: 0 });

  await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });
  await putSetting(testDb(), { name: 'priceMonthlyStars', value: '150' });

  await savePromo(testDb(), {
    code: 'blogger7',
    plan: 'monthly',
    priceRubMinor: 9_900,
    priceStars: 40,
    note: 'Марина, канал про быт',
  });
});

describe('приведение кода к единому виду', () => {
  it('регистр и пробелы по краям не важны', () => {
    /**
     * Блогер напишет код в посте как угодно, человек перепишет как
     * увидел. Сравнивать можно только что-то одно.
     */
    expect(normalizeCode('  blogger7 ')).toBe('BLOGGER7');
    expect(normalizeCode('BLOGGER-7')).toBe('BLOGGER-7');
  });

  it('кириллица не принимается', () => {
    /**
     * Не из-за подписи — код провайдеру не уходит вовсе. Причина проще:
     * «ВЫДОХ» и «BЫДОХ» с латинской «B» человек не различит, а бот
     * различит, и разбирать это обращение будет некому.
     */
    expect(normalizeCode('ВЫДОХ10')).toBeUndefined();
  });

  it('слишком короткое и слишком длинное не принимается', () => {
    expect(normalizeCode('ab')).toBeUndefined();
    expect(normalizeCode('X'.repeat(25))).toBeUndefined();
  });
});

describe('годится ли код', () => {
  const ask = (extra: Record<string, unknown> = {}) =>
    promoFor(testDb(), {
      code: 'BLOGGER7',
      userId,
      rail: 'robokassa:smz',
      plan: 'monthly',
      settings,
      ...extra,
    });

  it('годный код даёт цену по себе и полную', async () => {
    const outcome = await ask();

    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.offer.price : undefined).toEqual({
      amountMinor: 9_900,
      currency: 'RUB',
    });
    // Полная цена нужна на счёте: по ней потом видно, сколько недополучено.
    expect(outcome.ok ? outcome.offer.full.amountMinor : undefined).toBe(39_900);
  });

  it('у звёзд своя цена, а не пересчёт из рублей', async () => {
    /**
     * Курс звезды задаёт Telegram, он меняется, и считать его в коде
     * значило бы однажды продать месяц за две звезды.
     */
    const outcome = await ask({ rail: 'telegram:stars' });

    expect(outcome.ok ? outcome.offer.price : undefined).toEqual({
      amountMinor: 40,
      currency: 'XTR',
    });
  });

  it('несуществующий код не подходит', async () => {
    expect(await ask({ code: 'НЕТТАКОГО' })).toEqual({ ok: false, why: 'unknown' });
  });

  it('выключенный код не подходит, и это отдельная причина', async () => {
    await setPromoEnabled(testDb(), { code: 'BLOGGER7', enabled: false });

    expect(await ask()).toEqual({ ok: false, why: 'disabled' });
  });

  it('код можно включить обратно', async () => {
    // Выключение, а не удаление: по коду считается, сколько недополучено.
    await setPromoEnabled(testDb(), { code: 'BLOGGER7', enabled: false });
    await setPromoEnabled(testDb(), { code: 'BLOGGER7', enabled: true });

    expect((await ask()).ok).toBe(true);
  });

  it('истёкший код не подходит', async () => {
    await savePromo(testDb(), {
      code: 'OLDONE',
      plan: 'monthly',
      priceRubMinor: 9_900,
      priceStars: 40,
      validUntil: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(await ask({ code: 'OLDONE' })).toEqual({ ok: false, why: 'expired' });
  });

  it('не тот тариф — для человека это «нет такого кода»', async () => {
    /**
     * Кнопку со скидкой мы показываем только у того тарифа, к которому
     * код подходит. Дойти сюда можно лишь подделав `callback_data`, и
     * отдельная причина для этого случая была бы объяснением подделки.
     */
    expect(await ask({ plan: 'yearly' })).toEqual({ ok: false, why: 'unknown' });
  });

  it('уже платившему скидки нет — она на ПЕРВЫЙ период', async () => {
    /**
     * Состояние, а не флаг: считается запросом «есть ли оплаченный
     * счёт». Флаг в профиле, разойдясь с правдой, не сверяется ни с чем.
     */
    const invoice = await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 39_900,
      currency: 'RUB',
      ref: 'старый',
      invId: await nextInvId(testDb()),
    });

    await markInvoicePaid(testDb(), { id: invoice.id, now: new Date() });

    expect(await ask()).toEqual({ ok: false, why: 'not-first' });
  });

  it('квота считается по ОПЛАЧЕННЫМ счетам, а не по выставленным', async () => {
    /**
     * Человек нажимает кнопку и уходит думать, и таких больше, чем
     * заплативших. Считай мы выставленные — код кончился бы в первый же
     * день, не принеся ни рубля.
     */
    await savePromo(testDb(), {
      code: 'ONLYONE',
      plan: 'monthly',
      priceRubMinor: 9_900,
      priceStars: 40,
      maxRedemptions: 1,
    });

    /**
     * Два человека, а не один: промо-счёт у человека может быть только
     * один (запрет базы), и это правильно — код на первый период.
     * Брошенный и оплаченный счёта одного кода приходят от разных
     * людей, как и бывает у блогерской ссылки.
     */
    const other = (await upsertUser(testDb(), { tgId: 4_500_002, firstName: 'Оля' })).id;
    const third = (await upsertUser(testDb(), { tgId: 4_500_003, firstName: 'Ира' })).id;

    // Выставленный, но не оплаченный: квоту не тратит.
    await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId: other,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 9_900,
      currency: 'RUB',
      ref: 'брошенный',
      promoCode: 'ONLYONE',
      invId: await nextInvId(testDb()),
    });

    expect((await ask({ code: 'ONLYONE' })).ok).toBe(true);

    // А оплаченный — тратит.
    const paid = await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId: third,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 9_900,
      currency: 'RUB',
      ref: 'оплаченный',
      promoCode: 'ONLYONE',
      invId: await nextInvId(testDb()),
    });

    await markInvoicePaid(testDb(), { id: paid.id, now: new Date() });

    expect(await ask({ code: 'ONLYONE' })).toEqual({ ok: false, why: 'spent' });
  });

  it('код дороже полной цены — не скидка, и не продаётся', async () => {
    /**
     * Так бывает после снижения цены тарифа: код на 299 при цене 199
     * означал бы, что человек по коду платит **больше**.
     */
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '5000' });
    settings.forget();

    expect(await ask()).toEqual({ ok: false, why: 'no-price' });
  });

  it('без назначенной цены тарифа скидки нет', async () => {
    // Тариф не продаётся вовсе — со скидкой тем более нельзя.
    await testDb().delete(appSettings);
    settings.forget();

    expect(await ask()).toEqual({ ok: false, why: 'no-price' });
  });
});

describe('заведение кода', () => {
  it('повторный код не перезаписывается молча', async () => {
    /**
     * Заказчица, назвавшая уже существующий код, скорее всего забыла о
     * нём. Молчаливая перезапись изменила бы условия тем, кто ещё не
     * заплатил, и заметить это было бы нечем.
     */
    const again = await savePromo(testDb(), {
      code: 'BLOGGER7',
      plan: 'yearly',
      priceRubMinor: 1,
      priceStars: 1,
    });

    expect(again).toEqual({ ok: false, why: 'exists' });

    const [row] = await testDb().select().from(promoCodes).where(eq(promoCodes.code, 'BLOGGER7'));

    expect(row?.plan).toBe('monthly');
    expect(row?.priceRubMinor).toBe(9_900);
  });

  it('нулевая цена не принимается', async () => {
    // Счёт на нуль выставить нельзя ни на одном рельсе: «бесплатно» —
    // это другое устройство, а не разновидность скидки.
    expect(
      await savePromo(testDb(), {
        code: 'FREE1',
        plan: 'monthly',
        priceRubMinor: 0,
        priceStars: 40,
      }),
    ).toEqual({
      ok: false,
      why: 'bad-price',
    });
  });

  it('кривой код не принимается', async () => {
    expect(
      await savePromo(testDb(), {
        code: 'ой',
        plan: 'monthly',
        priceRubMinor: 9_900,
        priceStars: 40,
      }),
    ).toEqual({ ok: false, why: 'bad-code' });
  });
});

describe('скидка на выставлении счёта', () => {
  it('в счёт уходит цена по коду, а полная сохраняется рядом', async () => {
    /**
     * **Единственное правило встраивания скидки:** она применяется до
     * создания счёта и одним значением. Тогда счёт, подпись и сумма в
     * ссылке считаются из одной переменной и разойтись не могут.
     */
    const provider = fakeProvider('robokassa:smz');

    const offer = await promoFor(testDb(), {
      code: 'BLOGGER7',
      userId,
      rail: 'robokassa:smz',
      plan: 'monthly',
      settings,
    });

    expect(offer.ok).toBe(true);
    if (!offer.ok) return;

    const outcome = await startCheckout(testDb(), {
      userId,
      tgId: 4_500_001,
      plan: 'monthly',
      rail: 'robokassa:smz',
      settings,
      provider,
      title: 'ВЫДОХ, месяц',
      description: 'Подписка',
      promo: offer.offer,
    });

    expect(outcome.ok).toBe(true);

    const [invoice] = await testDb().select().from(billingInvoices);

    expect(invoice?.amountMinor).toBe(9_900);
    expect(invoice?.amountFullMinor).toBe(39_900);
    expect(invoice?.promoCode).toBe('BLOGGER7');

    // Провайдер подписал ровно ту сумму, что в счёте.
    expect(provider.asked[0]?.amount).toBe(9_900);
  });

  it('промо-счёт уходит БЕЗ автопродления — и это главное', async () => {
    /**
     * У звёзд Telegram продлевает подписку **по сумме счёта**: подписочный
     * промо-счёт означал бы скидку навсегда, и заметить это можно было бы
     * только по выручке через месяц. У Робокассы дочернее списание на
     * сумму больше материнского официально не выяснено.
     */
    const provider = fakeProvider('telegram:stars');

    const offer = await promoFor(testDb(), {
      code: 'BLOGGER7',
      userId,
      rail: 'telegram:stars',
      plan: 'monthly',
      settings,
    });

    if (!offer.ok) throw new Error('код должен был подойти');

    const outcome = await startCheckout(testDb(), {
      userId,
      tgId: 4_500_001,
      plan: 'monthly',
      rail: 'telegram:stars',
      settings,
      provider,
      title: 'ВЫДОХ, месяц',
      description: 'Подписка',
      promo: offer.offer,
    });

    expect(provider.asked[0]?.renewable).toBe(false);
    expect(outcome.ok ? outcome.checkout.autoRenews : true).toBe(false);

    // И на счёте это записано: часовой проход продления его не возьмёт.
    const [invoice] = await testDb().select().from(billingInvoices);
    expect(invoice?.autoRenew).toBe(false);
  });

  it('без кода счёт по-прежнему просит продление', async () => {
    // Проверка того, что оговорка про промо не сломала обычную покупку.
    const provider = fakeProvider('robokassa:smz');

    await startCheckout(testDb(), {
      userId,
      tgId: 4_500_001,
      plan: 'monthly',
      rail: 'robokassa:smz',
      settings,
      provider,
      title: 'ВЫДОХ, месяц',
      description: 'Подписка',
    });

    expect(provider.asked[0]?.renewable).toBeUndefined();

    const [invoice] = await testDb().select().from(billingInvoices);
    expect(invoice?.amountFullMinor).toBe(39_900);
    expect(invoice?.promoCode).toBeNull();
  });
});

describe('коды в панели', () => {
  it('считает оплаты и недополученное по счетам, а не по нынешней цене', async () => {
    /**
     * Цена тарифа меняется, и вычитая её сегодня, мы получили бы другую
     * скидку у платежей прошлого месяца. Поэтому полная цена сохранена в
     * самом счёте.
     */
    const invoice = await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 9_900,
      currency: 'RUB',
      amountFullMinor: 39_900,
      promoCode: 'BLOGGER7',
      ref: 'по-коду',
      invId: await nextInvId(testDb()),
    });

    await markInvoicePaid(testDb(), { id: invoice.id, now: new Date() });

    // Цену тарифа снизили после оплаты — недополученное не должно измениться.
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '19900' });
    settings.forget();

    const [row] = await promoRows(testDb());

    expect(row?.code).toBe('BLOGGER7');
    expect(row?.redeemed).toBe(1);
    expect(row?.discountMinor).toBe(30_000);
    expect(row?.note).toBe('Марина, канал про быт');
  });

  it('брошенные счёта в применения не попадают', async () => {
    await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 9_900,
      currency: 'RUB',
      amountFullMinor: 39_900,
      promoCode: 'BLOGGER7',
      ref: 'брошен',
      invId: await nextInvId(testDb()),
    });

    const [row] = await promoRows(testDb());

    expect(row?.redeemed).toBe(0);
    expect(row?.discountMinor).toBe(0);
  });
});

describe('промо-счёт один на человека (ревизия четвёртого этапа)', () => {
  /**
   * **Найдено ревизией, и это была самая дорогая находка промокодов.**
   * «Первый период» проверялся только в момент выставления счёта, а
   * счетов можно было завести сколько угодно: ссылки живут вечно, при
   * оплате промокод не перепроверяется, а сроки складываются.
   *
   * Двенадцать нажатий той же кнопки — год за 1188 ₽ вместо 4788 ₽, и в
   * панели «двенадцать применений».
   */

  async function offer() {
    const outcome = await promoFor(testDb(), {
      code: 'BLOGGER7',
      userId,
      rail: 'robokassa:smz',
      plan: 'monthly',
      settings,
    });

    if (!outcome.ok) throw new Error('код должен был подойти');

    return outcome.offer;
  }

  it('повторное нажатие возвращает ту же ссылку, а не заводит второй счёт', async () => {
    const provider = fakeProvider('robokassa:smz');

    const first = await startCheckout(testDb(), {
      userId,
      tgId: 4_500_001,
      plan: 'monthly',
      rail: 'robokassa:smz',
      settings,
      provider,
      title: 'ВЫДОХ, месяц',
      description: 'Подписка',
      promo: await offer(),
    });

    const second = await startCheckout(testDb(), {
      userId,
      tgId: 4_500_001,
      plan: 'monthly',
      rail: 'robokassa:smz',
      settings,
      provider,
      title: 'ВЫДОХ, месяц',
      description: 'Подписка',
      promo: await offer(),
    });

    expect(first.ok && second.ok).toBe(true);

    // Счёт один, а не два.
    expect(await testDb().select().from(billingInvoices)).toHaveLength(1);

    // И ссылка та же: она строится из тех же параметров.
    expect(first.ok ? first.ref : '').toBe(second.ok ? second.ref : 'другой');
    expect(provider.asked).toHaveLength(2);
    expect(provider.asked[0]?.amount).toBe(provider.asked[1]?.amount);
  });

  it('двенадцать нажатий дают один счёт, а не год по цене месяца', async () => {
    const provider = fakeProvider('robokassa:smz');

    for (let index = 0; index < 12; index += 1) {
      await startCheckout(testDb(), {
        userId,
        tgId: 4_500_001,
        plan: 'monthly',
        rail: 'robokassa:smz',
        settings,
        provider,
        title: 'ВЫДОХ, месяц',
        description: 'Подписка',
        promo: await offer(),
      });
    }

    expect(await testDb().select().from(billingInvoices)).toHaveLength(1);
  });

  it('запрет держит база, а не осторожность кода', async () => {
    /**
     * Между проверкой и вставкой всегда есть щель, и два нажатия подряд
     * попадают в неё легко. Здесь второй счёт заводится в обход
     * проверки — и упирается в уникальный индекс.
     */
    await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 9_900,
      currency: 'RUB',
      ref: 'первый-промо',
      promoCode: 'BLOGGER7',
    });

    await expect(
      createInvoice(testDb(), {
        provider: 'robokassa:smz',
        userId,
        plan: 'monthly',
        kind: 'initial',
        amountMinor: 9_900,
        currency: 'RUB',
        ref: 'второй-промо',
        promoCode: 'BLOGGER7',
      }),
    ).rejects.toThrow();
  });

  it('после возврата денег право на первый период возвращается', async () => {
    // Периода человек не получил — значит скидка ему по-прежнему
    // положена, и второй промо-счёт законен.
    const invoice = await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 9_900,
      currency: 'RUB',
      ref: 'вернули-промо',
      promoCode: 'BLOGGER7',
    });

    await markInvoicePaid(testDb(), { id: invoice.id, now: new Date() });
    await markInvoiceRefunded(testDb(), { id: invoice.id, now: new Date() });

    await expect(
      createInvoice(testDb(), {
        provider: 'robokassa:smz',
        userId,
        plan: 'monthly',
        kind: 'initial',
        amountMinor: 9_900,
        currency: 'RUB',
        ref: 'снова-промо',
        promoCode: 'BLOGGER7',
      }),
    ).resolves.toBeDefined();
  });

  it('обычная покупка без кода запретом не задета', async () => {
    // Индекс частичный: он про промо-счёта, а не про все.
    const provider = fakeProvider('robokassa:smz');

    for (let index = 0; index < 3; index += 1) {
      await startCheckout(testDb(), {
        userId,
        tgId: 4_500_001,
        plan: 'monthly',
        rail: 'robokassa:smz',
        settings,
        provider,
        title: 'ВЫДОХ, месяц',
        description: 'Подписка',
      });
    }

    expect(await testDb().select().from(billingInvoices)).toHaveLength(3);
  });
});
