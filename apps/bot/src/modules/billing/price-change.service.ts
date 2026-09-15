import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { Logger } from 'pino';

import { billingPriceChanges, billingSubscriptions } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { SettingsRegistry } from '../settings/settings.repo.js';
import type { PlanKind } from './provider.js';
import { priceOf, RENEWAL_CHARGED_BY, type Price, type Rail } from './tariffs.js';

/**
 * Изменение цены для действующих подписок — правило 30 дней (оферта
 * п. 7.8; письмо Робокассы от 11.09.2026: «изменения цены без
 * предупреждения — избегайте»).
 *
 * Цена живёт в панели и меняется в одну секунду. Продление же обязано
 * списывать прежнюю цену ещё 30 дней после того, как подписчик
 * предупреждён (п. 7.8.2). Значит у цены **для продлений** есть история
 * (`billing_price_changes`): каждая перемена в панели становится строкой
 * с датой вступления в силу, и продление берёт не цену панели, а
 * последнюю вступившую (`effectivePriceAt`). Новые подписки и разовые
 * платежи — по цене панели сразу (п. 7.8.4), они сюда не смотрят.
 *
 * Направление перемены не различается: оферта говорит об изменении, а не
 * о повышении, и снижение тоже объявляется и ждёт 30 дней. Так проще
 * и честнее обещания: «до этой даты списания идут по прежней цене» —
 * дословно.
 *
 * Следим только за рельсами, где списываем мы (`RENEWAL_CHARGED_BY`):
 * звёзды продлевает Telegram по цене, зафиксированной при подписке, и
 * панель на них не влияет.
 */
export const PRICE_CHANGE_NOTICE_MS = 30 * 24 * 3_600_000;

export interface PriceChangeNotice {
  readonly userId: string;
  readonly rail: Rail;
  readonly plan: PlanKind;
  readonly oldPrice: Price;
  readonly newPrice: Price;
  readonly effectiveAt: Date;
}

export interface PriceChangeDeps {
  readonly db: Executor;
  readonly settings: SettingsRegistry;
  readonly logger: Logger;
  readonly notify: (notice: PriceChangeNotice) => Promise<void>;
}

export interface PriceSyncRound {
  /** Первая замеченная цена — вступает сразу, никого не беспокоит. */
  readonly seeded: number;
  /** Объявленных перемен. */
  readonly announced: number;
  /** Сколько подписчиков предупреждено. */
  readonly notified: number;
  /** Отменённых перемен: цену вернули или сменили ещё раз до срока. */
  readonly canceled: number;
}

/** Пары «рельс, тариф», у которых продление делаем мы. */
const WATCHED: readonly { readonly rail: Rail; readonly plan: PlanKind }[] = (
  Object.entries(RENEWAL_CHARGED_BY) as [Rail, 'us' | 'provider'][]
)
  .filter(([, who]) => who === 'us')
  .map(([rail]) => ({ rail, plan: 'monthly' as const }));

/**
 * Цена, по которой продление спишет в момент `at`.
 *
 * Тариф снят (ноль в панели) — продлевать нечем, история этого не
 * отменяет: `undefined`, как и у `priceOf`. Истории ещё нет — цена
 * панели: так было до этого правила, и первая же сверка её запомнит.
 */
export async function effectivePriceAt(
  db: Executor,
  settings: SettingsRegistry,
  params: { readonly plan: PlanKind; readonly rail: Rail; readonly at: Date },
): Promise<Price | undefined> {
  const listed = await priceOf(settings, { plan: params.plan, rail: params.rail });
  if (listed === undefined) return undefined;

  const [inForce] = await db
    .select()
    .from(billingPriceChanges)
    .where(
      and(
        eq(billingPriceChanges.rail, params.rail),
        eq(billingPriceChanges.plan, params.plan),
        isNull(billingPriceChanges.canceledAt),
        lte(billingPriceChanges.effectiveAt, params.at),
      ),
    )
    .orderBy(asc(billingPriceChanges.effectiveAt))
    .then((rows) => rows.slice(-1));

  if (inForce === undefined) return listed;

  return { amountMinor: inForce.amountMinor, currency: currencyOf(inForce.currency) };
}

function currencyOf(value: string): Price['currency'] {
  return value === 'XTR' ? 'XTR' : 'RUB';
}

/**
 * Сверяет цену панели с историей и объявляет перемены.
 *
 * Зовётся тем же часовым проходом, что и продления, **перед** ними:
 * сменили цену в панели — в тот же час она записана в историю с датой
 * вступления, подписчики предупреждены, и ближайшее продление возьмёт
 * прежнюю.
 */
export async function syncPriceChanges(
  deps: PriceChangeDeps,
  params: { readonly now: Date },
): Promise<PriceSyncRound> {
  const { now } = params;
  let seeded = 0;
  let announced = 0;
  let notified = 0;
  let canceled = 0;

  for (const { rail, plan } of WATCHED) {
    const listed = await priceOf(deps.settings, { plan, rail });
    // Тариф снят — не перемена цены, а отсутствие цены; продление само
    // это заметит и сдастся. Историю не трогаем: вернут — продолжим.
    if (listed === undefined) continue;

    const history = await deps.db
      .select()
      .from(billingPriceChanges)
      .where(
        and(
          eq(billingPriceChanges.rail, rail),
          eq(billingPriceChanges.plan, plan),
          isNull(billingPriceChanges.canceledAt),
        ),
      )
      .orderBy(asc(billingPriceChanges.effectiveAt));

    if (history.length === 0) {
      await deps.db.insert(billingPriceChanges).values({
        rail,
        plan,
        amountMinor: listed.amountMinor,
        currency: listed.currency,
        announcedAt: now,
        effectiveAt: now,
      });
      seeded += 1;
      continue;
    }

    const latest = history.at(-1);
    if (latest?.amountMinor === listed.amountMinor && latest.currency === listed.currency) continue;

    const inForce = [...history]
      .reverse()
      .find((row) => row.effectiveAt.getTime() <= now.getTime());
    const pending = history.filter((row) => row.effectiveAt.getTime() > now.getTime());

    // Перемена ещё не вступила, а цену уже сменили снова — прежнее
    // объявление отменяется: обещать две даты сразу нельзя.
    for (const row of pending) {
      await deps.db
        .update(billingPriceChanges)
        .set({ canceledAt: now })
        .where(eq(billingPriceChanges.id, row.id));
      canceled += 1;
    }

    const current: Price | undefined =
      inForce === undefined
        ? undefined
        : { amountMinor: inForce.amountMinor, currency: currencyOf(inForce.currency) };

    // Вернули ту цену, что и так действует, — объявлять нечего.
    if (current?.amountMinor === listed.amountMinor && current.currency === listed.currency) {
      continue;
    }

    const effectiveAt = new Date(now.getTime() + PRICE_CHANGE_NOTICE_MS);
    const [change] = await deps.db
      .insert(billingPriceChanges)
      .values({
        rail,
        plan,
        amountMinor: listed.amountMinor,
        currency: listed.currency,
        announcedAt: now,
        effectiveAt,
      })
      .returning({ id: billingPriceChanges.id });
    announced += 1;

    const subscribers = await deps.db
      .select({ userId: billingSubscriptions.userId })
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.provider, rail),
          eq(billingSubscriptions.plan, plan),
          eq(billingSubscriptions.status, 'active'),
          eq(billingSubscriptions.autoRenew, true),
        ),
      );

    let told = 0;
    for (const { userId } of subscribers) {
      try {
        await deps.notify({
          userId,
          rail,
          plan,
          oldPrice: current ?? listed,
          newPrice: listed,
          effectiveAt,
        });
        told += 1;
      } catch (error) {
        deps.logger.error({ err: error, userId }, 'Не удалось предупредить о новой цене');
      }
    }

    if (change !== undefined) {
      await deps.db
        .update(billingPriceChanges)
        .set({ notified: told })
        .where(eq(billingPriceChanges.id, change.id));
    }
    notified += told;

    deps.logger.info(
      {
        rail,
        plan,
        from: current?.amountMinor,
        to: listed.amountMinor,
        effectiveAt,
        subscribers: subscribers.length,
        told,
      },
      'Цена продления изменена: подписчики предупреждены, вступает через 30 дней',
    );
  }

  return { seeded, announced, notified, canceled };
}
