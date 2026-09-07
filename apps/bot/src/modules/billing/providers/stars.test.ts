import { describe, expect, it } from 'vitest';

import { PermanentError, TransientError } from '../../../infra/failures.js';
import { createStarsProvider, refundStars, STARS_PERIOD_SECONDS } from './stars.js';

/**
 * Telegram Stars (§14 ТЗ, задача 4.2) — второй, обязательный рельс.
 *
 * Проверяется то, чего нельзя увидеть на живом Telegram без настоящих
 * денег: состав счёта, разбор трёх служебных сообщений и честность
 * ответов там, где Bot API правды не знает.
 *
 * **Главные две проверки — про обещания.** Годовой тариф в звёздах
 * автопродлением не бывает, и провайдер обязан это сказать; а
 * идентификатор для отмены берётся у **первого** платежа, а не у
 * последнего продления — перезапиши мы его, отмена сломалась бы ровно у
 * тех, кто платит давно.
 */

/** Заглушка Bot API: запоминает, о чём просили. */
function api(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];

  return {
    calls,
    createInvoiceLink: (...args: unknown[]) => {
      calls.push({ method: 'createInvoiceLink', args });
      return Promise.resolve('https://t.me/invoice/abc');
    },
    editUserStarSubscription: (...args: unknown[]) => {
      calls.push({ method: 'editUserStarSubscription', args });
      return Promise.resolve(true);
    },
    refundStarPayment: (...args: unknown[]) => {
      calls.push({ method: 'refundStarPayment', args });
      return Promise.resolve(true);
    },
    getStarTransactions: () => Promise.resolve({ transactions: [] }),
    ...overrides,
  };
}

const CHECKOUT = {
  userId: 'u1',
  tgId: 42,
  amount: 150,
  currency: 'XTR',
  ref: 'ref-1',
  title: 'Подписка на месяц',
  description: 'Месяц ВЫДОХа',
} as const;

describe('счёт в звёздах', () => {
  it('месячный тариф — подписка на тридцать суток', async () => {
    const stub = api();
    const provider = createStarsProvider({ api: stub as never });

    const checkout = await provider.createCheckout({ ...CHECKOUT, plan: 'monthly' });

    expect(checkout.url).toBe('https://t.me/invoice/abc');
    expect(checkout.autoRenews).toBe(true);

    const [call] = stub.calls;
    expect(call?.method).toBe('createInvoiceLink');
    // Пустая строка вместо токена провайдера — так просит Bot API.
    expect(call?.args[3]).toBe('');
    expect(call?.args[4]).toBe('XTR');
    expect(call?.args[6]).toEqual({ subscription_period: STARS_PERIOD_SECONDS });
  });

  it('годовой тариф автопродлением не бывает — и это сказано честно', async () => {
    /**
     * `subscription_period` в Bot API обязан быть тридцатидневным, других
     * значений нет. Пообещать по годовому счёту продление значило бы
     * соврать человеку в самом дорогом месте.
     */
    const stub = api();
    const provider = createStarsProvider({ api: stub as never });

    const checkout = await provider.createCheckout({ ...CHECKOUT, plan: 'yearly', amount: 1_500 });

    expect(checkout.autoRenews).toBe(false);
    expect(stub.calls[0]?.args[6]).toEqual({});
  });

  it('метка длиннее 128 байт отвергается, а не обрезается', async () => {
    /**
     * Байт, а не символов: кириллическая метка вдвое тяжелее. Обрезанная
     * метка означала бы платёж, который не к чему привязать, — то есть
     * человека, заплатившего и не получившего доступ.
     */
    const provider = createStarsProvider({ api: api() as never });

    await expect(
      provider.createCheckout({ ...CHECKOUT, plan: 'monthly', ref: 'я'.repeat(65) }),
    ).rejects.toThrow(PermanentError);
  });

  it('слишком дорогая подписка отвергается до отправки', async () => {
    // Потолок подписки в звёздах — 10 000. Узнать об этом от Telegram уже
    // после нажатия кнопки хуже, чем не показать кнопку.
    const provider = createStarsProvider({ api: api() as never });

    await expect(
      provider.createCheckout({ ...CHECKOUT, plan: 'monthly', amount: 10_001 }),
    ).rejects.toThrow(PermanentError);
  });

  it('рубли сюда не принимаются', async () => {
    const provider = createStarsProvider({ api: api() as never });

    await expect(
      provider.createCheckout({ ...CHECKOUT, plan: 'monthly', currency: 'RUB' }),
    ).rejects.toThrow(PermanentError);
  });

  it('длинные название и описание обрезаются по пределам Telegram', async () => {
    const stub = api();
    const provider = createStarsProvider({ api: stub as never });

    await provider.createCheckout({
      ...CHECKOUT,
      plan: 'monthly',
      title: 'о'.repeat(60),
      description: 'о'.repeat(400),
    });

    expect(String(stub.calls[0]?.args[0]).length).toBeLessThanOrEqual(32);
    expect(String(stub.calls[0]?.args[1]).length).toBeLessThanOrEqual(255);
  });

  it('недоступность Telegram — временный сбой, счёт можно выставить снова', async () => {
    const provider = createStarsProvider({
      api: api({ createInvoiceLink: () => Promise.reject(new Error('502')) }) as never,
    });

    await expect(provider.createCheckout({ ...CHECKOUT, plan: 'monthly' })).rejects.toThrow(
      TransientError,
    );
  });
});

describe('служебные сообщения', () => {
  const provider = createStarsProvider({ api: api() as never });

  it('первая оплата подписки: продлением не считается, ключ отмены сохраняется', async () => {
    const event = await provider.readEvent({
      message: {
        successful_payment: {
          currency: 'XTR',
          total_amount: 150,
          invoice_payload: 'ref-1',
          telegram_payment_charge_id: 'charge-первый',
          is_recurring: true,
          is_first_recurring: true,
          subscription_expiration_date: 1_800_000_000,
        },
      },
    });

    expect(event).toEqual({
      kind: 'paid',
      externalId: 'charge-первый',
      ref: 'ref-1',
      amount: 150,
      currency: 'XTR',
      renewal: false,
      paidUntil: new Date(1_800_000_000 * 1000),
      subscriptionRef: 'charge-первый',
    });
  });

  it('продление ключа отмены НЕ приносит — и это главное', async () => {
    /**
     * Telegram требует отменять подписку идентификатором **первого**
     * платежа. Отдай мы здесь идентификатор продления, он перезаписал бы
     * сохранённый, и кнопка «отключить продление» перестала бы работать
     * ровно у тех, кто платит дольше всех.
     */
    const event = await provider.readEvent({
      message: {
        successful_payment: {
          currency: 'XTR',
          total_amount: 150,
          invoice_payload: 'ref-1',
          telegram_payment_charge_id: 'charge-второй',
          is_recurring: true,
        },
      },
    });

    expect(event?.kind === 'paid' ? event.renewal : undefined).toBe(true);
    expect(event?.kind === 'paid' ? event.subscriptionRef : 'есть').toBeUndefined();
  });

  it('разовая оплата без признаков продления — тоже первый платёж', async () => {
    // Годовой тариф: `is_recurring` не приходит вовсе.
    const event = await provider.readEvent({
      message: {
        successful_payment: {
          currency: 'XTR',
          total_amount: 1_500,
          invoice_payload: 'ref-год',
          telegram_payment_charge_id: 'charge-год',
        },
      },
    });

    expect(event?.kind === 'paid' ? event.renewal : undefined).toBe(false);
    expect(event?.kind === 'paid' ? event.subscriptionRef : undefined).toBe('charge-год');
  });

  it('человек отписался — приходит апдейт подписки', async () => {
    /**
     * Единственный способ узнать об отмене: отдельный апдейт
     * `subscription`. Без него мы продолжали бы считать, что продление
     * включено, и показывали бы человеку неправду.
     */
    expect(
      await provider.readEvent({ subscription: { invoice_payload: 'ref-1', state: 'canceled' } }),
    ).toEqual({ kind: 'renewalStopped', ref: 'ref-1' });
  });

  it('продление не прошло — это другой случай, чем отмена', async () => {
    expect(
      await provider.readEvent({ subscription: { invoice_payload: 'ref-1', state: 'failed' } }),
    ).toEqual({ kind: 'renewalFailed', ref: 'ref-1' });
  });

  it('«включил обратно» мы не выдумываем в событие', async () => {
    // Подписка оживёт следующим успешным платежом; придумывать для этого
    // отдельный вид события значило бы менять состояние без денег.
    expect(
      await provider.readEvent({ subscription: { invoice_payload: 'ref-1', state: 'active' } }),
    ).toBeUndefined();
  });

  it('возврат звёзд разбирается', async () => {
    expect(
      await provider.readEvent({
        message: {
          refunded_payment: {
            currency: 'XTR',
            total_amount: 150,
            invoice_payload: 'ref-1',
            telegram_payment_charge_id: 'charge-первый',
          },
        },
      }),
    ).toEqual({
      kind: 'refunded',
      externalId: 'charge-первый',
      ref: 'ref-1',
      amount: 150,
      currency: 'XTR',
    });
  });

  it('обычное сообщение — не платёж', async () => {
    expect(await provider.readEvent({ message: { text: 'привет' } })).toBeUndefined();
    expect(await provider.readEvent(undefined)).toBeUndefined();
  });

  it('оплата без метки отвергается: непонятно, кому продлевать', async () => {
    await expect(
      provider.readEvent({
        message: { successful_payment: { total_amount: 150, telegram_payment_charge_id: 'c' } },
      }),
    ).rejects.toThrow(PermanentError);
  });
});

describe('отмена и возврат', () => {
  it('отмена зовёт Telegram с идентификатором первого платежа', async () => {
    const stub = api();
    const provider = createStarsProvider({ api: stub as never });

    await provider.stopRenewal({ tgId: 42, subscriptionRef: 'charge-первый' });

    expect(stub.calls[0]?.method).toBe('editUserStarSubscription');
    expect(stub.calls[0]?.args).toEqual([42, 'charge-первый', true]);
  });

  it('возврат зовёт свой метод и не притворяется частью интерфейса', async () => {
    const stub = api();

    await refundStars({ api: stub as never }, { tgId: 42, chargeId: 'charge-первый' });

    expect(stub.calls[0]?.method).toBe('refundStarPayment');
  });
});

describe('состояние подписки Telegram не отдаёт', () => {
  it('не нашли платёж в последних операциях — отвечаем «не знаю»', async () => {
    /**
     * Не «неактивна». Список транзакций конечен, и старый платёж в него
     * не попадёт; вернуть «неактивна» значило бы отобрать доступ у
     * платящего только потому, что он платит давно.
     */
    const provider = createStarsProvider({ api: api() as never });

    expect(await provider.statusOf({ tgId: 42, subscriptionRef: 'charge-старый' })).toBeUndefined();
  });

  it('нашли — значит платёж был', async () => {
    const provider = createStarsProvider({
      api: api({
        getStarTransactions: () => Promise.resolve({ transactions: [{ id: 'charge-первый' }] }),
      }) as never,
    });

    expect(await provider.statusOf({ tgId: 42, subscriptionRef: 'charge-первый' })).toEqual({
      active: true,
    });
  });
});
