import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { newRef } from './checkout.service.js';
import {
  claimRenewal,
  dueForRenewal,
  markInvoiceFailed,
  nextInvId,
  parentPaymentFor,
} from './billing.repo.js';
import { markPastDue } from './billing.repo.js';
import { chargeRecurring, type RobokassaDeps } from './providers/robokassa.js';
import type { SettingsRegistry } from '../settings/settings.repo.js';
import { priceOf, type Rail } from './tariffs.js';

/**
 * Продление рублёвой подписки (§14 ТЗ, задача 4.2).
 *
 * Продлевать самим приходится только на рельсе Робокассы: у звёзд это
 * делает Telegram, а мы лишь получаем служебное сообщение. Отсюда и
 * форма — суточный проход, а не очередь: продление привязано к дате, а не
 * к событию.
 *
 * **Попытка одна на период, и это решение, а не упрощение.** Ответ
 * «Робокасса не ответила» не означает «не списала»: операция могла
 * создаться, а ответ потеряться в сети. Повтори мы такую попытку — и
 * человек заплатил бы дважды. Поэтому на неудаче подписка помечается
 * `past_due`, человек узнаёт об этом сообщением с кнопкой оплаты, а
 * доступ живёт до конца оплаченного периода, как требует §14.
 *
 * Запрет второй попытки держит **база**, а не этот код: уникальный
 * индекс по тройке «рельс, человек, конец продлеваемого периода». Второй
 * процесс, второй проход и перезапуск в середине упираются в него все
 * трое.
 *
 * **Списываем на сутки раньше срока.** Не для запаса скорости: неудачное
 * списание оставляет человеку день, чтобы заплатить руками и не потерять
 * доступ ни на час. Период при этом не съедается — он считается от конца
 * оплаченного, а не от «сейчас».
 */

/** За сколько до конца периода уходит списание. */
export const RENEWAL_LEAD_MS = 24 * 3_600_000;

/** Сколько подписок берём за проход. */
const BATCH = 50;

export const ROBOKASSA_RAIL: Rail = 'robokassa:smz';

export interface RenewalDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly robokassa: RobokassaDeps;
  readonly settings: SettingsRegistry;
  /** Кому сказать, что продление не прошло. */
  readonly onFailed?:
    ((params: { readonly userId: string; readonly paidUntil: Date }) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface RenewalRound {
  /** Списаний создано. */
  readonly charged: number;
  /** Неудач: ответ Робокассы был отказом. */
  readonly failed: number;
  /** Пропущено — уже есть продление за этот период либо нечем продлевать. */
  readonly skipped: number;
}

/**
 * Один проход продления.
 *
 * Отдельно от таймера, чтобы его можно было позвать в тесте и не ждать
 * сутки: как только проход зависит от собственного расписания, проверить
 * его становится нечем.
 */
export async function runRenewals(deps: RenewalDeps): Promise<RenewalRound> {
  const now = deps.now?.() ?? new Date();
  const before = new Date(now.getTime() + RENEWAL_LEAD_MS);

  const due = await dueForRenewal(deps.db, {
    provider: ROBOKASSA_RAIL,
    before,
    limit: BATCH,
  });

  let charged = 0;
  let failed = 0;
  let skipped = 0;

  for (const subscription of due) {
    /**
     * Цена берётся **сейчас**, а не с материнского платежа.
     *
     * Иначе изменение цены в панели не доходило бы до тех, кто уже
     * платит, — а именно они и есть те, чья цена меняется.
     */
    const price = await priceOf(deps.settings, {
      plan: subscription.plan,
      rail: ROBOKASSA_RAIL,
    });

    if (price === undefined) {
      // Цену сняли, а подписка идёт. Списывать наугад нельзя.
      deps.logger.warn(
        { userId: subscription.userId, plan: subscription.plan },
        'Продление некуда считать: цена снята',
      );
      skipped += 1;
      continue;
    }

    const parent = await parentPaymentFor(deps.db, {
      provider: ROBOKASSA_RAIL,
      userId: subscription.userId,
    });

    if (parent?.providerInvId == null) {
      /**
       * Нет материнского платежа с фактическим номером — продлевать
       * нечем, и выдумывать номер нельзя: дочернее списание уйдёт в
       * пустоту, а Робокасса ответит ошибкой 40.
       */
      deps.logger.error(
        { userId: subscription.userId },
        'Продление без материнского платежа: нечего указать в PreviousInvoiceID',
      );
      skipped += 1;
      continue;
    }

    const invId = await nextInvId(deps.db);

    const claimed = await claimRenewal(deps.db, {
      provider: ROBOKASSA_RAIL,
      userId: subscription.userId,
      plan: subscription.plan,
      kind: 'renewal',
      amountMinor: price.amountMinor,
      currency: price.currency,
      ref: newRef(),
      invId,
      parentInvId: parent.providerInvId,
      renewsPeriodEnd: subscription.currentPeriodEnd,
    });

    if (claimed === undefined) {
      // Продление за этот период уже заведено — другим проходом или
      // другим процессом. Второй раз денег не берём.
      skipped += 1;
      continue;
    }

    let answer;

    try {
      answer = await chargeRecurring(deps.robokassa, {
        previousInvoiceId: parent.providerInvId,
        invoiceId: invId,
        amountMinor: price.amountMinor,
        ref: claimed.ref,
        description: 'Продление подписки на ВЫДОХ',
      });
    } catch (error) {
      /**
       * Робокасса не ответила — и это **не** «не списала».
       *
       * Операция могла создаться, а ответ потеряться. Повторять нельзя:
       * заплатит дважды. Поэтому считаем попытку израсходованной и ждём
       * уведомления: придёт — подписка продлится сама; не придёт —
       * человек увидит просьбу оплатить.
       */
      deps.logger.error(
        { err: error, userId: subscription.userId, invId },
        'Ответ на дочернее списание потерян: повтора не будет',
      );

      await markInvoiceFailed(deps.db, {
        id: claimed.id,
        errorText: 'ответ на дочернее списание потерян',
      });
      failed += 1;
      continue;
    }

    if (answer.created) {
      /**
       * Срок не двигается здесь.
       *
       * `OK<номер>` означает **создание операции**, а не списание денег:
       * подписку продлевает пришедшее уведомление. Сдвинуть срок сейчас
       * значило бы подарить месяц за неудачную попытку.
       */
      charged += 1;
      continue;
    }

    await markInvoiceFailed(deps.db, {
      id: claimed.id,
      ...(answer.answer === '' ? {} : { errorText: answer.answer }),
    });

    await markPastDue(deps.db, {
      userId: subscription.userId,
      provider: ROBOKASSA_RAIL,
      now,
    });

    /**
     * Человеку говорим сами, и говорим до конца периода.
     *
     * Молчание здесь означало бы, что доступ кончится без предупреждения
     * — худший исход из возможных: он платил, он не отменял, и вдруг
     * бот перестал разбирать.
     */
    if (deps.onFailed !== undefined) {
      try {
        await deps.onFailed({
          userId: subscription.userId,
          paidUntil: subscription.currentPeriodEnd,
        });
      } catch (error) {
        deps.logger.error(
          { err: error, userId: subscription.userId },
          'Не удалось предупредить о неудачном продлении',
        );
      }
    }

    failed += 1;
  }

  return { charged, failed, skipped };
}

/**
 * Как часто просыпается продление.
 *
 * Час, а не сутки. Суточный проход, упавший на перезапуск, отложил бы
 * списание на сутки — и у половины подписок кончился бы период. Часовой
 * лишнего не спишет: за период каждый человек попадает в выборку много
 * раз, а взять деньги может только один — тот, кто первым завёл продление
 * на этот период.
 */
export const RENEWAL_TICK_MS = 3_600_000;

/** Запускает продление и возвращает способ его остановить. */
export function startRenewals(deps: RenewalDeps, intervalMs = RENEWAL_TICK_MS): () => void {
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;

    void runRenewals(deps)
      .then((round) => {
        if (round.charged > 0 || round.failed > 0) {
          deps.logger.info(round, 'Проход продления подписок');
        }
      })
      .catch((error: unknown) => {
        deps.logger.error({ err: error }, 'Проход продления не удался');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
