import { and, desc, eq, gt, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { billingInvoices, billingSubscriptions } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { SettingsRegistry } from '../settings/settings.repo.js';
import { effectivePriceAt } from './price-change.service.js';
import type { PlanKind } from './provider.js';
import { RENEWAL_CHARGED_BY, RENEWAL_LEAD_MS, type Price, type Rail } from './tariffs.js';

/**
 * Предупреждение о предстоящем автосписании (оферта п. 7.4.1; письмо
 * Робокассы от 11.09.2026: «автопродление без уведомления — избегайте»).
 *
 * Оферта обещает «не позднее чем за 3 календарных дня до даты
 * списания». Списание по Робокассе уходит за сутки до конца периода
 * (`RENEWAL_LEAD_MS`), проход — раз в час; чтобы три дня выполнялись
 * при любом часе прохода, предупреждение ставится за **четверо** суток
 * до списания. У звёзд списывает Telegram — в конце периода; сумма —
 * та, что была в первом платеже: цену подписки Telegram фиксирует, панель
 * на неё не влияет.
 *
 * Одно предупреждение на период: `renewal_noticed_for` хранит конец
 * периода, о списании за которым сказано; продлилось — период новый, и
 * предупреждение уйдёт снова. После момента списания молчим: говорить
 * «спишется завтра» о вчерашнем — хуже, чем не сказать.
 */
export const RENEWAL_NOTICE_LEAD_MS = 4 * 24 * 3_600_000;

const BATCH = 100;

export interface RenewalNotice {
  readonly userId: string;
  readonly rail: Rail;
  readonly plan: PlanKind;
  readonly price: Price;
  /** Когда спишут. */
  readonly chargeAt: Date;
  /** До какого дня оплачено сейчас — конец периода. */
  readonly periodEnd: Date;
}

export interface RenewalNoticeDeps {
  readonly db: Executor;
  readonly settings: SettingsRegistry;
  readonly logger: Logger;
  readonly notify: (notice: RenewalNotice) => Promise<void>;
}

export interface RenewalNoticeRound {
  readonly noticed: number;
  /** Не о чем предупредить: тариф снят или первого платежа нет. */
  readonly skipped: number;
}

/** Момент списания за период: у нас — за сутки до конца, у Telegram — в конце. */
export function chargeMomentOf(rail: Rail, periodEnd: Date): Date {
  return RENEWAL_CHARGED_BY[rail] === 'us'
    ? new Date(periodEnd.getTime() - RENEWAL_LEAD_MS)
    : periodEnd;
}

export async function runRenewalNotices(
  deps: RenewalNoticeDeps,
  params: { readonly now: Date },
): Promise<RenewalNoticeRound> {
  const { now } = params;
  let noticed = 0;
  let skipped = 0;

  /**
   * Окно по концу периода считается на стороне базы двумя ветками —
   * у рельсов разный отступ списания; предел в SQL широкий (по большему
   * отступу), точная проверка — ниже, по рельсу строки.
   */
  const horizon = new Date(now.getTime() + RENEWAL_NOTICE_LEAD_MS + RENEWAL_LEAD_MS);

  const due = await deps.db
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.status, 'active'),
        eq(billingSubscriptions.autoRenew, true),
        lte(billingSubscriptions.currentPeriodEnd, horizon),
        gt(billingSubscriptions.currentPeriodEnd, now),
        or(
          isNull(billingSubscriptions.renewalNoticedFor),
          ne(billingSubscriptions.renewalNoticedFor, billingSubscriptions.currentPeriodEnd),
        ),
      ),
    )
    .orderBy(billingSubscriptions.currentPeriodEnd)
    .limit(BATCH);

  for (const subscription of due) {
    const rail = subscription.provider as Rail;
    const chargeAt = chargeMomentOf(rail, subscription.currentPeriodEnd);

    // Рано — или уже поздно.
    if (chargeAt.getTime() - RENEWAL_NOTICE_LEAD_MS > now.getTime()) continue;
    if (chargeAt.getTime() <= now.getTime()) continue;

    const price = await priceToCharge(deps, { subscription: { ...subscription, rail }, chargeAt });

    if (price === undefined) {
      deps.logger.warn(
        { userId: subscription.userId, rail, plan: subscription.plan },
        'Предупреждать о списании нечем: цены нет',
      );
      skipped += 1;
      continue;
    }

    try {
      await deps.notify({
        userId: subscription.userId,
        rail,
        plan: subscription.plan,
        price,
        chargeAt,
        periodEnd: subscription.currentPeriodEnd,
      });
    } catch (error) {
      deps.logger.error(
        { err: error, userId: subscription.userId },
        'Не удалось предупредить о списании',
      );
      continue;
    }

    // Отметка — после отправки: не ушло (упало) — попробуем следующим
    // проходом; заблокировавшему бота отправитель молча не пишет, и
    // отметка всё равно ставится — второго шанса дать некому.
    await deps.db
      .update(billingSubscriptions)
      .set({ renewalNoticedFor: subscription.currentPeriodEnd, updatedAt: now })
      .where(
        and(
          eq(billingSubscriptions.id, subscription.id),
          // Продление между выборкой и отметкой сдвинуло период — тогда
          // отметка про старый период не нужна, и новый предупредится сам.
          sql`${billingSubscriptions.currentPeriodEnd} = ${subscription.currentPeriodEnd}`,
        ),
      );
    noticed += 1;
  }

  return { noticed, skipped };
}

export const NOTICE_TICK_MS = 3_600_000;

/**
 * Часовой проход предупреждений — свой, а не в проходе продлений: тот
 * живёт только при подключённой Робокассе, а звёзды продлевает Telegram
 * и без неё, и предупредить о них обязаны так же.
 */
export function startRenewalNotices(
  deps: RenewalNoticeDeps,
  intervalMs = NOTICE_TICK_MS,
): () => void {
  let running = false;

  const tick = (): void => {
    if (running) return;
    running = true;

    void runRenewalNotices(deps, { now: new Date() })
      .then((round) => {
        if (round.noticed > 0 || round.skipped > 0) {
          deps.logger.info(round, 'Проход предупреждений о списании');
        }
      })
      .catch((error: unknown) => {
        deps.logger.error({ err: error }, 'Проход предупреждений о списании не удался');
      })
      .finally(() => {
        running = false;
      });
  };

  tick();
  const timer = setInterval(tick, intervalMs);

  return () => {
    clearInterval(timer);
  };
}

/**
 * Сумма, которую спишут: у нас — цена продления на момент списания
 * (с учётом правила 30 дней), у Telegram — сумма первого платежа.
 */
async function priceToCharge(
  deps: RenewalNoticeDeps,
  params: {
    readonly subscription: {
      readonly userId: string;
      readonly plan: PlanKind;
      readonly rail: Rail;
    };
    readonly chargeAt: Date;
  },
): Promise<Price | undefined> {
  const { subscription } = params;

  if (RENEWAL_CHARGED_BY[subscription.rail] === 'us') {
    return await effectivePriceAt(deps.db, deps.settings, {
      plan: subscription.plan,
      rail: subscription.rail,
      at: params.chargeAt,
    });
  }

  const [first] = await deps.db
    .select({ amountMinor: billingInvoices.amountMinor, currency: billingInvoices.currency })
    .from(billingInvoices)
    .where(
      and(
        eq(billingInvoices.provider, subscription.rail),
        eq(billingInvoices.userId, subscription.userId),
        eq(billingInvoices.status, 'paid'),
      ),
    )
    .orderBy(desc(billingInvoices.createdAt))
    .limit(1);

  if (first === undefined) return undefined;

  return { amountMinor: first.amountMinor, currency: first.currency === 'XTR' ? 'XTR' : 'RUB' };
}
