import type { Logger } from 'pino';

import { PermanentError, TransientError } from '../../../infra/failures.js';
import type {
  Checkout,
  CheckoutParams,
  PaymentEvent,
  PaymentProvider,
  ProviderStatus,
} from '../provider.js';
import {
  checkoutSignature,
  minorOf,
  opStateSignature,
  outSumOf,
  recurringSignature,
  resultSignature,
  DEFAULT_HASH_ALGO,
  type HashAlgo,
  type UserParams,
} from './robokassa-signature.js';

/**
 * Робокасса (§14 ТЗ, задача 4.2).
 *
 * Основной рельс оплаты: заказчица выбрала его 07.09.2026. Продавец —
 * самозанятая, чеки НПД выписывает сама Робокасса через «Робочеки СМЗ»,
 * поэтому номенклатуру (`Receipt`) мы **не передаём** — см. пояснение у
 * `createCheckout`.
 *
 * **Что здесь подтверждено документацией, а что нет.** Подпись ссылки на
 * оплату и подпись входящего уведомления выписаны из документации
 * дословно и запиннены золотыми векторами. Подпись **дочернего списания**
 * не подтверждена ни одним первоисточником: документация даёт только
 * состав полей и одну оговорку. Отрепетировать её нельзя — у метода нет
 * тестового режима. Поэтому продление помечено `unverified` и рядом стоит
 * прямой запрет обещать автопродление человеку, пока оно не проверено
 * живым списанием.
 *
 * **HTTP 200 у Робокассы не означает успех.** Код ошибки приезжает внутри
 * HTML-страницы, в `RoboxContext.error.code`; 302 с адресом операции —
 * тоже не подтверждение оплаты. Разбор ответа это учитывает, а не верит
 * статусу.
 */

/** Адрес платёжной страницы. */
const CHECKOUT_URL = 'https://auth.robokassa.ru/Merchant/Index.aspx';

/** Адрес дочерних списаний. Только для них и ни для чего больше. */
const RECURRING_URL = 'https://auth.robokassa.ru/Merchant/Recurring';

/** Состояние операции. */
const OP_STATE_URL = 'https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpStateExt';

export const ROBOKASSA_RAIL = 'robokassa:smz';

/**
 * Коды ошибок Робокассы, с которыми мы встретимся.
 *
 * Не полный перечень: здесь те, что означают нашу ошибку или состояние
 * магазина, и человеку про них знать нечего — они для журнала.
 */
const ERRORS: Readonly<Record<number, string>> = {
  25: 'магазин не найден или не активирован',
  26: 'магазин заблокирован',
  29: 'не сошлась подпись запроса',
  30: 'неверная сумма',
  31: 'неверный номер счёта',
  33: 'способ оплаты недоступен магазину',
  34: 'услуга не подключена магазину (в том числе периодические платежи)',
  35: 'превышен лимит',
  40: 'номер счёта уже использован',
  41: 'счёт уже оплачен',
  51: 'неверные параметры чека',
  52: 'ошибка фискализации',
  53: 'магазин не может принимать платежи',
};

export interface RobokassaDeps {
  readonly merchantLogin: string;
  readonly password1: string;
  readonly password2: string;
  readonly algo?: HashAlgo | undefined;
  /**
   * Тестовый режим.
   *
   * **Требует тестовой пары паролей.** Боевой пароль при `IsTest=1` даёт
   * ту же «ошибку 29», что и кривая формула, — и на её поиск уходят
   * часы. Проверка соответствия стоит при сборке провайдера.
   */
  readonly isTest?: boolean | undefined;
  /**
   * Согласованы ли периодические платежи.
   *
   * Робокасса включает их отдельной заявкой: «услуга доступна только по
   * предварительному согласованию». На несогласованном магазине
   * `Recurring=true` падает кодом 34 — уже после того, как человек нажал
   * кнопку оплаты. Пока согласования нет, честнее продать разовый
   * период, чем обещать продление, которого не будет.
   *
   * Умолчание — ложь: обещать то, чего не проверяли, дороже, чем не
   * обещать.
   */
  readonly recurringApproved?: boolean | undefined;
  readonly logger?: Logger | undefined;
  /** Подменяется в проверках: наружу они не ходят. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/** Что кладём в пользовательские параметры и получаем обратно. */
interface Marks {
  readonly ref: string;
  readonly kind: 'initial' | 'renewal';
}

function marksOf(marks: Marks): UserParams {
  return { Shp_kind: marks.kind, Shp_ref: marks.ref };
}

/**
 * Пользовательские параметры из пришедшего уведомления.
 *
 * Берутся **все** с префиксом `Shp_`, а не только знакомые: подпись
 * считается по всем, и пропущенный параметр означает несошедшуюся
 * подпись у настоящего уведомления.
 */
function incomingMarks(source: Readonly<Record<string, string>>): UserParams {
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('Shp_')) out[name] = value;
  }

  return out;
}

export function createRobokassaProvider(deps: RobokassaDeps): PaymentProvider {
  const algo = deps.algo ?? DEFAULT_HASH_ALGO;
  const call = deps.fetch ?? globalThis.fetch;

  return {
    name: ROBOKASSA_RAIL,

    /**
     * Ссылка на оплату.
     *
     * **Номенклатуру чека не передаём.** Чек НПД выписывают «Робочеки
     * СМЗ» по факту оплаты, а раздел фискализации Робокассы написан под
     * 54-ФЗ и кассу — про самозанятых в нём нет ни слова. Передать
     * `Receipt` наугад значит либо получить ошибку 51, либо выписать
     * человеку чек не по тому закону. Вопрос задан поддержке; до ответа
     * позиция называется «Свободная продажа», и это честнее выдумки.
     *
     * **Возвращается адрес, а не результат.** Робокасса открывает
     * страницу оплаты по GET, поэтому ссылку можно собрать без единого
     * обращения наружу — и это лучше: счёт, который мы не смогли
     * «создать» из-за сетевого сбоя, всё равно был бы валидным.
     */
    /**
     * `async`, хотя наружу не ходит, — и это не украшение.
     *
     * Метод объявлен возвращающим промис, значит отказ обязан приходить
     * отказом промиса. Бросай он синхронно, вызывающий с `.catch()` не
     * поймал бы ничего, и ошибка ушла бы наверх мимо обработки. Поймано
     * проверкой: `rejects.toThrow` не сработал.
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- см. выше
    async createCheckout(params: CheckoutParams): Promise<Checkout> {
      if (params.currency !== 'RUB') {
        throw new PermanentError(`Робокасса принимает рубли, а не ${params.currency}`);
      }

      if (params.invoiceNumber === undefined) {
        // Без нашего номера продление уйдёт в пустоту: см. пояснение к
        // `invoiceNumber` в интерфейсе провайдера.
        throw new PermanentError('Счёту Робокассы нужен наш номер');
      }

      const outSum = outSumOf(params.amount);
      const userParams = marksOf({ ref: params.ref, kind: 'initial' });

      const query = new URLSearchParams({
        MerchantLogin: deps.merchantLogin,
        OutSum: outSum,
        InvId: String(params.invoiceNumber),
        Description: params.title.slice(0, 100),
        Culture: 'ru',
        Encoding: 'utf-8',
        SignatureValue: checkoutSignature({
          merchantLogin: deps.merchantLogin,
          outSum,
          invId: params.invoiceNumber,
          userParams,
          password1: deps.password1,
          algo,
        }),
        ...userParams,
        /**
         * Автопродление просим только у месячного тарифа.
         *
         * У годового оно означало бы списание раз в год без напоминания —
         * а человек за год забудет, что подписывался. §14 требует
         * автосписание, но не требует делать его там, где оно вредит.
         */
        ...(params.plan === 'monthly' ? { Recurring: 'true' } : {}),
        ...(deps.isTest === true ? { IsTest: '1' } : {}),
      });

      return {
        url: `${CHECKOUT_URL}?${query.toString()}`,
        /**
         * Обещаем продление, только если оно **согласовано**.
         *
         * Периодические платежи Робокасса включает отдельной заявкой:
         * «услуга доступна только по предварительному согласованию». На
         * несогласованном магазине `Recurring=true` падает кодом 34 — уже
         * после того, как человек нажал кнопку. Пока согласования нет,
         * честнее продать разовый период, чем обещать продление.
         */
        autoRenews: params.plan === 'monthly' && deps.recurringApproved === true,
      };
    },

    /**
     * Разбор уведомления с ResultURL.
     *
     * Подпись проверяется **вторым** паролем и по сырой строке суммы:
     * в бою Робокасса присылает шесть знаков после точки, в тесте два, и
     * считать по числу нельзя.
     *
     * Несошедшаяся подпись — это отказ, а не «постороннее событие».
     * Молча вернуть `undefined` значило бы, что подделка выглядит как
     * чужой запрос и в журнал не попадает (§16).
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- отказ обязан быть отказом промиса
    async readEvent(raw: unknown): Promise<PaymentEvent | undefined> {
      if (typeof raw !== 'object' || raw === null) return undefined;

      const source = raw as Record<string, unknown>;
      const text = (name: string): string | undefined =>
        typeof source[name] === 'string' ? source[name] : undefined;

      const outSum = text('OutSum');
      const invId = text('InvId');
      const signature = text('SignatureValue');

      // Ни одного нужного поля — это не уведомление Робокассы вовсе.
      if (outSum === undefined && invId === undefined && signature === undefined) {
        return undefined;
      }

      if (outSum === undefined || invId === undefined || signature === undefined) {
        throw new PermanentError('Уведомление Робокассы без суммы, номера или подписи');
      }

      const strings: Record<string, string> = {};
      for (const [name, value] of Object.entries(source)) {
        if (typeof value === 'string') strings[name] = value;
      }

      const userParams = incomingMarks(strings);

      const expected = resultSignature({
        outSum,
        invId,
        password2: deps.password2,
        userParams,
        algo,
      });

      // Сравнение регистронезависимое: регистр итогового hex Робокасса
      // не оговаривает, а полагаться на неоговорённое нельзя.
      if (expected.toLowerCase() !== signature.toLowerCase()) {
        throw new PermanentError('Не сошлась подпись уведомления Робокассы');
      }

      const amount = minorOf(outSum);

      if (amount === undefined) {
        throw new PermanentError(`Не разобрал сумму «${outSum}» из уведомления`);
      }

      const ref = userParams['Shp_ref'];

      if (ref === undefined) {
        throw new PermanentError('В уведомлении нет нашей метки Shp_ref');
      }

      return {
        kind: 'paid',
        /**
         * Ключ идемпотентности — **пришедший** номер счёта.
         *
         * Он же станет `PreviousInvoiceID` для продления: свой номер для
         * этого не годится, потому что Робокасса могла назначить свой.
         */
        externalId: invId,
        ref,
        amount,
        currency: 'RUB',
        renewal: userParams['Shp_kind'] === 'renewal',
      };
    },

    /**
     * Отключить автопродление.
     *
     * У Робокассы для этого нет метода, и он не нужен: дочернее списание
     * инициируем **мы**. Не списываем — продления нет. Источник правды
     * про автопродление — наша таблица, и `stopAutoRenew` уже сделала
     * своё дело; здесь нечего делать по-настоящему, и врать вызовом в
     * пустоту не нужно.
     */
    stopRenewal(): Promise<void> {
      deps.logger?.debug(
        { rail: ROBOKASSA_RAIL },
        'Отмена автопродления: у Робокассы списание инициируем мы, отдельного вызова нет',
      );

      return Promise.resolve();
    },

    /**
     * Состояние операции — по `OpStateExt`, третьей подписью.
     *
     * Нужно там, где ответу верить нельзя: «OK{InvoiceID}» на дочернее
     * списание означает создание операции, а не списание денег. Ответ
     * приходит XML, и разбирается он двумя выражениями нарочно: тащить
     * разборщик XML ради двух чисел дороже, чем прочитать два числа.
     */
    async statusOf(params: { readonly subscriptionRef: string }): Promise<ProviderStatus> {
      const invoiceId = Number(params.subscriptionRef);

      if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
        throw new PermanentError(`«${params.subscriptionRef}» не похож на номер счёта Робокассы`);
      }

      const query = new URLSearchParams({
        MerchantLogin: deps.merchantLogin,
        InvoiceID: String(invoiceId),
        Signature: opStateSignature({
          merchantLogin: deps.merchantLogin,
          invoiceId,
          password2: deps.password2,
          algo,
        }),
      });

      let body: string;

      try {
        const response = await call(`${OP_STATE_URL}?${query.toString()}`);
        body = await response.text();
      } catch (error) {
        // Сеть моргнула — это не «операции нет»: повторить можно.
        throw new TransientError('Робокасса не ответила на запрос состояния', error);
      }

      const result = Number(/<Result>[\s\S]*?<Code>(\d+)<\/Code>/u.exec(body)?.[1] ?? 'н');
      const state = Number(/<State>[\s\S]*?<Code>(\d+)<\/Code>/u.exec(body)?.[1] ?? 'н');

      if (!Number.isInteger(result)) {
        throw new PermanentError('Не разобрал ответ Робокассы о состоянии операции');
      }

      if (result !== 0) {
        deps.logger?.warn({ result, invoiceId }, 'Робокасса отказала в запросе состояния');
        return { active: false };
      }

      // 100 — оплачено. Остальные состояния означают «денег ещё нет».
      return { active: state === 100 };
    },
  };
}

/**
 * Дочернее списание. **Формула подписи не подтверждена документацией.**
 *
 * Отдельной функцией, а не методом провайдера, и это решение. Интерфейс
 * провайдера описывает то, что мы умеем делать надёжно; продление по
 * Робокассе к этому пока не относится:
 *
 *  - строки подписи нет ни в одном первоисточнике — она получена
 *    исключением из состава полей и одной оговорки;
 *  - тестового режима у метода нет вовсе, отрепетировать нельзя;
 *  - ответ «OK{InvoiceID}» означает создание операции, а **не** списание
 *    денег: подписку по нему продлевать нельзя.
 *
 * Поэтому вызывающий обязан знать, что делает: продление наступает только
 * по уведомлению на ResultURL либо по `statusOf`, а первое живое списание
 * идёт на минимальной сумме и под наблюдением.
 */
export async function chargeRecurring(
  deps: RobokassaDeps,
  params: {
    readonly previousInvoiceId: number;
    readonly invoiceId: number;
    readonly amountMinor: number;
    readonly ref: string;
    readonly description: string;
  },
): Promise<{ readonly created: boolean; readonly answer: string }> {
  const outSum = outSumOf(params.amountMinor);
  const userParams = marksOf({ ref: params.ref, kind: 'renewal' });

  const form = new URLSearchParams({
    MerchantLogin: deps.merchantLogin,
    InvoiceID: String(params.invoiceId),
    PreviousInvoiceID: String(params.previousInvoiceId),
    OutSum: outSum,
    Description: params.description.slice(0, 100),
    SignatureValue: recurringSignature({
      merchantLogin: deps.merchantLogin,
      outSum,
      invoiceId: params.invoiceId,
      userParams,
      password1: deps.password1,
      algo: deps.algo ?? DEFAULT_HASH_ALGO,
    }),
    ...userParams,
  });

  const call = deps.fetch ?? globalThis.fetch;

  let answer: string;

  try {
    const response = await call(RECURRING_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    answer = (await response.text()).trim();
  } catch (error) {
    throw new TransientError('Робокасса не ответила на дочернее списание', error);
  }

  /**
   * Успех — это `OK<номер>`, и ничего больше.
   *
   * И он означает **создание операции**, а не списание: подписку по нему
   * продлевать нельзя, иначе месяц достанется за неудачную попытку.
   */
  if (/^OK\d+$/u.test(answer)) return { created: true, answer };

  const code = Number(/(\d+)/u.exec(answer)?.[1] ?? 'н');
  const known = Number.isInteger(code) ? ERRORS[code] : undefined;

  deps.logger?.error(
    { answer, code: Number.isInteger(code) ? code : undefined, known },
    'Дочернее списание Робокассы не создано',
  );

  return { created: false, answer };
}

/** Человеческое объяснение кода ошибки — для журнала, не для человека. */
export function errorTextOf(code: number): string | undefined {
  return ERRORS[code];
}

/**
 * Код ошибки со страницы Робокассы.
 *
 * HTTP 200 у неё не означает успех: ошибка приезжает внутри HTML, в
 * `RoboxContext.error.code`. Без этого разбора «оплата не открылась»
 * выглядела бы как успешный ответ.
 */
export function errorCodeOfPage(html: string): number | undefined {
  const found = /RoboxContext\.error\.code\s*=\s*(\d+)/u.exec(html)?.[1];

  return found === undefined ? undefined : Number(found);
}
