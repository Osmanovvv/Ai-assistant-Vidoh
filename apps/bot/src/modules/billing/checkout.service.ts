import { randomUUID } from 'node:crypto';

import type { Executor } from '../../infra/db.js';
import type { SettingsRegistry } from '../settings/settings.repo.js';
import { createInvoice, nextInvId, noteAutoRenew } from './billing.repo.js';
import type { PromoOffer } from './promo.service.js';
import type { Checkout, PaymentProvider, PlanKind } from './provider.js';
import { PLANS, priceOf, RAILS, type Price, type Rail } from './tariffs.js';

/**
 * Выставление счёта (§14 ТЗ, задача 4.2).
 *
 * Между тарифом и провайдером есть шов, и он здесь: счёт сначала
 * появляется **у нас**, и только потом уходит наружу. Порядок именно
 * такой, а не обратный.
 *
 * **Почему счёт заводится до обращения к провайдеру.** Уведомление об
 * оплате приходит по нашей метке; не будь строки в базе к моменту
 * оплаты, деньги пришли бы, а привязать их было бы не к чему. Человек
 * платит быстро — между «нажал» и «оплатил» проходят секунды, и
 * записывать счёт после ответа провайдера значит однажды опоздать.
 *
 * Плата за этот порядок названа: у нас копятся счета, за которые никто
 * не заплатил. Это дешевле потерянного платежа и видно в панели.
 */

/**
 * Метка счёта — она же `Shp_ref` у Робокассы и `invoice_payload` у звёзд.
 *
 * Требования к ней у двух рельсов разные и оба жёсткие: у Робокассы
 * двоеточие и кириллица ломают подпись, у Telegram — предел в 128 **байт**.
 * Шестнадцатеричные знаки проходят и там и там, а случайность делает
 * метку неугадываемой: по ней уведомление находит счёт, и подобрать
 * чужую метку не должно быть возможно.
 */
export function newRef(): string {
  return randomUUID().replaceAll('-', '').slice(0, 20);
}

/** Тариф, который действительно можно купить прямо сейчас. */
export interface Sellable {
  readonly rail: Rail;
  readonly plan: PlanKind;
  readonly price: Price;
}

/**
 * Что продаётся: пересечение «есть провайдер» и «назначена цена».
 *
 * Одно место на две надобности — кнопки на экране подписки и решение,
 * приглашать ли к оплате в конце пробного периода. Раздельные ответы на
 * эти вопросы уже однажды разошлись бы: цена задаётся в панели (§15.3) в
 * любой момент, а рельс включается переменными запуска, и «пробное
 * кончилось, выберите тариф» без единого тарифа — обещание без товара.
 *
 * Пустой ответ означает «продавать нечего», и это законное состояние: до
 * согласования Робокассы и назначения цен бот именно так и живёт.
 */
export async function sellable(
  settings: SettingsRegistry,
  rails: readonly Rail[],
): Promise<Sellable[]> {
  const found: Sellable[] = [];

  // Порядок — из `RAILS`, а не из переданного списка: он определяет
  // порядок кнопок, и меняться от порядка переменных запуска ему нечего.
  for (const rail of RAILS) {
    if (!rails.includes(rail)) continue;

    for (const plan of PLANS) {
      const price = await priceOf(settings, { plan, rail });

      if (price !== undefined) found.push({ rail, plan, price });
    }
  }

  return found;
}

export interface CheckoutRequest {
  readonly userId: string;
  readonly tgId: number;
  readonly plan: PlanKind;
  readonly rail: Rail;
  readonly settings: SettingsRegistry;
  readonly provider: PaymentProvider;
  /** Что человек увидит в окне оплаты. */
  readonly title: string;
  readonly description: string;
  /**
   * Промокод, уже проверенный (задача 4.4).
   *
   * Проверять его здесь нельзя: `promoFor` спрашивает и человека, и
   * рельс, и тариф, и историю оплат, а выставление счёта про них знает
   * не всё. Кто позвал — тот и проверил; проверка стоит непосредственно
   * перед этим вызовом, чтобы между ними не прошло времени.
   */
  readonly promo?: PromoOffer | undefined;
}

export type CheckoutOutcome =
  | { readonly ok: true; readonly checkout: Checkout; readonly ref: string }
  /** Цена не задана: продавать нечего, и кнопку показывать не надо. */
  | { readonly ok: false; readonly why: 'no-price' };

export async function startCheckout(
  db: Executor,
  params: CheckoutRequest,
): Promise<CheckoutOutcome> {
  const full = await priceOf(params.settings, { plan: params.plan, rail: params.rail });

  if (full === undefined) return { ok: false, why: 'no-price' };

  /**
   * Скидка применяется **до** создания счёта и одним значением.
   *
   * Это и есть всё правило встраивания промокода. Счёт, подпись и сумма
   * в ссылке считаются из одной переменной: `price` идёт и в
   * `createInvoice`, и провайдеру, который подписывает ровно её.
   * Разойтись они физически не могут — пока скидка применена здесь, а не
   * где-то по пути.
   *
   * А сверка при приёме уведомления идёт со суммой **счёта**, а не с
   * ценой из настроек, — потому скидка и не ломает приём оплаты.
   */
  const price = params.promo?.price ?? full;

  const ref = newRef();

  /**
   * Номер счёта — только рублёвому рельсу.
   *
   * Робокассе он нужен и обязан быть нашим: по нему потом уходит
   * продление. Звёздам он не нужен вовсе, и тратить на них номер из
   * последовательности незачем — они опознают счёт меткой.
   */
  const invId = params.rail === 'robokassa:smz' ? await nextInvId(db) : undefined;

  const invoice = await createInvoice(db, {
    provider: params.rail,
    userId: params.userId,
    plan: params.plan,
    kind: 'initial',
    amountMinor: price.amountMinor,
    currency: price.currency,
    ref,
    ...(invId === undefined ? {} : { invId }),
    /**
     * Полная цена — на счёт, даже когда скидки нет.
     *
     * Иначе «сколько недополучено по кодам» пришлось бы считать
     * вычитанием нынешней цены, а она меняется: у платежей прошлого
     * месяца скидка вышла бы другой.
     */
    amountFullMinor: full.amountMinor,
    ...(params.promo === undefined ? {} : { promoCode: params.promo.code }),
  });

  const checkout = await params.provider.createCheckout({
    userId: params.userId,
    tgId: params.tgId,
    plan: params.plan,
    amount: price.amountMinor,
    currency: price.currency,
    ref: invoice.ref,
    title: params.title,
    description: params.description,
    ...(invId === undefined ? {} : { invoiceNumber: invId }),
    /**
     * Промо-счёт уходит **без** автопродления, на обоих рельсах.
     *
     * Это часть устройства скидки, а не оговорка. У звёзд продлевает
     * Telegram сам и по сумме счёта — подписочный промо-счёт означал бы
     * скидку навсегда, и заметить это можно было бы только по выручке
     * через месяц. У Робокассы дочернее списание на сумму **больше**
     * материнского официально не выяснено (в перечне ошибок есть код 30
     * «неверная сумма»), а сама формула подписи продления документацией
     * не подтверждена — ставить на это первое живое списание нельзя.
     *
     * «Только на первый период» получается отсюда само: следующий период
     * человек покупает обычной кнопкой по полной цене.
     */
    ...(params.promo === undefined ? {} : { renewable: false }),
  });

  /**
   * Обещание про продление записывается **после** ответа провайдера.
   *
   * Раньше и нельзя: правду знает только он. У звёзд годовой тариф
   * продлеваться не умеет вовсе, у Робокассы продление работает лишь
   * после согласования услуги — и обе оговорки видны только в ответе.
   *
   * Упади мы здесь — счёт останется без обещания, оплата даст доступ без
   * автопродления. Так и задумано: не продлить обещанное дешевле, чем
   * списать необещанное.
   */
  await noteAutoRenew(db, { id: invoice.id, autoRenew: checkout.autoRenews });

  return { ok: true, checkout, ref };
}

/** Цена словами: «399 ₽» или «150 ⭐». */
export function priceText(price: {
  readonly amountMinor: number;
  readonly currency: string;
}): string {
  if (price.currency === 'XTR') return `${String(price.amountMinor)} ⭐`;

  const rubles = Math.floor(price.amountMinor / 100);
  const kopecks = price.amountMinor % 100;

  /**
   * Копейки показываются, только если они есть.
   *
   * «399 ₽» человек читает как цену, «399.00 ₽» — как выписку из
   * бухгалтерии. А вот «399,50 ₽» показать обязаны: округлить цену в
   * тексте значило бы назвать не ту сумму, которую спишут.
   */
  return kopecks === 0
    ? `${String(rubles)} ₽`
    : `${String(rubles)},${String(kopecks).padStart(2, '0')} ₽`;
}

/** Дата человеку: «7 октября 2026». */
export function untilText(when: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  }).format(when);
}
