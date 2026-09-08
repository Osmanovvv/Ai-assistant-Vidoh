import { describe, expect, it } from 'vitest';

import { MockPaymentProvider } from './providers/mock.js';
import type { Checkout, CheckoutParams, PaymentEvent, PaymentProvider } from './provider.js';

/**
 * Интерфейс провайдера оплаты (§14 ТЗ, задача 4.1).
 *
 * План ставит условие готовности так: «добавление второго провайдера не
 * требует правок вне папки `providers`». Проверить это можно только
 * вторым провайдером — поэтому он здесь и написан, прямо в тесте, и
 * прямо в тесте же живёт тот, кто их обоих использует.
 *
 * Иначе получилась бы форма, выведенная из одного воображаемого
 * провайдера. Проект такое уже проходил: код был написан, покрыт
 * тестами и недостижим.
 */

/**
 * Второй провайдер: подписки не умеет вовсе, платит разово.
 *
 * Взят не с потолка. Годовой тариф в Stars автопродлением быть не может
 * (`subscription_period` в Bot API обязан быть тридцатидневным), а
 * внешний чекаут по §14 наоборот держит способ оплаты сам. То есть
 * «умеет продление» — настоящая точка расхождения двух провайдеров, и
 * интерфейс обязан переживать оба ответа.
 */
class OneOffProvider implements PaymentProvider {
  readonly name = 'разовый:тест';

  createCheckout(params: CheckoutParams): Promise<Checkout> {
    return Promise.resolve({ url: `https://разовый.тест/${params.ref}`, autoRenews: false });
  }

  readEvent(raw: unknown): Promise<PaymentEvent | undefined> {
    if (typeof raw !== 'object' || raw === null) return Promise.resolve(undefined);

    const body = raw as { charge?: unknown; ref?: unknown };
    if (typeof body.charge !== 'string' || typeof body.ref !== 'string') {
      return Promise.resolve(undefined);
    }

    return Promise.resolve({
      kind: 'paid',
      externalId: body.charge,
      ref: body.ref,
      amount: 100,
      currency: 'RUB',
      renewal: false,
    });
  }

  stopRenewal(): Promise<void> {
    // Продлевать нечего: разовый платёж сам не повторяется.
    return Promise.resolve();
  }

  statusOf(): Promise<{ active: boolean; autoRenews: boolean }> {
    return Promise.resolve({ active: true, autoRenews: false });
  }
}

/**
 * Тот, кто пользуется провайдером, — в одном экземпляре на оба.
 *
 * Это и есть проверяемое условие: если бы интерфейс протекал, здесь
 * появилось бы «если Stars, то…».
 */
async function offerPayment(
  provider: PaymentProvider,
  params: CheckoutParams,
): Promise<{ url: string; promisesRenewal: boolean; provider: string }> {
  const checkout = await provider.createCheckout(params);

  return {
    url: checkout.url,
    // Бот обещает продление только тогда, когда оно будет: обещание,
    // которого провайдер не выполнит, хуже отсутствия обещания.
    promisesRenewal: checkout.autoRenews,
    provider: provider.name,
  };
}

const asked: CheckoutParams = {
  userId: 'человек-1',
  tgId: 12_345,
  plan: 'monthly',
  amount: 500,
  currency: 'XTR',
  ref: 'подписка:месяц:человек-1',
  title: 'ВЫДОХ на месяц',
  description: 'Разбор мыслей и напоминания',
};

describe('интерфейс провайдера оплаты', () => {
  it('двух разных провайдеров использует один и тот же код', async () => {
    const first = await offerPayment(new MockPaymentProvider({ name: 'звёзды:тест' }), asked);
    const second = await offerPayment(new OneOffProvider(), asked);

    // Оба дали место оплаты и назвали себя — больше вызывающему знать
    // о них нечего.
    expect(first.url).toContain('подписка:месяц:человек-1');
    expect(second.url).toContain('подписка:месяц:человек-1');
    expect(first.provider).toBe('звёзды:тест');
    expect(second.provider).toBe('разовый:тест');
  });

  it('обещание продления идёт от провайдера, а не от тарифа', async () => {
    /**
     * Ровно то место, где §14 расходится с Bot API: месячный тариф у
     * одного продлевается сам, у другого — нет. Если бы бот выводил это
     * из тарифа, он обещал бы человеку продление, которого не будет.
     */
    const stars = await offerPayment(new MockPaymentProvider(), asked);
    const oneOff = await offerPayment(new OneOffProvider(), asked);

    expect(stars.promisesRenewal).toBe(true);
    expect(oneOff.promisesRenewal).toBe(false);
  });

  it('продление обещает провайдер, а не наша догадка про тариф', async () => {
    /**
     * **Переписано ревизией четвёртого этапа.** Прежде проверка
     * называлась «годовой тариф не обещает продления там, где его не
     * бывает» и держалась на догадке **заглушки**: та отвечала
     * `plan === 'monthly'`. Настоящие провайдеры так не отвечают — у
     * звёзд годовой не продлевается вовсе, у Робокассы даже месячный
     * работает лишь после согласования, — то есть проверка измеряла
     * заглушку и не могла покраснеть ни от какой правки продукта.
     *
     * Проверяется то, что и должно: обещание продления приходит **от
     * провайдера**. Кто продлевает и на каком тарифе — знание рельса, и
     * у каждого рельса оно своё, проверенное своим набором.
     */
    const promises = await offerPayment(new MockPaymentProvider({ autoRenews: true }), asked);
    const doesNot = await offerPayment(new MockPaymentProvider({ autoRenews: false }), asked);

    expect(promises.promisesRenewal).toBe(true);
    expect(doesNot.promisesRenewal).toBe(false);

    // И разовый счёт не обещает продления даже у того, кто умеет: так
    // уходит промо-счёт на любом рельсе.
    const oneOff = await offerPayment(new MockPaymentProvider({ autoRenews: true }), {
      ...asked,
      renewable: false,
    });

    expect(oneOff.promisesRenewal).toBe(false);
  });

  it('счёт получает ровно то, что ему передали', async () => {
    const provider = new MockPaymentProvider();
    await offerPayment(provider, asked);

    // Цена, тариф и метка едут в счёт без изменений: метка — это то,
    // чем событие оплаты потом найдёт человека и его тариф.
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.amount).toBe(500);
    expect(provider.requests[0]?.ref).toBe('подписка:месяц:человек-1');
  });

  it('денежное событие несёт ключ от повторной обработки, а состояние — нет', async () => {
    /**
     * §14 требует защиты от повторной обработки. Ключ есть у денег и
     * только у них: выставить «продлевать не надо» дважды — то же
     * самое, что один раз, а вот продлить подписку дважды по одному
     * событию — это второй период даром.
     */
    const paid = await new MockPaymentProvider({
      event: {
        kind: 'paid',
        externalId: 'charge-1',
        ref: 'подписка:месяц:человек-1',
        amount: 500,
        currency: 'XTR',
        renewal: true,
      },
    }).readEvent({});

    const stopped = await new MockPaymentProvider({
      event: { kind: 'renewalStopped', ref: 'подписка:месяц:человек-1' },
    }).readEvent({});

    expect(paid?.kind === 'paid' ? paid.externalId : undefined).toBe('charge-1');
    expect(stopped?.kind).toBe('renewalStopped');

    // Проверка типов, а не только значения: у события состояния поля
    // `externalId` нет вовсе, и код, который его спросит, не соберётся.
    expect(stopped !== undefined && 'externalId' in stopped).toBe(false);
  });

  it('посторонний апдейт событием оплаты не считается', async () => {
    // Приём получает все сообщения; провайдер обязан отличать своё.
    expect(await new OneOffProvider().readEvent({ text: 'купить продукты' })).toBeUndefined();
    expect(await new OneOffProvider().readEvent(undefined)).toBeUndefined();
  });

  it('испорченное событие отказывает, а не выглядит посторонним', async () => {
    /**
     * §16 требует проверять подпись. Молчаливое `undefined` на не
     * сошедшейся подписи спрятало бы подделку среди обычных апдейтов —
     * и в журнале не осталось бы ничего.
     */
    const provider = new MockPaymentProvider({ failEvent: new Error('подпись не сошлась') });

    await expect(provider.readEvent({})).rejects.toThrow('подпись не сошлась');
  });

  it('отмена продления доходит до провайдера с тем, чем он её делает', async () => {
    const provider = new MockPaymentProvider();

    await provider.stopRenewal({ tgId: 12_345, subscriptionRef: 'charge-1' });

    expect(provider.stops).toEqual([{ tgId: 12_345, subscriptionRef: 'charge-1' }]);
  });
});
