import type {
  Checkout,
  CheckoutParams,
  PaymentEvent,
  PaymentProvider,
  ProviderStatus,
} from '../provider.js';

/**
 * Заглушка провайдера оплаты (задача 4.1).
 *
 * Тем же приёмом, что заглушки модели, речи и векторов: подписка и
 * деградация проверяются на живой базе и без единого обращения наружу.
 * Настоящая оплата и настоящие деньги в тестах не участвуют — это же
 * требует и план от сквозного теста этапа.
 *
 * Заглушка **не притворяется правильной**: она отвечает то, что ей
 * велели, и запоминает, о чём её просили. Проверять по ней поведение
 * провайдера бессмысленно, а поведение подписки — единственный способ.
 */
export interface MockPaymentOptions {
  readonly name?: string | undefined;
  /** Ссылка, которую вернёт счёт. */
  readonly url?: string | undefined;
  /** Умеет ли этот счёт продлеваться сам. */
  readonly autoRenews?: boolean | undefined;
  /** Что отдавать на `readEvent`. По умолчанию — «это не про оплату». */
  readonly event?: PaymentEvent | undefined;
  readonly status?: ProviderStatus | undefined;
  /** Испорченное событие: провайдер обязан отказать, а не промолчать. */
  readonly failEvent?: Error | undefined;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name: string;

  private readonly checkouts: CheckoutParams[] = [];
  private readonly stopped: { tgId: number; subscriptionRef: string }[] = [];

  constructor(private readonly options: MockPaymentOptions = {}) {
    this.name = options.name ?? 'mock:payment';
  }

  /** О чём просили счёт: тест смотрит цену, тариф и метку. */
  get requests(): readonly CheckoutParams[] {
    return this.checkouts;
  }

  /** Кому останавливали продление. */
  get stops(): readonly { tgId: number; subscriptionRef: string }[] {
    return this.stopped;
  }

  createCheckout(params: CheckoutParams): Promise<Checkout> {
    this.checkouts.push(params);

    return Promise.resolve({
      url: this.options.url ?? `https://оплата.тест/${params.ref}`,
      /**
       * **Заглушка слушает контракт, а не догадывается** (ревизия 4).
       *
       * Прежде здесь стояло `?? params.plan === 'monthly'` — догадка про
       * тариф, которой настоящие провайдеры не делают: у звёзд годовой
       * тариф не продлевается вовсе, у Робокассы даже месячное продление
       * работает лишь после согласования. На этой догадке стояла
       * проверка «годовой тариф не обещает продления» — и она не могла
       * покраснеть от правки продукта: она измеряла заглушку.
       *
       * Теперь заглушка отвечает то, о чём просили: `renewable: false`
       * означает разовый платёж на любом рельсе, а `autoRenews` задаёт
       * тот, кто её создал.
       */
      autoRenews: (this.options.autoRenews ?? true) && params.renewable !== false,
    });
  }

  readEvent(_raw: unknown): Promise<PaymentEvent | undefined> {
    if (this.options.failEvent !== undefined) return Promise.reject(this.options.failEvent);

    return Promise.resolve(this.options.event);
  }

  stopRenewal(params: { tgId: number; subscriptionRef: string }): Promise<void> {
    this.stopped.push({ tgId: params.tgId, subscriptionRef: params.subscriptionRef });

    return Promise.resolve();
  }

  statusOf(): Promise<ProviderStatus | undefined> {
    /**
     * `undefined` отдаётся как есть — так же, как у звёзд.
     *
     * Прежде заглушка подставляла «активна, продлевается», и «провайдер
     * не знает» изобразить ею было нельзя. А это законный ответ: у
     * звёзд состояния подписки нет ни в одном методе Bot API.
     */
    return Promise.resolve(this.options.status);
  }
}
