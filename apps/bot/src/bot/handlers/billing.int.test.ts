import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  appSettings,
  billingEvents,
  billingInvoices,
  billingSubscriptions,
  users,
} from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { createInvoice, subscriptionOf } from '../../modules/billing/billing.repo.js';
import type { PaymentProvider } from '../../modules/billing/provider.js';
import { createStarsProvider } from '../../modules/billing/providers/stars.js';
import type { Rail } from '../../modules/billing/tariffs.js';
import { putSetting, SettingsRegistry } from '../../modules/settings/settings.repo.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { testDb } from '../../test/db.js';
import { defaultTexts } from '../../texts/index.js';
import { BILLING_ACTION, registerBillingHandlers } from './billing.js';

/**
 * Экран подписки и приём звёздной оплаты (§14 ТЗ, задача 4.2).
 *
 * Три вещи проверяются здесь и больше нигде.
 *
 * 1. **Кнопки не обещают того, чего нет.** Тариф без цены и рельс без
 *    провайдера не показываются вовсе: кнопка «оплатить», которая
 *    отвечает отказом в момент нажатия, хуже отсутствующей.
 * 2. **Оговорка про автопродление уходит вместе со ссылкой**, и берётся
 *    она у провайдера. Человек, узнавший о списании из банка, перестаёт
 *    доверять не кнопке, а продукту.
 * 3. **`pre_checkout_query` получает ответ.** Не ответить за десять
 *    секунд — значит не получить платёж вовсе, и человек увидит отказ
 *    без объяснений.
 *
 * Оплата звёздами приходит сюда апдейтом, а не вебхуком — как голосовые.
 * Поэтому проверяется она тоже здесь: у рельса такой транспорт.
 */

const logger = createLogger({ level: 'silent' });
const TG_ID = 7480;

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

let seq = 0;
let userId = '';
let settings: SettingsRegistry;

/** Провайдер-заглушка: отдаёт ссылку и помнит, о чём просили. */
function fakeProvider(params: {
  readonly name: Rail;
  readonly autoRenews: boolean;
  readonly onStop?: () => void;
  readonly stopFails?: boolean;
}): PaymentProvider & { readonly checkouts: unknown[] } {
  const checkouts: unknown[] = [];

  return {
    name: params.name,
    checkouts,
    createCheckout: (request) => {
      checkouts.push(request);
      return Promise.resolve({
        url: `https://оплата.тест/${request.ref}`,
        autoRenews: params.autoRenews,
      });
    },
    readEvent: () => Promise.resolve(undefined),
    stopRenewal: () => {
      if (params.stopFails === true) return Promise.reject(new Error('провайдер молчит'));

      params.onStop?.();
      return Promise.resolve();
    },
    statusOf: () => Promise.resolve(undefined),
  };
}

function createTestBot(providers: Partial<Record<Rail, PaymentProvider>>): {
  bot: Bot;
  calls: ApiCall[];
} {
  const botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'ВЫДОХ',
    username: 'vydoh_test_bot',
  } as unknown as UserFromGetMe;

  const bot = new Bot('123456789:TESTTESTTESTTESTTESTTESTTESTTEST', { botInfo });
  const calls: ApiCall[] = [];

  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });

    const result =
      method === 'answerCallbackQuery' || method === 'answerPreCheckoutQuery'
        ? true
        : { message_id: calls.length, date: 0, chat: { id: TG_ID, type: 'private' } };

    return Promise.resolve({ ok: true, result } as never);
  });

  registerBillingHandlers(bot, { db: testDb(), settings, logger, providers });

  return { bot, calls };
}

function callbackUpdate(data: string): Update {
  seq += 1;

  return {
    update_id: 748_000 + seq,
    callback_query: {
      id: String(seq),
      from: { id: TG_ID, is_bot: false, first_name: 'Нина' },
      chat_instance: '1',
      data,
      message: {
        message_id: seq,
        date: 0,
        chat: { id: TG_ID, type: 'private', first_name: 'Нина' },
      },
    },
  } as unknown as Update;
}

function commandUpdate(text: string): Update {
  seq += 1;

  return {
    update_id: 748_000 + seq,
    message: {
      message_id: seq,
      date: 0,
      chat: { id: TG_ID, type: 'private', first_name: 'Нина' },
      from: { id: TG_ID, is_bot: false, first_name: 'Нина' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  } as unknown as Update;
}

function sent(calls: readonly ApiCall[]): ApiCall[] {
  return calls.filter((call) => call.method === 'sendMessage');
}

function textOf(call: ApiCall | undefined): string {
  const value = call?.payload['text'];

  return typeof value === 'string' ? value : '';
}

function buttonsOf(
  call: ApiCall | undefined,
): { text: string; callback_data?: string; url?: string }[] {
  const markup = call?.payload['reply_markup'] as
    { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] } | undefined;

  return (markup?.inline_keyboard ?? []).flat();
}

beforeEach(async () => {
  await testDb().delete(billingEvents);
  await testDb().delete(billingSubscriptions);
  await testDb().delete(billingInvoices);
  await testDb().delete(appSettings);
  await testDb().delete(users);

  const person = await upsertUser(testDb(), { tgId: TG_ID, firstName: 'Нина' });
  userId = person.id;

  settings = new SettingsRegistry({ db: testDb(), logger, ttlMs: 0 });
});

describe('экран подписки показывает только то, что продаётся', () => {
  it('без назначенной цены кнопок нет вовсе', async () => {
    /**
     * Цена задаётся в панели (§15.3), и до её назначения продавать
     * нечего. Кнопка «оплатить» при нулевой цене означала бы либо
     * бесплатную подписку, либо отказ в момент нажатия.
     */
    const { bot, calls } = createTestBot({
      'robokassa:smz': fakeProvider({ name: 'robokassa:smz', autoRenews: true }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(BILLING_ACTION.open));

    expect(textOf(sent(calls)[0])).toBe(defaultTexts.billing.noPrice);
    expect(buttonsOf(sent(calls)[0])).toEqual([]);
  });

  it('рельс без провайдера не показывается, даже если цена задана', async () => {
    /**
     * Цену можно назначить обоим рельсам из панели, а включаются они
     * переменными запуска. Показать звёзды при выключенных звёздах —
     * значит показать кнопку, за которой ничего нет.
     */
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });
    await putSetting(testDb(), { name: 'priceMonthlyStars', value: '150' });

    const { bot, calls } = createTestBot({
      'robokassa:smz': fakeProvider({ name: 'robokassa:smz', autoRenews: true }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(BILLING_ACTION.open));

    const labels = buttonsOf(sent(calls)[0]).map((one) => one.text);

    expect(labels).toEqual([`Месяц — 399 ₽ · ${defaultTexts.billing.payByCard}`]);
  });

  it('оба рельса с ценой дают четыре кнопки', async () => {
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });
    await putSetting(testDb(), { name: 'priceYearlyRub', value: '399000' });
    await putSetting(testDb(), { name: 'priceMonthlyStars', value: '150' });
    await putSetting(testDb(), { name: 'priceYearlyStars', value: '1500' });

    const { bot, calls } = createTestBot({
      'robokassa:smz': fakeProvider({ name: 'robokassa:smz', autoRenews: true }),
      'telegram:stars': fakeProvider({ name: 'telegram:stars', autoRenews: true }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(BILLING_ACTION.open));

    expect(buttonsOf(sent(calls)[0]).map((one) => one.text)).toEqual([
      `Месяц — 399 ₽ · ${defaultTexts.billing.payByCard}`,
      `Год — 3990 ₽ · ${defaultTexts.billing.payByCard}`,
      `Месяц — 150 ⭐ · ${defaultTexts.billing.payByStars}`,
      `Год — 1500 ⭐ · ${defaultTexts.billing.payByStars}`,
    ]);
  });

  it('у платящего видно срок и кнопка отмены', async () => {
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });

    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'robokassa:smz',
        userId,
        plan: 'monthly',
        autoRenew: true,
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 3_600_000),
      });

    const { bot, calls } = createTestBot({
      'robokassa:smz': fakeProvider({ name: 'robokassa:smz', autoRenews: true }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(BILLING_ACTION.open));

    expect(textOf(sent(calls)[0])).toContain('Подписка активна до');

    const cancel = buttonsOf(sent(calls)[0])[0];

    expect(cancel?.text).toBe(defaultTexts.billing.buttonCancel);
    expect(cancel?.callback_data).toBe(BILLING_ACTION.cancel);
  });

  it('при отключённом продлении кнопки отмены нет, а тарифы остаются', async () => {
    /**
     * Не «уже оплачено, приходите потом»: отменённое продление включают
     * обратно новой оплатой, и с месячного тарифа переходят на годовой.
     * Убери кнопки — оба пути пришлось бы просить словами.
     */
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });

    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'robokassa:smz',
        userId,
        plan: 'monthly',
        autoRenew: false,
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 3_600_000),
      });

    const { bot, calls } = createTestBot({
      'robokassa:smz': fakeProvider({ name: 'robokassa:smz', autoRenews: true }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(BILLING_ACTION.open));

    const labels = buttonsOf(sent(calls)[0]).map((one) => one.text);

    expect(labels).not.toContain(defaultTexts.billing.buttonCancel);
    expect(labels).toHaveLength(1);
  });
});

describe('нажатие на тариф', () => {
  beforeEach(async () => {
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });
    await putSetting(testDb(), { name: 'priceYearlyStars', value: '1500' });
  });

  it('счёт заводится, ссылка уходит кнопкой', async () => {
    const provider = fakeProvider({ name: 'robokassa:smz', autoRenews: true });
    const { bot, calls } = createTestBot({ 'robokassa:smz': provider });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${BILLING_ACTION.buyPrefix}r:monthly`));

    const [invoice] = await testDb().select().from(billingInvoices);

    expect(invoice?.provider).toBe('robokassa:smz');
    expect(invoice?.amountMinor).toBe(39_900);
    // Номер счёта — только рублёвому рельсу: по нему пойдёт продление.
    expect(invoice?.invId).not.toBeNull();

    const link = buttonsOf(sent(calls)[0])[0];

    expect(link?.text).toBe(defaultTexts.billing.buttonPay);
    expect(link?.url).toBe(`https://оплата.тест/${String(invoice?.ref)}`);
  });

  it('обещание провайдера про продление записывается на счёт', async () => {
    /**
     * **Ключевая проверка.** Прежде автопродление выводилось из тарифа, и
     * догадка была неверна на обоих рельсах. Правду знает провайдер и
     * говорит её здесь — значит здесь её и надо запомнить, иначе к
     * моменту оплаты её уже не спросить.
     */
    const { bot } = createTestBot({
      'robokassa:smz': fakeProvider({ name: 'robokassa:smz', autoRenews: false }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${BILLING_ACTION.buyPrefix}r:monthly`));

    const [invoice] = await testDb().select().from(billingInvoices);

    expect(invoice?.autoRenew).toBe(false);
  });

  it('оговорка про продление уходит вместе со ссылкой, а не отдельно', async () => {
    // Отдельной репликой её прочитают уже после оплаты — то есть поздно.
    const { bot, calls } = createTestBot({
      'robokassa:smz': fakeProvider({ name: 'robokassa:smz', autoRenews: true }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${BILLING_ACTION.buyPrefix}r:monthly`));

    expect(textOf(sent(calls)[0])).toContain(defaultTexts.billing.renewNote);
    expect(sent(calls)).toHaveLength(1);
  });

  it('разовый платёж назван разовым', async () => {
    const { bot, calls } = createTestBot({
      'telegram:stars': fakeProvider({ name: 'telegram:stars', autoRenews: false }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${BILLING_ACTION.buyPrefix}s:yearly`));

    expect(textOf(sent(calls)[0])).toContain(defaultTexts.billing.oneTimeNote);
    expect(textOf(sent(calls)[0])).not.toContain(defaultTexts.billing.renewNote);
  });

  it('кнопка выключенного рельса не роняет и не молчит', async () => {
    /**
     * Кнопка живёт в старом сообщении, а рельс с тех пор выключили.
     * Молчание здесь читается как поломка бота.
     */
    const { bot, calls } = createTestBot({
      'robokassa:smz': fakeProvider({ name: 'robokassa:smz', autoRenews: true }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${BILLING_ACTION.buyPrefix}s:monthly`));

    expect(textOf(sent(calls)[0])).toBe(defaultTexts.billing.checkoutFailed);
  });

  it('упавший провайдер не оставляет человека без ответа', async () => {
    const broken: PaymentProvider = {
      name: 'robokassa:smz',
      createCheckout: () => Promise.reject(new Error('Робокасса молчит')),
      readEvent: () => Promise.resolve(undefined),
      stopRenewal: () => Promise.resolve(),
      statusOf: () => Promise.resolve(undefined),
    };

    const { bot, calls } = createTestBot({ 'robokassa:smz': broken });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${BILLING_ACTION.buyPrefix}r:monthly`));

    expect(textOf(sent(calls)[0])).toBe(defaultTexts.billing.checkoutFailed);
  });
});

describe('отмена продления — §14 «в один тап»', () => {
  beforeEach(async () => {
    await putSetting(testDb(), { name: 'priceMonthlyRub', value: '39900' });

    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'robokassa:smz',
        userId,
        plan: 'monthly',
        autoRenew: true,
        subscriptionRef: 'способ-оплаты-1',
        currentPeriodEnd: new Date('2026-10-07T10:00:00.000Z'),
      });
  });

  it('один тап отключает продление и оставляет доступ до конца периода', async () => {
    let stopped = false;

    const { bot, calls } = createTestBot({
      'robokassa:smz': fakeProvider({
        name: 'robokassa:smz',
        autoRenews: true,
        onStop: () => {
          stopped = true;
        },
      }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(BILLING_ACTION.cancel));

    expect(stopped).toBe(true);

    const subscription = await subscriptionOf(testDb(), { userId, provider: 'robokassa:smz' });

    expect(subscription?.autoRenew).toBe(false);
    // Срок не тронут: §14 велит сохранить оплаченное.
    expect(subscription?.currentPeriodEnd.toISOString()).toBe('2026-10-07T10:00:00.000Z');

    expect(textOf(sent(calls)[0])).toBe(defaultTexts.billing.renewalStopped('7 октября 2026 г.'));
  });

  it('молчащий провайдер НЕ даёт отменить у себя', async () => {
    /**
     * **Порядок здесь и есть проверка.** Отмени мы сначала у себя —
     * человек увидел бы «продление отключено» при живом автосписании, и
     * деньги ушли бы через месяц. Провайдер не смог — не отменяем и мы,
     * и говорим об этом, а не молчим.
     */
    const { bot, calls } = createTestBot({
      'robokassa:smz': fakeProvider({
        name: 'robokassa:smz',
        autoRenews: true,
        stopFails: true,
      }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(BILLING_ACTION.cancel));

    expect((await subscriptionOf(testDb(), { userId, provider: 'robokassa:smz' }))?.autoRenew).toBe(
      true,
    );

    expect(textOf(sent(calls)[0])).toBe(defaultTexts.billing.checkoutFailed);
  });

  it('отменять нечего — это не ошибка', async () => {
    await testDb().delete(billingSubscriptions);

    const { bot, calls } = createTestBot({
      'robokassa:smz': fakeProvider({ name: 'robokassa:smz', autoRenews: true }),
    });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(BILLING_ACTION.cancel));

    expect(textOf(sent(calls)[0])).toBe(defaultTexts.billing.nothingToCancel);
  });
});

describe('оплата звёздами приходит апдейтом', () => {
  const stars = () => createStarsProvider({ api: { createInvoiceLink: () => '' } as never });

  async function starsInvoice(ref: string): Promise<void> {
    await createInvoice(testDb(), {
      provider: 'telegram:stars',
      userId,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 150,
      currency: 'XTR',
      ref,
      autoRenew: true,
    });
  }

  function paymentUpdate(params: { readonly ref: string; readonly charge: string }): Update {
    seq += 1;

    return {
      update_id: 749_000 + seq,
      message: {
        message_id: seq,
        date: 0,
        chat: { id: TG_ID, type: 'private', first_name: 'Нина' },
        from: { id: TG_ID, is_bot: false, first_name: 'Нина' },
        successful_payment: {
          currency: 'XTR',
          total_amount: 150,
          invoice_payload: params.ref,
          telegram_payment_charge_id: params.charge,
          provider_payment_charge_id: params.charge,
          is_recurring: true,
          is_first_recurring: true,
        },
      },
    } as unknown as Update;
  }

  it('подтверждение платежа отвечает Telegram — иначе платежа не будет', async () => {
    /**
     * На `pre_checkout_query` надо ответить за десять секунд. Не ответили
     * — платёж не состоится вовсе, и человек увидит отказ без слов.
     */
    await starsInvoice('звёздный-1');

    const { bot, calls } = createTestBot({ 'telegram:stars': stars() });
    await bot.init();

    seq += 1;

    await bot.handleUpdate({
      update_id: 750_000 + seq,
      pre_checkout_query: {
        id: '1',
        from: { id: TG_ID, is_bot: false, first_name: 'Нина' },
        currency: 'XTR',
        total_amount: 150,
        invoice_payload: 'звёздный-1',
      },
    });

    const answer = calls.find((call) => call.method === 'answerPreCheckoutQuery');

    expect(answer?.payload['ok']).toBe(true);
  });

  it('платёж по метке, которой нет в счетах, не подтверждается', async () => {
    /**
     * Метка случайна и неугадываема, но счёт по ней мог и не завестись —
     * например если ссылку сохранили, а данные удалили. Пропустить такой
     * платёж значило бы взять деньги, которые не к чему привязать.
     */
    const { bot, calls } = createTestBot({ 'telegram:stars': stars() });
    await bot.init();

    seq += 1;

    await bot.handleUpdate({
      update_id: 750_000 + seq,
      pre_checkout_query: {
        id: '2',
        from: { id: TG_ID, is_bot: false, first_name: 'Нина' },
        currency: 'XTR',
        total_amount: 150,
        invoice_payload: 'ничей',
      },
    });

    const answer = calls.find((call) => call.method === 'answerPreCheckoutQuery');

    expect(answer?.payload['ok']).toBe(false);
  });

  it('успешная оплата продлевает подписку и человек об этом узнаёт', async () => {
    await starsInvoice('звёздный-2');

    const { bot, calls } = createTestBot({ 'telegram:stars': stars() });
    await bot.init();

    await bot.handleUpdate(paymentUpdate({ ref: 'звёздный-2', charge: 'charge-1' }));

    const subscription = await subscriptionOf(testDb(), { userId, provider: 'telegram:stars' });

    expect(subscription?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    // Ключ отмены — идентификатор первого платежа, так требует Telegram.
    expect(subscription?.subscriptionRef).toBe('charge-1');

    expect(textOf(sent(calls)[0])).toContain('Оплата прошла');
  });

  it('повторный апдейт не продлевает второй раз и не пишет второй раз', async () => {
    /**
     * Telegram повторяет апдейты при обрыве связи. Идемпотентность
     * держит уникальный ключ в базе, а человек не должен получить два
     * «спасибо» за один платёж.
     */
    await starsInvoice('звёздный-3');

    const { bot, calls } = createTestBot({ 'telegram:stars': stars() });
    await bot.init();

    const update = paymentUpdate({ ref: 'звёздный-3', charge: 'charge-2' });

    await bot.handleUpdate(update);
    await bot.handleUpdate({ ...update, update_id: 999_999 });

    expect(sent(calls)).toHaveLength(1);
    expect(await testDb().select().from(billingEvents)).toHaveLength(1);
  });

  it('звёзд пришло меньше, чем в счёте — доступа нет', async () => {
    /**
     * Через Telegram это почти невозможно: сумму называем мы. Но «почти»
     * здесь не аргумент — проверка стоит один разбор, а её отсутствие
     * однажды стоит месяца за одну звезду. Человеку отвечаем тем же,
     * чем при неудаче оплаты: разбирать будем руками.
     */
    await starsInvoice('звёздный-мало');

    const { bot, calls } = createTestBot({ 'telegram:stars': stars() });
    await bot.init();

    seq += 1;

    await bot.handleUpdate({
      update_id: 752_000 + seq,
      message: {
        message_id: seq,
        date: 0,
        chat: { id: TG_ID, type: 'private', first_name: 'Нина' },
        from: { id: TG_ID, is_bot: false, first_name: 'Нина' },
        successful_payment: {
          currency: 'XTR',
          total_amount: 1,
          invoice_payload: 'звёздный-мало',
          telegram_payment_charge_id: 'charge-мало',
          provider_payment_charge_id: 'charge-мало',
        },
      },
    } as unknown as Update);

    expect(await subscriptionOf(testDb(), { userId, provider: 'telegram:stars' })).toBeUndefined();
    expect(textOf(sent(calls)[0])).toBe(defaultTexts.billing.checkoutFailed);
  });

  it('отписка через Telegram снимает автопродление у нас', async () => {
    /**
     * Единственный способ узнать об отмене средствами Telegram —
     * отдельный апдейт `subscription`. Без него мы продолжали бы
     * показывать человеку «продлевается сама».
     */
    await starsInvoice('звёздный-4');

    const { bot } = createTestBot({ 'telegram:stars': stars() });
    await bot.init();

    await bot.handleUpdate(paymentUpdate({ ref: 'звёздный-4', charge: 'charge-3' }));

    seq += 1;

    await bot.handleUpdate({
      update_id: 751_000 + seq,
      subscription: {
        user: { id: TG_ID, is_bot: false, first_name: 'Нина' },
        invoice_payload: 'звёздный-4',
        state: 'canceled',
      },
    } as unknown as Update);

    const subscription = await subscriptionOf(testDb(), { userId, provider: 'telegram:stars' });

    expect(subscription?.autoRenew).toBe(false);
    // Доступ остаётся: человек заплатил за период.
    expect(subscription?.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('команды, которых требуют правила Telegram', () => {
  it('/paysupport отвечает', async () => {
    const { bot, calls } = createTestBot({});
    await bot.init();

    await bot.handleUpdate(commandUpdate('/paysupport'));

    expect(textOf(sent(calls)[0])).toBe(defaultTexts.billing.paySupport);
  });

  it('/terms и /support отвечают об условиях', async () => {
    const { bot, calls } = createTestBot({});
    await bot.init();

    await bot.handleUpdate(commandUpdate('/terms'));
    await bot.handleUpdate(commandUpdate('/support'));

    expect(sent(calls).map(textOf)).toEqual([
      defaultTexts.billing.terms,
      defaultTexts.billing.terms,
    ]);
  });
});
