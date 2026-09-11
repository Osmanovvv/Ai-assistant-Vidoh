import type { Bot, Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import type { BillingSubscription } from '../../db/schema.js';
import {
  invoiceByRef,
  paidInvoicesCount,
  subscriptionsOf,
} from '../../modules/billing/billing.repo.js';
import {
  priceText,
  sellable,
  startCheckout,
  untilText,
} from '../../modules/billing/checkout.service.js';
import { normalizeCode, promoFor, type PromoOffer } from '../../modules/billing/promo.service.js';
import type { PaymentProvider, PlanKind } from '../../modules/billing/provider.js';
import { readStarsEvent } from '../../modules/billing/providers/stars.js';
import { applyPaymentEvent, cancelRenewal } from '../../modules/billing/subscription.service.js';
import {
  firstRenewalChargeAt,
  PLANS,
  priceOf,
  RAILS,
  type Rail,
} from '../../modules/billing/tariffs.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';
import type { SettingsRegistry } from '../../modules/settings/settings.repo.js';
import { AWAITING, setAwaiting } from '../../modules/onboarding/awaiting.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor } from '../../texts/index.js';
import type { TextProfile } from '../../texts/types.js';
import { sayNotUnderstood } from './awaiting.js';

/**
 * Подписка глазами человека (§14 ТЗ, задача 4.2).
 *
 * Экран один и отвечает на три вопроса сразу: платит ли он, до какого
 * числа и что можно сделать. Разводить это по трём экранам значило бы
 * заставить искать ответ там, где человек и так волнуется.
 *
 * **Про автопродление сказано до оплаты, а не после.** Человек,
 * узнавший о списании из банковского приложения, перестаёт доверять не
 * кнопке, а продукту. Поэтому оговорка идёт вместе со ссылкой на оплату,
 * и берётся она у **провайдера**, а не из наших предположений: у звёзд
 * годовой тариф продлеваться не умеет, а у Робокассы продление работает
 * только после согласования услуги.
 *
 * **Отмена — в один тап**, как требует §14, и доступ при ней остаётся до
 * конца оплаченного периода. Отдельного «вы уверены?» здесь нет:
 * отменённое продление включается обратно новой оплатой, а лишний вопрос
 * на пути к отказу читается как удержание.
 *
 * **Звёздные платежи приходят сюда, а не в наш HTTP.** Робокасса стучит
 * на ResultURL, а Telegram присылает оплату служебным сообщением в поток
 * апдейтов бота — тем же, которым приходят голосовые. Поэтому приём
 * оплаты звёздами живёт рядом с кнопками, и это не мешанина слоёв: у
 * рельса такой транспорт.
 */

export const BILLING_ACTION = {
  /** Открыть экран подписки. */
  open: 'pay:open',
  /** `pay:b:<код рельса>:<тариф>` — купить. */
  buyPrefix: 'pay:b:',
  /**
   * `pay:c:<код рельса>:<0|1>` — переключить согласие на автосписания
   * (§14, оферта п. 2.3 и 7.2). Число — состояние, в которое перейти.
   *
   * Состояние живёт в самой кнопке, а не в базе: у переключателя нет
   * второго читателя, а строка «ожидающее согласие» в базе означала бы
   * ещё один срок жизни и ещё один способ разойтись с тем, что человек
   * видит на экране. Согласие становится фактом только вместе со счётом.
   */
  consentPrefix: 'pay:c:',
  /** `pay:go:<код рельса>:<0|1>` — к оплате месяца с согласием или без. */
  goPrefix: 'pay:go:',
  cancel: 'pay:stop',
  /** Спросить промокод словами (§14, задача 4.4). */
  promo: 'pay:promo',
  /**
   * `pay:p:<код рельса>:<тариф>:<КОД>` — купить по промокоду.
   *
   * Код едет в `callback_data` и заново проверяется при выставлении
   * счёта: подделать строку тривиально, но решает проверка, а не
   * кнопка. Взамен не нужно ни колонки «ожидающий код», ни своего срока
   * жизни, ни второго источника правды о том, кто каким кодом платил.
   *
   * Предел `callback_data` — 64 **байта**; код ограничен латиницей,
   * цифрами и дефисом до 24 знаков, префикс с рельсом и тарифом — до 17.
   * За этим следит страж `bot/keyboards.test.ts`.
   */
  promoBuyPrefix: 'pay:p:',
} as const;

/**
 * Короткие коды рельсов для `callback_data`.
 *
 * Предел там 64 **байта**, а `telegram:stars` с двоеточием ещё и
 * пересекается с нашим же разделителем. Один знак и однозначен, и не
 * ломается от переименования рельса.
 */
const CODE_OF_RAIL: Readonly<Record<Rail, string>> = {
  'robokassa:smz': 'r',
  'telegram:stars': 's',
};

const RAIL_OF_CODE = new Map<string, Rail>(
  RAILS.map((rail) => [CODE_OF_RAIL[rail], rail] as const),
);

export interface BillingHandlerDeps {
  /**
   * Куда сообщить об обращении по оплате (§14, ревизия этапа 4).
   *
   * Реплика `/paysupport` обещает разобраться и вернуть деньги, а
   * возврат делается руками — значит обращение обязано дойти до
   * человека, а не только лечь в базу. Необязательна: без неё остаётся
   * запись в журнале, и это законное состояние на стенде и в проверках.
   */
  readonly onSupport?:
    ((who: { readonly tgId: number; readonly userId?: string }) => Promise<void>) | undefined;
  readonly db: Database;
  readonly settings: SettingsRegistry;
  readonly logger: Logger;
  /**
   * Куда ведёт кнопка «Оферта» на экране согласия (§14).
   *
   * Робокасса требует кликабельную ссылку на оферту рядом с отметкой
   * согласия. Адрес приходит из `OFFER_URL`; заглушка в бою ловится при
   * подъёме, как у политики.
   */
  readonly offerUrl: string;
  /**
   * Провайдеры по рельсам. Рельс без провайдера просто не показывается:
   * кнопка, за которой нет провайдера, обманывает.
   *
   * Паритет правил Telegram требует, чтобы звёзды были всегда, когда есть
   * рублёвая оплата. Следит за этим запуск (`src/index.ts`), а не экран:
   * здесь мы уже показываем то, что дали.
   */
  readonly providers: Partial<Record<Rail, PaymentProvider>>;
}

/** Рельсы, у которых есть провайдер. */
function railsOf(deps: BillingHandlerDeps): Rail[] {
  return RAILS.filter((rail) => deps.providers[rail] !== undefined);
}

/** Живая подписка человека: самая долгая из оплаченных. */
function liveOne(
  subscriptions: readonly BillingSubscription[],
  now: number,
): BillingSubscription | undefined {
  return subscriptions
    .filter((one) => one.currentPeriodEnd.getTime() > now)
    .sort((first, second) => second.currentPeriodEnd.getTime() - first.currentPeriodEnd.getTime())
    .at(0);
}

/**
 * Кнопки тарифов — только то, что действительно можно купить.
 *
 * Цена задаётся в панели (§15.3), и до её назначения продавать нечего:
 * кнопка «оплатить» с нулём — это либо бесплатная подписка, либо отказ в
 * момент нажатия, и оба варианта хуже отсутствия кнопки. Рельс без
 * провайдера не показывается по той же причине.
 */
async function planRows(
  deps: BillingHandlerDeps,
  texts: TextProfile,
): Promise<{ label: string; action: string }[][]> {
  const offers = await sellable(deps.settings, railsOf(deps));

  return offers.map((offer) => {
    const planName = offer.plan === 'monthly' ? texts.billing.monthly : texts.billing.yearly;
    const railName =
      offer.rail === 'telegram:stars' ? texts.billing.payByStars : texts.billing.payByCard;

    return [
      {
        label: `${texts.billing.planButton(planName, priceText(offer.price))} · ${railName}`,
        action: `${BILLING_ACTION.buyPrefix}${CODE_OF_RAIL[offer.rail]}:${offer.plan}`,
      },
    ];
  });
}

/** Экран подписки: что показать и какие кнопки дать. */
async function screen(
  deps: BillingHandlerDeps,
  userId: string,
): Promise<{ readonly text: string; readonly rows: { label: string; action: string }[][] }> {
  const context = await outputContextOf(deps.db, userId);
  const texts = textsFor(context.textProfile);

  const plans = await planRows(deps, texts);
  const rows = plans.length === 0 ? plans : [...plans, ...(await promoRow(deps, texts, userId))];

  const live = liveOne(await subscriptionsOf(deps.db, userId), Date.now());

  if (live === undefined) {
    return rows.length === 0
      ? { text: texts.billing.noPrice, rows: [] }
      : { text: texts.billing.choose, rows };
  }

  const until = untilText(live.currentPeriodEnd);

  /**
   * У платящего кнопки тарифов остаются.
   *
   * Не «уже оплачено, приходите потом»: с месячного тарифа переходят на
   * годовой, а отменённое продление включают обратно новой оплатой. Убери
   * кнопки — и оба пути пришлось бы просить словами.
   */
  return {
    text: live.autoRenew ? texts.billing.active(until) : texts.billing.activeNoRenew(until),
    rows: live.autoRenew
      ? [[{ label: texts.billing.buttonCancel, action: BILLING_ACTION.cancel }], ...rows]
      : rows,
  };
}

/**
 * Кнопка промокода — только тому, кому скидка вообще положена.
 *
 * Скидка на **первый** период: у платившего кнопка обещала бы то, чего
 * не будет, и он получил бы отказ после ввода кода. Проверка — тот же
 * запрос, которым `promoFor` решает то же самое; здесь он спрашивается
 * один раз на открытие экрана, а не на каждый тариф.
 */
async function promoRow(
  deps: BillingHandlerDeps,
  texts: TextProfile,
  userId: string,
): Promise<{ label: string; action: string }[][]> {
  const paid = await paidInvoicesCount(deps.db, userId);

  return paid > 0 ? [] : [[{ label: texts.billing.buttonPromo, action: BILLING_ACTION.promo }]];
}

/**
 * Выставить счёт и отправить ссылку.
 *
 * Общее для обычной покупки и покупки по промокоду: путь один, отличие —
 * одно поле `promo`. Две копии этого кода разошлись бы в оговорке про
 * продление, а она и есть главное, что человек здесь читает.
 */
async function sendCheckout(
  deps: BillingHandlerDeps,
  ctx: Pick<Context, 'reply'>,
  params: {
    readonly userId: string;
    readonly tgId: number;
    readonly plan: PlanKind;
    readonly rail: Rail;
    readonly provider: PaymentProvider;
    readonly texts: TextProfile;
    readonly promo?: PromoOffer | undefined;
    /** Решение человека с экрана согласия; пусто — как решит провайдер. */
    readonly renewable?: boolean | undefined;
  },
): Promise<void> {
  const { texts } = params;
  const planName = params.plan === 'monthly' ? texts.billing.monthly : texts.billing.yearly;

  try {
    const outcome = await startCheckout(deps.db, {
      userId: params.userId,
      tgId: params.tgId,
      plan: params.plan,
      rail: params.rail,
      settings: deps.settings,
      provider: params.provider,
      /**
       * Название счёта — не больше 32 знаков: столько принимает Telegram.
       * Провайдер обрежет и сам, но обрезка «ВЫДОХ — под…» читается хуже,
       * чем короткая строка, написанная сразу.
       */
      title: `ВЫДОХ, ${planName.toLowerCase()}`,
      description: `Подписка на ВЫДОХ: разбор новых записей, ${planName.toLowerCase()}.`,
      ...(params.promo === undefined ? {} : { promo: params.promo }),
      ...(params.renewable === undefined ? {} : { renewable: params.renewable }),
    });

    if (!outcome.ok) {
      await ctx.reply(texts.billing.noPrice);
      return;
    }

    /**
     * Оговорка про продление берётся у провайдера.
     *
     * Он один знает правду: у звёзд годовой тариф продлеваться не умеет
     * вовсе, а у Робокассы продление работает только после согласования
     * услуги. Скажи мы «продлевается» от себя — и половина людей узнала
     * бы обратное из своего банка.
     */
    const note = outcome.checkout.autoRenews ? texts.billing.renewNote : texts.billing.oneTimeNote;

    await ctx.reply(texts.billing.linkSent(note), {
      reply_markup: {
        inline_keyboard: [[{ text: texts.billing.buttonPay, url: outcome.checkout.url }]],
      },
    });
  } catch (error) {
    deps.logger.error(
      { err: error, rail: params.rail, plan: params.plan },
      'Не удалось выставить счёт',
    );
    await ctx.reply(texts.billing.checkoutFailed);
  }
}

/**
 * Экран согласия на автосписания перед оплатой месяца (§14; оферта
 * п. 2.3, 7.2; требование Робокассы к форме оплаты).
 *
 * **Отметка не проставлена заранее, и это условие, а не вкус.** Робокасса
 * согласовывает автосписания только с чекбоксом, который человек ставит
 * сам; оферта обещает то же. Без отметки кнопка оплаты всё равно есть —
 * платёж уходит разовым: человек, который не хочет автосписаний, не
 * должен ради этого искать другой тариф.
 *
 * **Дата первого списания считается тем же кодом, каким списывает проход
 * продления** (`firstRenewalChargeAt`): назвать одну дату, а списать в
 * другую — ровно то, что письмо Робокассы называет «автопродлением без
 * уведомления».
 *
 * Годовой тариф и промо-счёт сюда не попадают: они разовые по
 * устройству, и спрашивать согласие на списания, которых не будет,
 * значило бы пугать.
 */
async function consentView(
  deps: BillingHandlerDeps,
  params: {
    readonly userId: string;
    readonly rail: Rail;
    readonly consented: boolean;
    readonly texts: TextProfile;
  },
): Promise<
  | { readonly ok: true; readonly text: string; readonly keyboard: InlineKeyboardMarkup }
  | { readonly ok: false }
> {
  const { texts } = params;
  const price = await priceOf(deps.settings, { plan: 'monthly', rail: params.rail });

  if (price === undefined) return { ok: false };

  const now = new Date();
  const live = liveOne(await subscriptionsOf(deps.db, params.userId), now.getTime());
  const firstCharge = firstRenewalChargeAt({
    now,
    ...(live === undefined ? {} : { currentPeriodEnd: live.currentPeriodEnd }),
  });

  const code = CODE_OF_RAIL[params.rail];
  const flag = params.consented ? '1' : '0';

  return {
    ok: true,
    text: `${texts.billing.consentScreen(priceText(price), untilText(firstCharge))}

${params.consented ? texts.billing.consentOn : texts.billing.consentOff}`,
    keyboard: {
      inline_keyboard: [
        [
          {
            text: params.consented ? texts.billing.buttonConsentOn : texts.billing.buttonConsentOff,
            // Нажатие переводит в противоположное состояние.
            callback_data: `${BILLING_ACTION.consentPrefix}${code}:${params.consented ? '0' : '1'}`,
          },
        ],
        [
          {
            text: texts.billing.buttonPay,
            callback_data: `${BILLING_ACTION.goPrefix}${code}:${flag}`,
          },
        ],
        [{ text: texts.billing.buttonOffer, url: deps.offerUrl }],
      ],
    },
  };
}

/**
 * Почему код не подошёл — словами, которые человек может исправить.
 *
 * «Код не подошёл» без причины отправляет его писать в поддержку, а из
 * пяти причин четыре он исправляет сам.
 */
function promoRefusal(texts: TextProfile, why: string): string {
  switch (why) {
    case 'not-first':
      return texts.billing.promoNotFirst;
    case 'spent':
      return texts.billing.promoSpent;
    case 'expired':
    case 'disabled':
      return texts.billing.promoExpired;
    default:
      // Нет такого кода, не тот тариф, снятая цена — для человека это
      // одно и то же: код не работает, а проверять надо написание.
      return texts.billing.promoUnknown;
  }
}

/** Тексты того, кто нажал. Человека может и не быть — тогда общие. */
async function textsOf(deps: BillingHandlerDeps, userId?: string): Promise<TextProfile> {
  if (userId === undefined) return textsFor();

  const context = await outputContextOf(deps.db, userId);

  return textsFor(context.textProfile);
}

/**
 * Приём промокода словами (§14, задача 4.4).
 *
 * Отдаётся приёму ответов (`consumeAwaited`) обратным вызовом: тот стоит
 * **раньше** гейта доступа и раньше потолка частоты, поэтому код вводит
 * и человек с кончившимся пробным периодом, и ввод не тратит ни
 * выгрузку, ни обращение к модели.
 *
 * Собирается здесь, а не там, потому что для проверки кода нужны реестр
 * цен и провайдеры оплаты — про них приёму ответа знать нечего.
 *
 * **Кнопки перерисовываются со скидкой, а не выставляется счёт.** Код
 * может подойти к обоим рельсам, и выбор рельса остаётся за человеком;
 * плюс между вводом и нажатием он ещё может передумать.
 */
export function createPromoConsumer(deps: BillingHandlerDeps) {
  return async (ctx: Context, userId: string, raw: string): Promise<boolean> => {
    const texts = await textsOf(deps, userId);
    const code = normalizeCode(raw);

    /**
     * Непохожее на код не съедается.
     *
     * Человек мог вместо кода сказать мысль — тогда она обязана уйти в
     * разбор, а не пропасть. Ровно тот дефект, что уже был: «ответ съедал
     * мысль».
     *
     * И отказ Telegram на самой реплике «не похоже на код» мысль тоже не
     * теряет: сообщение к этому моменту сохранено, ожидание снято, а к
     * выгрузке оно ещё не привязано — исключение отсюда уносило бы его
     * из приёма до привязки, и оно оставалось бы сиротой навсегда, как
     * «не понял» имя или время (ревизия этапов 1–2). Обёртка та же и
     * одна на все пять таких отправок: что пишется в журнал, решается в
     * одном месте.
     */
    if (code === undefined) {
      await sayNotUnderstood(ctx, deps.logger, userId, texts.billing.promoUnknown);
      return false;
    }

    const rails = railsOf(deps);
    const rows: { label: string; action: string }[][] = [];
    let refusal: string | undefined;
    let applied: { plan: string; price: string; full: string } | undefined;

    for (const rail of rails) {
      for (const plan of PLANS) {
        const outcome = await promoFor(deps.db, {
          code,
          userId,
          rail,
          plan,
          settings: deps.settings,
        });

        if (!outcome.ok) {
          /**
           * Причина запоминается первая **осмысленная**.
           *
           * Код проверяется на четырёх сочетаниях рельса и тарифа, и
           * «не тот тариф» вернётся у трёх из них даже у годного кода.
           * Сказать человеку «такого кода нет» из-за этого значило бы
           * соврать, поэтому «уже платил», «кончился» и «истёк» имеют
           * приоритет: они про него, а не про сочетание.
           */
          if (refusal === undefined || outcome.why !== 'unknown') {
            refusal = promoRefusal(texts, outcome.why);
          }
          continue;
        }

        const planName = plan === 'monthly' ? texts.billing.monthly : texts.billing.yearly;
        const railName =
          rail === 'telegram:stars' ? texts.billing.payByStars : texts.billing.payByCard;

        rows.push([
          {
            label: `${texts.billing.promoButton(planName, priceText(outcome.offer.price))} · ${railName}`,
            action: `${BILLING_ACTION.promoBuyPrefix}${CODE_OF_RAIL[rail]}:${plan}:${code}`,
          },
        ]);

        applied = {
          plan: planName,
          price: priceText(outcome.offer.price),
          full: priceText(outcome.offer.full),
        };
      }
    }

    if (rows.length === 0 || applied === undefined) {
      /**
       * **Отказ возвращает к выбору тарифа кнопками** (ревизия этапа 4).
       *
       * Реплика `promoAsk` обещает: «если не подойдёт, я скажу почему и
       * верну к выбору тарифа». Обещание не исполнялось: ожидание кода
       * снималось, кнопок не приходило, и слово «пришлите ещё раз»
       * выполнить было нельзя — присланный код уходил в разбор как
       * мысль. Человек оставался с отказом и без выхода.
       *
       * Теперь под отказом те же кнопки, что на экране подписки, включая
       * «У меня есть промокод»: обещание исполнено, а второй код можно
       * прислать, нажав её.
       */
      const plans = await planRows(deps, texts);
      const back =
        plans.length === 0 ? plans : [...plans, ...(await promoRow(deps, texts, userId))];

      await ctx.reply(refusal ?? texts.billing.promoUnknown, {
        ...(back.length === 0 ? {} : { reply_markup: fitKeyboard(back) }),
      });

      return true;
    }

    await ctx.reply(texts.billing.promoApplied(applied.plan, applied.price, applied.full), {
      reply_markup: fitKeyboard(rows),
    });

    return true;
  };
}

export function registerBillingHandlers(bot: Bot, deps: BillingHandlerDeps): void {
  bot.callbackQuery(BILLING_ACTION.open, async (ctx) => {
    await ctx.answerCallbackQuery();

    const user = await findByTgId(deps.db, ctx.from.id);
    if (user === undefined) return;

    const view = await screen(deps, user.id);

    await ctx.reply(view.text, {
      ...(view.rows.length === 0 ? {} : { reply_markup: fitKeyboard(view.rows) }),
    });
  });

  bot.callbackQuery(
    new RegExp(`^${BILLING_ACTION.buyPrefix}([a-z]):(monthly|yearly)$`, 'u'),
    async (ctx) => {
      await ctx.answerCallbackQuery();

      const user = await findByTgId(deps.db, ctx.from.id);
      if (user === undefined) return;

      const texts = await textsOf(deps, user.id);

      const [code, plan] = ctx.callbackQuery.data.slice(BILLING_ACTION.buyPrefix.length).split(':');

      const rail = code === undefined ? undefined : RAIL_OF_CODE.get(code);
      const provider = rail === undefined ? undefined : deps.providers[rail];

      if (rail === undefined || provider === undefined || plan === undefined) {
        // Кнопка из старого сообщения, а рельс с тех пор выключили.
        await ctx.reply(texts.billing.checkoutFailed);
        return;
      }

      if (plan === 'monthly') {
        // Месяц умеет продлеваться — значит сперва согласие, потом счёт.
        const view = await consentView(deps, { userId: user.id, rail, consented: false, texts });

        await ctx.reply(view.ok ? view.text : texts.billing.noPrice, {
          ...(view.ok ? { reply_markup: view.keyboard } : {}),
        });
        return;
      }

      await sendCheckout(deps, ctx, {
        userId: user.id,
        tgId: ctx.from.id,
        plan: 'yearly',
        rail,
        provider,
        texts,
      });
    },
  );

  bot.callbackQuery(
    new RegExp(`^${BILLING_ACTION.consentPrefix}([a-z]):([01])$`, 'u'),
    async (ctx) => {
      await ctx.answerCallbackQuery();

      const user = await findByTgId(deps.db, ctx.from.id);
      if (user === undefined) return;

      const texts = await textsOf(deps, user.id);
      const [code, flag] = ctx.callbackQuery.data
        .slice(BILLING_ACTION.consentPrefix.length)
        .split(':');
      const rail = code === undefined ? undefined : RAIL_OF_CODE.get(code);

      if (rail === undefined || deps.providers[rail] === undefined) {
        await ctx.reply(texts.billing.checkoutFailed);
        return;
      }

      const view = await consentView(deps, {
        userId: user.id,
        rail,
        consented: flag === '1',
        texts,
      });

      if (!view.ok) {
        await ctx.reply(texts.billing.noPrice);
        return;
      }

      /**
       * Правится то же сообщение, а не шлётся новое: два экрана согласия
       * с разными отметками — это два разных ответа на один вопрос, и
       * человек не поймёт, который из них бот считает его решением.
       */
      await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
    },
  );

  bot.callbackQuery(new RegExp(`^${BILLING_ACTION.goPrefix}([a-z]):([01])$`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const user = await findByTgId(deps.db, ctx.from.id);
    if (user === undefined) return;

    const texts = await textsOf(deps, user.id);
    const [code, flag] = ctx.callbackQuery.data.slice(BILLING_ACTION.goPrefix.length).split(':');
    const rail = code === undefined ? undefined : RAIL_OF_CODE.get(code);
    const provider = rail === undefined ? undefined : deps.providers[rail];

    if (rail === undefined || provider === undefined) {
      await ctx.reply(texts.billing.checkoutFailed);
      return;
    }

    await sendCheckout(deps, ctx, {
      userId: user.id,
      tgId: ctx.from.id,
      plan: 'monthly',
      rail,
      provider,
      texts,
      // Решение человека едет в кнопке: «1» — согласился на автосписания.
      renewable: flag === '1',
    });
  });

  bot.callbackQuery(BILLING_ACTION.cancel, async (ctx) => {
    await ctx.answerCallbackQuery();

    const user = await findByTgId(deps.db, ctx.from.id);
    if (user === undefined) return;

    const texts = await textsOf(deps, user.id);

    const live = (await subscriptionsOf(deps.db, user.id)).filter(
      (one) => one.autoRenew && one.currentPeriodEnd.getTime() > Date.now(),
    );

    if (live.length === 0) {
      await ctx.reply(texts.billing.nothingToCancel);
      return;
    }

    let until: Date | undefined;

    for (const subscription of live) {
      const rail = subscription.provider as Rail;
      const provider = deps.providers[rail];

      /**
       * Сначала говорим провайдеру, потом себе.
       *
       * Обратный порядок дал бы вид «продление отключено» при живом
       * автосписании: человек увидел бы у нас отмену, а деньги списались
       * бы через месяц. Провайдер не смог — не отменяем и у себя, и
       * говорим об этом, а не молчим.
       */
      if (provider !== undefined && subscription.subscriptionRef !== null) {
        try {
          await provider.stopRenewal({
            tgId: ctx.from.id,
            subscriptionRef: subscription.subscriptionRef,
          });
        } catch (error) {
          deps.logger.error({ err: error, rail }, 'Провайдер не отменил продление');
          await ctx.reply(texts.billing.checkoutFailed);
          return;
        }
      }

      const stopped = await cancelRenewal(deps.db, { userId: user.id, provider: rail });

      if (stopped.paidUntil !== undefined) {
        until = until === undefined || stopped.paidUntil > until ? stopped.paidUntil : until;
      }
    }

    await ctx.reply(
      until === undefined
        ? texts.billing.nothingToCancel
        : texts.billing.renewalStopped(untilText(until)),
    );
  });

  /**
   * Спросить код словами (§14, задача 4.4).
   *
   * Ответ принимает уже готовое ожидание — то же, которым бот принимает
   * имя и город. Оно стоит **раньше** гейта доступа и раньше потолка
   * частоты, поэтому код вводит и человек с кончившимся пробным
   * периодом, и ввод не тратит ни выгрузку, ни обращение к модели.
   */
  bot.callbackQuery(BILLING_ACTION.promo, async (ctx) => {
    await ctx.answerCallbackQuery();

    const user = await findByTgId(deps.db, ctx.from.id);
    if (user === undefined) return;

    await setAwaiting(deps.db, user.id, AWAITING.promo);
    await ctx.reply((await textsOf(deps, user.id)).billing.promoAsk);
  });

  bot.callbackQuery(
    new RegExp(`^${BILLING_ACTION.promoBuyPrefix}([a-z]):(monthly|yearly):([A-Z0-9-]{4,24})$`, 'u'),
    async (ctx) => {
      await ctx.answerCallbackQuery();

      const user = await findByTgId(deps.db, ctx.from.id);
      if (user === undefined) return;

      const texts = await textsOf(deps, user.id);

      const [code, plan, promoCode] = ctx.callbackQuery.data
        .slice(BILLING_ACTION.promoBuyPrefix.length)
        .split(':');

      const rail = code === undefined ? undefined : RAIL_OF_CODE.get(code);
      const provider = rail === undefined ? undefined : deps.providers[rail];

      if (
        rail === undefined ||
        provider === undefined ||
        plan === undefined ||
        promoCode === undefined
      ) {
        await ctx.reply(texts.billing.checkoutFailed);
        return;
      }

      const planKind = plan === 'monthly' ? 'monthly' : 'yearly';

      /**
       * Код проверяется **заново**, в момент выставления счёта.
       *
       * Между вводом и нажатием кнопки проходит время, за которое код
       * может кончиться или быть выключен, а сама строка кнопки
       * подделывается тривиально. Решает проверка, а не кнопка — потому
       * код и может ехать в `callback_data` без риска.
       */
      const checked = await promoFor(deps.db, {
        code: promoCode,
        userId: user.id,
        rail,
        plan: planKind,
        settings: deps.settings,
      });

      if (!checked.ok) {
        await ctx.reply(promoRefusal(texts, checked.why));
        return;
      }

      await sendCheckout(deps, ctx, {
        userId: user.id,
        tgId: ctx.from.id,
        plan: planKind,
        rail,
        provider,
        texts,
        promo: checked.offer,
      });
    },
  );

  /**
   * Подтверждение платежа звёздами — и **отвечать надо за десять секунд**.
   *
   * Так устроен Bot API: не ответили на `pre_checkout_query` — платёж не
   * состоится вовсе, и человек увидит отказ без объяснений. Поэтому здесь
   * ровно одна проверка, по индексу, и никаких обращений наружу.
   *
   * Проверяем существование счёта по метке. Метка случайна и
   * неугадываема, но счёт по ней мог и не завестись — например если
   * ссылку сохранили, а данные удалили. Пропустить такой платёж значило
   * бы взять деньги, которые потом не к чему привязать.
   */
  bot.on('pre_checkout_query', async (ctx) => {
    const ref = ctx.preCheckoutQuery.invoice_payload;

    try {
      const invoice = await invoiceByRef(deps.db, { provider: 'telegram:stars', ref });

      if (invoice?.userId == null) {
        deps.logger.warn({ ref }, 'Оплата звёздами по метке, которой нет в счетах');
        await ctx.answerPreCheckoutQuery(false, (await textsOf(deps)).billing.checkoutFailed);
        return;
      }

      await ctx.answerPreCheckoutQuery(true);
    } catch (error) {
      /**
       * На сбое базы отвечаем отказом, а не молчим.
       *
       * Молчание Telegram трактует как отказ и без нас, но человек тогда
       * ждёт десять секунд и видит ошибку без слов. Отказ с текстом
       * честнее, и деньги в обоих случаях не списываются.
       */
      deps.logger.error({ err: error, ref }, 'Не удалось проверить счёт перед оплатой');

      await ctx.answerPreCheckoutQuery(false, (await textsOf(deps)).billing.checkoutFailed);
    }
  });

  /**
   * Оплата звёздами: и первая, и продление, — приходит сюда.
   *
   * Продление Telegram делает сам и присылает такое же служебное
   * сообщение с `is_recurring`. Разбирает его провайдер (он же отличает
   * первый платёж от продления), а прикладывает — общая служба: она одна
   * и держит идемпотентность, поэтому звёзды и Робокасса ходят одним
   * путём.
   */
  const applyStars = async (
    raw: unknown,
    tgId: number,
    say: (text: string) => Promise<unknown>,
    /**
     * Сказать с кнопкой оплаты — там, где человеку надо заплатить.
     *
     * План обещал «сообщение с кнопкой оплаты» у неудачного продления, а
     * кнопки не было ни в одном из двух путей: человек читал «продление
     * не прошло» и должен был сам вспомнить про `/menu`.
     */
    sayWithPay: (text: string) => Promise<unknown> = say,
  ): Promise<void> => {
    /**
     * **Выключенный рельс больше не глотает оплату.**
     *
     * Найдено ревизией четвёртого этапа. Прежде здесь стояло
     * `if (provider === undefined) return;` — и это был самый дорогой
     * молчаливый отказ в продукте: рельс звёзд выключается переменной
     * окружения, а выключить его можно **после** того, как подписки уже
     * созданы. Telegram продолжает списывать 150 звёзд каждый месяц и
     * присылать нам служебное сообщение; бот выходил первой строкой.
     * Деньги списаны, периода нет, счёт остался `created`, события нет,
     * в журнале тишина, человеку не сказано ничего. Узнать об этом можно
     * было только от него самого — и не по чем было проверить.
     *
     * Разбор для этого не нужен ключами: `readStarsEvent` читает тело
     * апдейта и живёт снаружи провайдера. Дальше событие идёт обычным
     * путём — человек получает то, за что заплатил, а в журнале
     * остаётся громкий след того, что рельс выключен не вовремя.
     */
    const railOff = deps.providers['telegram:stars'] === undefined;

    let event;

    try {
      event = await readStarsEvent(raw);
    } catch (error) {
      deps.logger.error({ err: error, tgId }, 'Служебное сообщение об оплате не разобралось');
      return;
    }

    if (event === undefined) return;

    if (railOff) {
      // Ошибкой, а не предупреждением: это состояние требует правки
      // руками — либо включить рельс, либо отменить подписки людям.
      deps.logger.error(
        { tgId, kind: event.kind },
        'Оплата звёздами пришла при выключенном рельсе: Telegram продолжает списывать',
      );
    }

    const applied = await applyPaymentEvent(deps.db, {
      provider: 'telegram:stars',
      event,
      method: 'stars',
      payload: raw,
    });

    if (applied.kind === 'unknown') {
      deps.logger.error({ why: applied.why, tgId }, 'Оплата звёздами не привязалась к счёту');
      return;
    }

    if (applied.kind === 'promoSpent') {
      /**
       * Та же промо-ссылка оплачена второй раз.
       *
       * Периода по цене со скидкой не выдаём — она на первый период, —
       * но и молчать нельзя: деньги у человека списаны. Отвечаем тем же,
       * чем при недоплате: разбираться будем руками, через /paysupport.
       */
      deps.logger.error(
        { tgId, code: applied.code, paidBefore: applied.paidBefore },
        'Оплачена промо-ссылка повторно: право на скидку израсходовано, разбирать руками',
      );

      // Той же репликой, что при недоплате: разбираться будем руками,
      // через /paysupport — обещание платёжной платформы Telegram.
      await say((await textsOf(deps, undefined)).billing.checkoutFailed);
      return;
    }

    if (applied.kind === 'underpaid') {
      /**
       * Пришло не столько звёзд, сколько в счёте.
       *
       * Через Telegram это почти невозможно — сумму называем мы, — но
       * «почти» здесь не аргумент: проверка стоит один разбор, а её
       * отсутствие однажды стоит месяца за одну звезду. Человеку
       * отвечаем тем же, чем при неудаче оплаты: разбираться будем
       * руками, через /paysupport.
       */
      deps.logger.error(
        { ожидали: applied.expected, пришло: applied.got, tgId },
        'Оплата звёздами не на ту сумму: доступ не выдан',
      );

      const person = await findByTgId(deps.db, tgId);
      await say((await textsOf(deps, person?.id)).billing.checkoutFailed);

      return;
    }

    // Повтор — молча: человек уже получил своё сообщение в первый раз.
    if (applied.kind === 'duplicate') return;

    const user = await findByTgId(deps.db, tgId);
    const texts = await textsOf(deps, user?.id);

    if (applied.kind === 'applied') {
      await say(texts.billing.paid(untilText(applied.paidUntil)));
      return;
    }

    if (applied.kind === 'failed') {
      const live =
        user === undefined
          ? undefined
          : liveOne(await subscriptionsOf(deps.db, user.id), Date.now());

      if (live === undefined) {
        await say(texts.billing.nothingToCancel);
        return;
      }

      await sayWithPay(texts.billing.renewalFailed(untilText(live.currentPeriodEnd)));
    }
  };

  bot.on('message:successful_payment', async (ctx) => {
    await applyStars({ message: ctx.message }, ctx.from.id, (text) => ctx.reply(text));
  });

  /**
   * Возврат звёзд.
   *
   * Возврат делаем мы сами, руками, по обращению в `/paysupport` — но
   * узнать о нём бот обязан: возврат обрывает оплаченный период, и без
   * этого сообщения человек остался бы с доступом за вернувшиеся деньги.
   */
  bot.on('message:refunded_payment', async (ctx) => {
    await applyStars({ message: ctx.message }, ctx.from.id, (text) => ctx.reply(text));
  });

  /**
   * Человек отписался или продление не прошло.
   *
   * Единственный способ об этом узнать: отдельный апдейт `subscription`.
   * Без него мы продолжали бы считать продление включённым и показывали
   * бы человеку неправду на его же экране подписки.
   *
   * Сообщения здесь нет по случаю отмены: человек отписался сам,
   * средствами Telegram, и рассказывать ему о его же действии незачем.
   * А вот про неудачное продление сказать надо — о нём он не знает.
   */
  bot.on('subscription', async (ctx) => {
    const who = ctx.subscription.user.id;

    await applyStars(
      { subscription: ctx.subscription },
      who,
      async (text) => await ctx.api.sendMessage(who, text),
      // Продление не прошло — человеку надо заплатить, и кнопка стоит
      // рядом с новостью, а не в меню, куда он должен догадаться пойти.
      async (text) =>
        await ctx.api.sendMessage(who, text, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: (await textsOf(deps, undefined)).billing.buttonPay,
                  callback_data: BILLING_ACTION.open,
                },
              ],
            ],
          },
        }),
    );
  });
}

/**
 * Команды, которых правила Telegram требуют от бота, продающего
 * цифровые услуги.
 *
 * `/paysupport` назван прямо в условиях платёжной платформы: бот обязан
 * на него отвечать и разбирать вопросы по оплате. `/terms` — из того же
 * проверочного списка, `/support` — привычный человеку синоним, и
 * молчание на него читается как поломка. Цена молчания та же, что у
 * отсутствия звёзд: жалоба и отключение от платформы.
 *
 * **Отдельной функцией, и вызывается она после приёма сообщений** —
 * правка ревизии четвёртого этапа. Прежде эти команды жили вместе с
 * оплатой, а оплата регистрируется **до** приёма (служебное сообщение о
 * платеже иначе уехало бы в буфер выгрузки). Из-за этого обращение
 * человека по `/paysupport` не попадало в базу вовсе: ответ уходил, а
 * сообщения не оставалось — ни в выгрузке, ни в `messages_raw`. То есть
 * «напишите про оплату словами» приглашало написать туда, где записи не
 * будет.
 *
 * Само служебное сообщение об оплате по-прежнему перехватывается до
 * приёма: порядок здесь про команды, а не про платежи.
 */
export function registerPaySupportCommands(bot: Bot, deps: BillingHandlerDeps): void {
  bot.command('paysupport', async (ctx) => {
    const user = ctx.from === undefined ? undefined : await findByTgId(deps.db, ctx.from.id);

    /**
     * **Обращение доходит до человека, а не только в базу** (ревизия 4).
     *
     * Реплика обещает «разберёмся и вернём деньги, если списалось
     * лишнее», а до ревизии это обращение не доходило ни до кого:
     * сообщение не сохранялось вовсе (порядок регистрации), оповещения
     * не было, раздела в панели тоже. Обещание висело в воздухе — при
     * том, что возврат делается руками и начинается именно с него.
     *
     * Теперь: сообщение сохранено (см. порядок регистрации), в журнале
     * стоит запись, а `onSupport` уводит оповещение туда, где его
     * читают. Возврат по-прежнему делает человек — но он о нём узнаёт.
     */
    deps.logger.warn(
      { tgId: ctx.from?.id, userId: user?.id },
      'Обращение по оплате: человек позвал /paysupport',
    );

    await deps.onSupport?.({
      tgId: ctx.from?.id ?? 0,
      ...(user?.id === undefined ? {} : { userId: user.id }),
    });

    await ctx.reply((await textsOf(deps, user?.id)).billing.paySupport);
  });

  bot.command(['terms', 'support'], async (ctx) => {
    const user = ctx.from === undefined ? undefined : await findByTgId(deps.db, ctx.from.id);

    await ctx.reply((await textsOf(deps, user?.id)).billing.terms);
  });
}
