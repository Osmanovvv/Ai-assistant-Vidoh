import type { Bot } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import type { BillingSubscription } from '../../db/schema.js';
import { invoiceByRef, subscriptionsOf } from '../../modules/billing/billing.repo.js';
import {
  priceText,
  sellable,
  startCheckout,
  untilText,
} from '../../modules/billing/checkout.service.js';
import type { PaymentProvider } from '../../modules/billing/provider.js';
import { applyPaymentEvent, cancelRenewal } from '../../modules/billing/subscription.service.js';
import { RAILS, type Rail } from '../../modules/billing/tariffs.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';
import type { SettingsRegistry } from '../../modules/settings/settings.repo.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor } from '../../texts/index.js';
import type { TextProfile } from '../../texts/types.js';

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
  cancel: 'pay:stop',
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
  readonly db: Database;
  readonly settings: SettingsRegistry;
  readonly logger: Logger;
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

  const rows = await planRows(deps, texts);
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

/** Тексты того, кто нажал. Человека может и не быть — тогда общие. */
async function textsOf(deps: BillingHandlerDeps, userId?: string): Promise<TextProfile> {
  if (userId === undefined) return textsFor();

  const context = await outputContextOf(deps.db, userId);

  return textsFor(context.textProfile);
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

      const planKind = plan === 'monthly' ? 'monthly' : 'yearly';
      const planName = planKind === 'monthly' ? texts.billing.monthly : texts.billing.yearly;

      try {
        const outcome = await startCheckout(deps.db, {
          userId: user.id,
          tgId: ctx.from.id,
          plan: planKind,
          rail,
          settings: deps.settings,
          provider,
          /**
           * Название счёта — не больше 32 знаков: столько принимает
           * Telegram. Провайдер обрежет и сам, но обрезка «ВЫДОХ — под…»
           * читается хуже, чем короткая строка, написанная сразу.
           */
          title: `ВЫДОХ, ${planName.toLowerCase()}`,
          description: `Подписка на ВЫДОХ: разбор новых записей, ${planName.toLowerCase()}.`,
        });

        if (!outcome.ok) {
          await ctx.reply(texts.billing.noPrice);
          return;
        }

        /**
         * Оговорка про продление берётся у провайдера.
         *
         * Он один знает правду: у звёзд годовой тариф продлеваться не
         * умеет вовсе, а у Робокассы продление работает только после
         * согласования услуги. Скажи мы «продлевается» от себя — и
         * половина людей узнала бы обратное из своего банка.
         */
        const note = outcome.checkout.autoRenews
          ? texts.billing.renewNote
          : texts.billing.oneTimeNote;

        await ctx.reply(texts.billing.linkSent(note), {
          reply_markup: {
            inline_keyboard: [[{ text: texts.billing.buttonPay, url: outcome.checkout.url }]],
          },
        });
      } catch (error) {
        deps.logger.error({ err: error, rail, plan: planKind }, 'Не удалось выставить счёт');
        await ctx.reply(texts.billing.checkoutFailed);
      }
    },
  );

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
  ): Promise<void> => {
    const provider = deps.providers['telegram:stars'];
    if (provider === undefined) return;

    let event;

    try {
      event = await provider.readEvent(raw);
    } catch (error) {
      deps.logger.error({ err: error, tgId }, 'Служебное сообщение об оплате не разобралось');
      return;
    }

    if (event === undefined) return;

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

      await say(
        live === undefined
          ? texts.billing.nothingToCancel
          : texts.billing.renewalFailed(untilText(live.currentPeriodEnd)),
      );
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
    await applyStars({ subscription: ctx.subscription }, ctx.subscription.user.id, (text) =>
      ctx.api.sendMessage(ctx.subscription.user.id, text),
    );
  });

  /**
   * Команды, которых правила Telegram требуют от бота, продающего
   * цифровые услуги.
   *
   * `/paysupport` назван прямо в условиях платёжной платформы: бот обязан
   * на него отвечать и разбирать вопросы по оплате. `/terms` — из того же
   * проверочного списка, `/support` — привычный человеку синоним, и
   * молчание на него читается как поломка. Цена молчания та же, что у
   * отсутствия звёзд: жалоба и отключение от платформы.
   */
  bot.command('paysupport', async (ctx) => {
    const user = ctx.from === undefined ? undefined : await findByTgId(deps.db, ctx.from.id);

    await ctx.reply((await textsOf(deps, user?.id)).billing.paySupport);
  });

  bot.command(['terms', 'support'], async (ctx) => {
    const user = ctx.from === undefined ? undefined : await findByTgId(deps.db, ctx.from.id);

    await ctx.reply((await textsOf(deps, user?.id)).billing.terms);
  });
}
