import { describe, expect, it } from 'vitest';

import { PermanentError, TransientError } from '../../../infra/failures.js';
import {
  chargeRecurring,
  createRobokassaProvider,
  errorCodeOfPage,
  errorTextOf,
} from './robokassa.js';
import { resultSignature } from './robokassa-signature.js';

/**
 * Провайдер Робокассы (§14 ТЗ, задача 4.2).
 *
 * Наружу здесь не ходит ни одна проверка: платёжная страница собирается
 * ссылкой, а обращения к сети подменяются. Проверяется то, что можно
 * проверить без магазина заказчицы, — состав запроса, разбор уведомления
 * и поведение при отказе.
 *
 * **Главная проверка — подделанное уведомление.** Пропусти мы его, и
 * любой, кто знает адрес нашего ResultURL, продлевал бы себе подписку
 * бесплатно.
 */

const DEPS = {
  merchantLogin: 'выдох',
  password1: 'п1',
  password2: 'п2',
};

const provider = createRobokassaProvider(DEPS);

/** Уведомление с настоящей подписью — как пришлёт Робокасса. */
function notification(params: {
  readonly outSum: string;
  readonly invId: string;
  readonly ref: string;
  readonly kind?: 'initial' | 'renewal';
}): Record<string, string> {
  const userParams = { Shp_kind: params.kind ?? 'initial', Shp_ref: params.ref };

  return {
    OutSum: params.outSum,
    InvId: params.invId,
    ...userParams,
    SignatureValue: resultSignature({
      outSum: params.outSum,
      invId: params.invId,
      password2: DEPS.password2,
      userParams,
    }),
  };
}

describe('ссылка на оплату', () => {
  it('собирается со всем, что нужно, и с нашим номером счёта', async () => {
    const checkout = await provider.createCheckout({
      userId: 'u1',
      tgId: 42,
      plan: 'monthly',
      amount: 39_900,
      currency: 'RUB',
      ref: 'r-1',
      title: 'Подписка на месяц',
      description: 'Месяц ВЫДОХа',
      invoiceNumber: 1001,
    });

    const url = new URL(checkout.url);

    expect(url.origin + url.pathname).toBe('https://auth.robokassa.ru/Merchant/Index.aspx');
    expect(url.searchParams.get('MerchantLogin')).toBe('выдох');
    expect(url.searchParams.get('OutSum')).toBe('399.00');
    expect(url.searchParams.get('InvId')).toBe('1001');
    expect(url.searchParams.get('Shp_ref')).toBe('r-1');
    expect(url.searchParams.get('SignatureValue')).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('без нашего номера счёт не собирается вовсе', async () => {
    /**
     * Ноль и пустое значение означают у Робокассы «назначу номер сам», и
     * тогда наш номер окажется мёртвым — а через месяц продление уйдёт в
     * пустоту у всех разом. Лучше отказать здесь.
     */
    await expect(
      provider.createCheckout({
        userId: 'u1',
        tgId: 42,
        plan: 'monthly',
        amount: 39_900,
        currency: 'RUB',
        ref: 'r-2',
        title: 'Подписка',
        description: 'Месяц',
      }),
    ).rejects.toThrow(PermanentError);
  });

  it('звёзды сюда не принимаются', async () => {
    await expect(
      provider.createCheckout({
        userId: 'u1',
        tgId: 42,
        plan: 'monthly',
        amount: 150,
        currency: 'XTR',
        ref: 'r-3',
        title: 'Подписка',
        description: 'Месяц',
        invoiceNumber: 1002,
      }),
    ).rejects.toThrow(PermanentError);
  });

  it('на НЕсогласованном магазине Recurring не просится вовсе', async () => {
    /**
     * **Проверка переписана на ревизии четвёртого этапа: прежняя
     * утверждала дефект.** Она требовала `Recurring=true` от провайдера
     * с настройками по умолчанию — то есть от магазина, у которого
     * услуга не согласована.
     *
     * А там `Recurring=true` падает кодом 34 **после** нажатия кнопки:
     * купить месяц было нельзя вовсе, годовой при этом работал. Отказ
     * выглядел бы как «у меня почему-то не проходит оплата», и искать
     * его пришлось бы в переписке с провайдером.
     *
     * Согласование выключено по умолчанию нарочно (`RK_RECURRING=off`):
     * обещать то, чего не проверяли, дороже, чем не обещать. Значит и
     * запрос по умолчанию обязан быть разовым.
     */
    const checkout = await provider.createCheckout({
      userId: 'u1',
      tgId: 42,
      plan: 'monthly',
      amount: 39_900,
      currency: 'RUB',
      ref: 'r-4',
      title: 'Подписка',
      description: 'Месяц',
      invoiceNumber: 1003,
    });

    expect(new URL(checkout.url).searchParams.get('Recurring')).toBeNull();
    // И человеку обещано ровно то, о чём попросили.
    expect(checkout.autoRenews).toBe(false);
  });

  it('на согласованном просится у месяца и не просится у года', async () => {
    /**
     * У годового тарифа списание раз в год без напоминания — человек за
     * год забудет, что подписывался. §14 требует автосписание, но не
     * требует делать его там, где оно вредит.
     */
    const approved = createRobokassaProvider({ ...DEPS, recurringApproved: true });

    const base = {
      userId: 'u1',
      tgId: 42,
      amount: 39_900,
      currency: 'RUB',
      title: 'Подписка',
      description: 'Период',
    } as const;

    const monthly = await approved.createCheckout({
      ...base,
      plan: 'monthly',
      ref: 'r-5',
      invoiceNumber: 1004,
    });
    const yearly = await approved.createCheckout({
      ...base,
      plan: 'yearly',
      ref: 'r-6',
      invoiceNumber: 1005,
    });

    expect(new URL(monthly.url).searchParams.get('Recurring')).toBe('true');
    expect(monthly.autoRenews).toBe(true);

    expect(new URL(yearly.url).searchParams.get('Recurring')).toBeNull();
    expect(yearly.autoRenews).toBe(false);
  });

  it('обещание человеку и содержимое запроса не расходятся', async () => {
    /**
     * Раньше это были два независимых условия: `Recurring` ставился по
     * тарифу, а `autoRenews` — по тарифу и согласованию. Разойдясь, они
     * дают либо «обещали продление, а не просили», либо «попросили
     * продление, а промолчали». Оба случая человек узнаёт из банка.
     *
     * Проверяется на всех четырёх сочетаниях: согласовано или нет,
     * промо-счёт или обычный.
     */
    const approved = createRobokassaProvider({ ...DEPS, recurringApproved: true });

    const base = {
      userId: 'u1',
      tgId: 42,
      plan: 'monthly',
      amount: 39_900,
      currency: 'RUB',
      title: 'Подписка',
      description: 'Месяц',
    } as const;

    const cases = [
      { who: provider, renewable: undefined, ref: 'r-7', invoiceNumber: 1006 },
      { who: provider, renewable: false, ref: 'r-8', invoiceNumber: 1007 },
      { who: approved, renewable: undefined, ref: 'r-9', invoiceNumber: 1008 },
      { who: approved, renewable: false, ref: 'r-10', invoiceNumber: 1009 },
    ] as const;

    for (const one of cases) {
      const checkout = await one.who.createCheckout({
        ...base,
        ref: one.ref,
        invoiceNumber: one.invoiceNumber,
        ...(one.renewable === undefined ? {} : { renewable: one.renewable }),
      });

      const asked = new URL(checkout.url).searchParams.get('Recurring') === 'true';

      expect(
        asked,
        `${one.ref}: попросили ${String(asked)}, обещали ${String(checkout.autoRenews)}`,
      ).toBe(checkout.autoRenews);
    }
  });

  it('тестовый режим виден в запросе', async () => {
    const test = createRobokassaProvider({ ...DEPS, isTest: true });

    const checkout = await test.createCheckout({
      userId: 'u1',
      tgId: 42,
      plan: 'monthly',
      amount: 39_900,
      currency: 'RUB',
      ref: 'r-7',
      title: 'Подписка',
      description: 'Месяц',
      invoiceNumber: 1006,
    });

    expect(new URL(checkout.url).searchParams.get('IsTest')).toBe('1');
  });
});

describe('уведомление об оплате', () => {
  it('настоящее разбирается в наше событие', async () => {
    const event = await provider.readEvent(
      notification({ outSum: '399.000000', invId: '1001', ref: 'r-1' }),
    );

    expect(event).toEqual({
      kind: 'paid',
      externalId: '1001',
      ref: 'r-1',
      amount: 39_900,
      currency: 'RUB',
      renewal: false,
    });
  });

  it('подделанное отвергается отказом, а не молчанием', async () => {
    /**
     * **Главная проверка провайдера.** Пропусти мы подделку — и любой,
     * кто знает адрес нашего ResultURL, продлевал бы себе подписку
     * бесплатно.
     *
     * Именно отказом, а не `undefined`: молчание означало бы, что
     * подделка выглядит как посторонний запрос и в журнал не попадает
     * (§16).
     */
    const forged = { ...notification({ outSum: '399.00', invId: '1001', ref: 'r-1' }) };
    forged['SignatureValue'] = 'а'.repeat(32);

    await expect(provider.readEvent(forged)).rejects.toThrow(PermanentError);
  });

  it('подменённая сумма ломает подпись', async () => {
    // Самая выгодная подделка: заплатить рубль, а получить месяц.
    const cheated = notification({ outSum: '399.00', invId: '1001', ref: 'r-1' });
    cheated['OutSum'] = '1.00';

    await expect(provider.readEvent(cheated)).rejects.toThrow(PermanentError);
  });

  it('дописанный пользовательский параметр тоже ломает подпись', async () => {
    // Подпись считается по ВСЕМ Shp_-параметрам: пропусти мы незнакомые,
    // подделку можно было бы дописать сбоку.
    const extra = notification({ outSum: '399.00', invId: '1001', ref: 'r-1' });
    extra['Shp_bonus'] = '1';

    await expect(provider.readEvent(extra)).rejects.toThrow(PermanentError);
  });

  it('продление отличается от первого платежа', async () => {
    const event = await provider.readEvent(
      notification({ outSum: '399.00', invId: '1077', ref: 'r-9', kind: 'renewal' }),
    );

    expect(event?.kind === 'paid' ? event.renewal : undefined).toBe(true);
  });

  it('посторонний апдейт — это не оплата, и не отказ', async () => {
    // Через `readEvent` проходит всё, что приходит: обычное сообщение не
    // должно выглядеть испорченным платежом.
    expect(await provider.readEvent({ message: 'привет' })).toBeUndefined();
    expect(await provider.readEvent(undefined)).toBeUndefined();
  });

  it('уведомление без метки отвергается: непонятно, кому продлевать', async () => {
    const outSum = '399.00';
    const invId = '1001';

    await expect(
      provider.readEvent({
        OutSum: outSum,
        InvId: invId,
        SignatureValue: resultSignature({ outSum, invId, password2: DEPS.password2 }),
      }),
    ).rejects.toThrow(PermanentError);
  });

  it('обрезанное уведомление отвергается, а не разбирается наполовину', async () => {
    await expect(provider.readEvent({ OutSum: '399.00' })).rejects.toThrow(PermanentError);
  });
});

describe('дочернее списание', () => {
  it('успех — это «OK<номер>», и он означает лишь создание операции', async () => {
    const outcome = await chargeRecurring(
      { ...DEPS, fetch: () => Promise.resolve(new Response('OK1002')) },
      {
        previousInvoiceId: 1001,
        invoiceId: 1002,
        amountMinor: 39_900,
        ref: 'r-1',
        description: 'Продление',
      },
    );

    expect(outcome).toEqual({ created: true, answer: 'OK1002' });
  });

  it('номер материнского платежа уходит отдельным полем', async () => {
    let body = '';

    await chargeRecurring(
      {
        ...DEPS,
        fetch: (_url, init) => {
          body = typeof init?.body === 'string' ? init.body : '';
          return Promise.resolve(new Response('OK1002'));
        },
      },
      {
        previousInvoiceId: 1001,
        invoiceId: 1002,
        amountMinor: 39_900,
        ref: 'r-1',
        description: 'Продление',
      },
    );

    const form = new URLSearchParams(body);

    expect(form.get('PreviousInvoiceID')).toBe('1001');
    expect(form.get('InvoiceID')).toBe('1002');
    expect(form.get('Shp_kind')).toBe('renewal');
  });

  it('отказ не выглядит успехом', async () => {
    const outcome = await chargeRecurring(
      { ...DEPS, fetch: () => Promise.resolve(new Response('Error code: 34')) },
      {
        previousInvoiceId: 1001,
        invoiceId: 1002,
        amountMinor: 39_900,
        ref: 'r-1',
        description: 'Продление',
      },
    );

    expect(outcome.created).toBe(false);
  });

  it('сетевой сбой — временный, его можно повторить', async () => {
    await expect(
      chargeRecurring(
        {
          ...DEPS,
          fetch: () => Promise.reject(new Error('ETIMEDOUT')),
        },
        {
          previousInvoiceId: 1001,
          invoiceId: 1002,
          amountMinor: 39_900,
          ref: 'r-1',
          description: 'Продление',
        },
      ),
    ).rejects.toThrow(TransientError);
  });
});

describe('состояние операции', () => {
  it('оплачено — это State.Code 100 и Result.Code 0', async () => {
    const xml = [
      '<OperationStateResponse>',
      '<Result><Code>0</Code></Result>',
      '<State><Code>100</Code></State>',
      '</OperationStateResponse>',
    ].join('');

    const known = createRobokassaProvider({
      ...DEPS,
      fetch: () => Promise.resolve(new Response(xml)),
    });

    expect(await known.statusOf({ tgId: 42, subscriptionRef: '1001' })).toEqual({ active: true });
  });

  it('любое другое состояние означает «денег ещё нет»', async () => {
    // 50 — «идёт зачисление». Считать это оплатой значило бы продлить
    // подписку за деньги, которые ещё не дошли.
    const xml = '<r><Result><Code>0</Code></Result><State><Code>50</Code></State></r>';
    const known = createRobokassaProvider({
      ...DEPS,
      fetch: () => Promise.resolve(new Response(xml)),
    });

    expect(await known.statusOf({ tgId: 42, subscriptionRef: '1001' })).toEqual({ active: false });
  });

  it('отказ самого запроса — не «не оплачено»', async () => {
    // Result.Code не ноль означает, что Робокасса не ответила по делу.
    const xml = '<r><Result><Code>2</Code></Result></r>';
    const known = createRobokassaProvider({
      ...DEPS,
      fetch: () => Promise.resolve(new Response(xml)),
    });

    expect((await known.statusOf({ tgId: 42, subscriptionRef: '1001' }))?.active).toBe(false);
  });

  it('сетевой сбой временный, а мусор в ответе — постоянный', async () => {
    const broken = createRobokassaProvider({
      ...DEPS,
      fetch: () => Promise.reject(new Error('ECONNRESET')),
    });

    await expect(broken.statusOf({ tgId: 42, subscriptionRef: '1001' })).rejects.toThrow(
      TransientError,
    );

    const garbage = createRobokassaProvider({
      ...DEPS,
      fetch: () => Promise.resolve(new Response('здравствуйте')),
    });

    await expect(garbage.statusOf({ tgId: 42, subscriptionRef: '1001' })).rejects.toThrow(
      PermanentError,
    );
  });
});

describe('ответ Робокассы не равен успеху', () => {
  it('код ошибки достаётся из страницы, а не из статуса HTTP', () => {
    /**
     * HTTP 200 у Робокассы не означает успех: ошибка приезжает внутри
     * HTML. Без этого разбора «оплата не открылась» выглядела бы
     * успешным ответом.
     */
    expect(errorCodeOfPage('<script>RoboxContext.error.code = 29;</script>')).toBe(29);
    expect(errorCodeOfPage('<html>всё хорошо</html>')).toBeUndefined();
  });

  it('у знакомых кодов есть человеческое объяснение для журнала', () => {
    expect(errorTextOf(29)).toContain('подпись');
    expect(errorTextOf(34)).toContain('не подключена');
    expect(errorTextOf(40)).toContain('уже использован');
    expect(errorTextOf(999)).toBeUndefined();
  });
});
