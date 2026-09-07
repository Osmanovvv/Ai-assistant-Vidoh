import type { Api } from 'grammy';
import type { Logger } from 'pino';

import { PermanentError, TransientError } from '../../../infra/failures.js';
import type {
  Checkout,
  CheckoutParams,
  PaymentEvent,
  PaymentProvider,
  ProviderStatus,
} from '../provider.js';

/**
 * Telegram Stars (§14 ТЗ, задача 4.2) — второй рельс, и он обязателен.
 *
 * **Почему он обязателен, а не «на будущее».** Правила платёжной
 * платформы Telegram требуют паритета: если цифровую услугу можно купить
 * снаружи, та же услуга обязана продаваться и за звёзды. Санкция названа
 * прямо — бота делают недоступным из магазинных версий Telegram либо
 * отключают от платформы. Значит рельса два, и второй здесь.
 *
 * **Подписка бывает только тридцатидневной.** `subscription_period` в Bot
 * API обязан быть 2 592 000 секунд, других значений нет. Годовой тариф за
 * звёзды — разовый платёж без автопродления, и провайдер говорит это
 * честно (`autoRenews: false`), чтобы бот не обещал того, чего не будет.
 *
 * **Подписочный счёт выставляется только ссылкой.** У `sendInvoice`
 * параметра `subscription_period` нет вовсе; документация MTProto говорит
 * то же прямым текстом. Поэтому здесь `createInvoiceLink`, а не отправка
 * счёта в чат.
 *
 * **Продление делает Telegram сам**, а мы узнаём о нём служебным
 * сообщением. Об отмене и о сбое продления приходит отдельный апдейт
 * `subscription` (`BotSubscriptionUpdated`, Bot API 10.2) — это
 * единственный способ узнать, что человек отписался.
 */

export const STARS_RAIL = 'telegram:stars';

/** Единственный допустимый период подписки в звёздах: тридцать суток. */
export const STARS_PERIOD_SECONDS = 2_592_000;

/** Потолок цены подписки в звёздах — из документации Bot API. */
const STARS_MAX_SUBSCRIPTION = 10_000;

/** `invoice_payload` — от одного до 128 **байт**, не символов. */
const PAYLOAD_MAX_BYTES = 128;

/** Пределы полей счёта. */
const TITLE_MAX = 32;
const DESCRIPTION_MAX = 255;

export interface StarsDeps {
  readonly api: Pick<
    Api,
    'createInvoiceLink' | 'editUserStarSubscription' | 'refundStarPayment' | 'getStarTransactions'
  >;
  readonly logger?: Logger | undefined;
}

/** Обрезка по символам с многоточием: пределы Telegram считаются в них. */
function fit(text: string, max: number): string {
  const trimmed = text.trim();

  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Разобрать служебное сообщение об оплате звёздами.
 *
 * **Отдельной функцией, а не только методом провайдера.** Разбор не
 * требует ни ключей, ни доступа к Telegram — это чистое чтение тела
 * апдейта. А провайдера может не быть: рельс звёзд выключается
 * переменной окружения, и выключить его можно **после** того, как
 * подписки уже созданы. Telegram при этом продолжает списывать звёзды
 * каждый месяц.
 *
 * Прежде обработчик в таком случае выходил первой же строкой: деньги
 * списаны, периода нет, записи нет, журнала нет, человеку не сказано
 * ничего. Разбор, доступный без провайдера, снимает у этого молчания
 * причину.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- отказ обязан быть отказом промиса, а не синхронным броском: контракт `readEvent` обещает промис
export async function readStarsEvent(raw: unknown): Promise<PaymentEvent | undefined> {
  if (typeof raw !== 'object' || raw === null) return undefined;

  const update = raw as {
    readonly message?: {
      readonly successful_payment?: {
        readonly currency?: string;
        readonly total_amount?: number;
        readonly invoice_payload?: string;
        readonly telegram_payment_charge_id?: string;
        readonly subscription_expiration_date?: number;
        readonly is_recurring?: true;
        readonly is_first_recurring?: true;
      };
      readonly refunded_payment?: {
        readonly currency?: string;
        readonly total_amount?: number;
        readonly invoice_payload?: string;
        readonly telegram_payment_charge_id?: string;
      };
    };
    readonly subscription?: {
      readonly invoice_payload?: string;
      readonly state?: 'canceled' | 'active' | 'failed';
    };
  };

  const paid = update.message?.successful_payment;

  if (paid !== undefined) {
    const ref = paid.invoice_payload;
    const charge = paid.telegram_payment_charge_id;

    if (ref === undefined || charge === undefined || paid.total_amount === undefined) {
      throw new PermanentError('Оплата звёздами без метки, идентификатора или суммы');
    }

    const renewal = paid.is_recurring === true && paid.is_first_recurring !== true;

    return {
      kind: 'paid',
      externalId: charge,
      ref,
      amount: paid.total_amount,
      currency: paid.currency ?? 'XTR',
      renewal,
      ...(paid.subscription_expiration_date === undefined
        ? {}
        : { paidUntil: new Date(paid.subscription_expiration_date * 1000) }),
      /**
       * Отменять подписку надо идентификатором **первого** платежа.
       *
       * Так требует Telegram: `charge_id` для отмены берётся из
       * первого платежа подписки, а не из последнего продления.
       * Поэтому на продлении мы его не отдаём вовсе — и тогда наша
       * таблица сохраняет тот, что записан при первой оплате.
       * Перезапиши мы его продлением, отмена перестала бы работать
       * ровно у тех, кто платит давно.
       */
      ...(renewal ? {} : { subscriptionRef: charge }),
    };
  }

  const refunded = update.message?.refunded_payment;

  if (refunded !== undefined) {
    const ref = refunded.invoice_payload;
    const charge = refunded.telegram_payment_charge_id;

    if (ref === undefined || charge === undefined) {
      throw new PermanentError('Возврат звёзд без метки или идентификатора');
    }

    return {
      kind: 'refunded',
      externalId: charge,
      ref,
      amount: refunded.total_amount ?? 0,
      currency: refunded.currency ?? 'XTR',
    };
  }

  const changed = update.subscription;

  if (changed !== undefined) {
    const ref = changed.invoice_payload;

    if (ref === undefined) {
      throw new PermanentError('Изменение подписки без метки счёта');
    }

    /**
     * Три состояния, и каждое значит своё.
     *
     * `canceled` — человек отписался сам; `failed` — продление не
     * прошло, денег не хватило; `active` — включил обратно. Последнее
     * нашей таблице сообщать нечем: событие «включил снова» в наших
     * видах не предусмотрено, и придумывать его здесь неправильно —
     * подписка оживёт следующим успешным платежом.
     */
    if (changed.state === 'canceled') {
      return { kind: 'renewalStopped', ref };
    }

    if (changed.state === 'failed') {
      return { kind: 'renewalFailed', ref };
    }

    return undefined;
  }

  return undefined;
}

export function createStarsProvider(deps: StarsDeps): PaymentProvider {
  return {
    name: STARS_RAIL,

    async createCheckout(params: CheckoutParams): Promise<Checkout> {
      if (params.currency !== 'XTR') {
        throw new PermanentError(`Звёзды — это XTR, а не ${params.currency}`);
      }

      if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
        throw new PermanentError(`Цена «${String(params.amount)}» звёзд не годится`);
      }

      /**
       * Метка не должна вылезти за 128 **байт**.
       *
       * Байт, а не символов: кириллическая метка вдвое тяжелее. Обрезать
       * её молча нельзя — по метке уведомление находит счёт, и обрезанная
       * метка означала бы платёж, который не к чему привязать.
       */
      const payloadBytes = Buffer.byteLength(params.ref, 'utf8');

      if (payloadBytes > PAYLOAD_MAX_BYTES) {
        throw new PermanentError(
          `Метка счёта ${String(payloadBytes)} байт, а Telegram принимает ${String(PAYLOAD_MAX_BYTES)}`,
        );
      }

      /**
       * Подписка только месячная — так устроен Bot API.
       *
       * У годового тарифа автопродления в звёздах не существует: это
       * разовый платёж, и обещать по нему продление нельзя.
       */
      /**
       * Подписка — только месячная и только если её попросили.
       *
       * Отказ просить приходит от промокода (задача 4.4): Telegram
       * продлевает подписку **по сумме счёта**, значит подписочный
       * промо-счёт означал бы скидку навсегда, и заметить это можно было
       * бы только по выручке через месяц.
       */
      const subscription = params.plan === 'monthly' && params.renewable !== false;

      if (subscription && params.amount > STARS_MAX_SUBSCRIPTION) {
        throw new PermanentError(
          `Подписка в звёздах не дороже ${String(STARS_MAX_SUBSCRIPTION)}, а тут ${String(params.amount)}`,
        );
      }

      try {
        const url = await deps.api.createInvoiceLink(
          fit(params.title, TITLE_MAX),
          fit(params.description, DESCRIPTION_MAX),
          params.ref,
          // Пустая строка — так Bot API просит платить звёздами.
          '',
          'XTR',
          [{ label: fit(params.title, TITLE_MAX), amount: params.amount }],
          subscription ? { subscription_period: STARS_PERIOD_SECONDS } : {},
        );

        return { url, autoRenews: subscription };
      } catch (error) {
        // Сеть и временная недоступность Telegram — не наша ошибка в
        // запросе: счёт можно выставить ещё раз.
        throw new TransientError('Telegram не выдал ссылку на счёт', error);
      }
    },

    /**
     * Разбор апдейта Telegram.
     *
     * Три случая, и все три — служебные сообщения, а не слова человека:
     * успешная оплата, возврат и изменение подписки.
     *
     * **`is_recurring` — литерал `True`, а не булево.** Поля либо приходят
     * со значением `true`, либо не приходят вовсе; `false` Telegram не
     * присылает никогда. Читать их как булево — значит однажды принять
     * отсутствие поля за осмысленный ответ.
     */
    /** Разбор живёт снаружи: он нужен и без провайдера. См. `readStarsEvent`. */
    readEvent: readStarsEvent,

    /**
     * Отключить автопродление звёздной подписки.
     *
     * **Отмена ботом жёстче отмены человеком:** отменённую ботом подписку
     * человек не сможет включить обратно сам, пока бот не снимет отмену.
     * Поэтому зовём это только по его же просьбе — из кнопки «отключить
     * продление», и никогда по своей инициативе.
     */
    async stopRenewal(params: {
      readonly tgId: number;
      readonly subscriptionRef: string;
    }): Promise<void> {
      try {
        await deps.api.editUserStarSubscription(params.tgId, params.subscriptionRef, true);
      } catch (error) {
        throw new TransientError('Telegram не отменил продление подписки', error);
      }
    },

    /**
     * Состояние подписки — Telegram его не отдаёт.
     *
     * Ни один метод Bot API не говорит, включено ли продление: по списку
     * транзакций видно, когда и на сколько заплатили, но не будет ли
     * следующего платежа. Здесь мы ищем сам платёж в последних
     * транзакциях; не нашли — честно отвечаем «не знаю», а не «неактивна».
     * Второе отобрало бы доступ у платящего только потому, что его платёж
     * уехал за край списка.
     */
    async statusOf(params: {
      readonly subscriptionRef: string;
    }): Promise<ProviderStatus | undefined> {
      let transactions;

      try {
        transactions = await deps.api.getStarTransactions({ limit: 100 });
      } catch (error) {
        throw new TransientError('Telegram не отдал список звёздных операций', error);
      }

      const found = transactions.transactions.find((one) => one.id === params.subscriptionRef);

      return found === undefined ? undefined : { active: true };
    },
  };
}

/**
 * Вернуть звёзды.
 *
 * Отдельно от интерфейса провайдера нарочно — там четыре операции, и
 * возврата среди них нет: §14 его не требует, а необратимое действие в
 * общем интерфейсе — приглашение однажды позвать его из чужого кода.
 *
 * Возврат идёт с баланса бота и без штрафа со стороны Telegram. Звёзды
 * при этом доступны к выводу не сразу — до трёх недель после получения, —
 * поэтому баланс под возвраты должен быть, а не «выведем всё сразу».
 */
export async function refundStars(
  deps: StarsDeps,
  params: { readonly tgId: number; readonly chargeId: string },
): Promise<void> {
  try {
    await deps.api.refundStarPayment(params.tgId, params.chargeId);
  } catch (error) {
    throw new TransientError('Telegram не вернул звёзды', error);
  }
}
