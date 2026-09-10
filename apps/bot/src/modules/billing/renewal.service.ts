import type { Logger } from 'pino';

import type { BillingSubscription } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { newRef } from './checkout.service.js';
import {
  claimRenewal,
  dueForRenewal,
  markInvoiceFailed,
  nextInvId,
  parentPaymentFor,
} from './billing.repo.js';
import { markPastDue, renewalsAwaitingAnswer, subscriptionOf } from './billing.repo.js';
import { chargeRecurring, type RobokassaDeps } from './providers/robokassa.js';
import type { PaymentProvider } from './provider.js';
import { applyPaymentEvent } from './subscription.service.js';
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
  /**
   * Провайдер — чтобы спросить состояние ушедшей операции.
   *
   * Ответ «OK<номер>» на дочернее списание означает **создание
   * операции**, а не списание денег: узнать исход можно только вопросом
   * (`OpStateExt`). Без него счёт продления, не получивший уведомления,
   * висел бы навсегда, а человек не узнал бы, что доступ кончится.
   *
   * Необязателен: без него разбор зависших не работает, и это законное
   * состояние — так живут все проверки, писавшиеся до ревизии.
   */
  readonly provider?: PaymentProvider | undefined;
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
      /**
       * Цену сняли, а подписка идёт. Списывать наугад нельзя — но и
       * молчать нельзя, и это находка ревизии.
       *
       * Прежде здесь были `warn` и `continue`. Ноль в панели означает
       * «тариф не продаётся», и заказчица ставит его, чтобы закрыть
       * продажу новым, — а вместе с продажей молча останавливались
       * продления **всем действующим** подписчикам. Счёта нет, значит
       * нет и в разделе ошибок; `onFailed` не звался, значит человеку не
       * сказано ничего. Через день-два десять платящих людей слышали
       * «Пробные разборы закончились», а в обзоре стояло «Платят
       * сейчас: 0».
       *
       * Теперь это обычная неудача продления: подписка помечена,
       * человек предупреждён, доступ живёт до конца оплаченного
       * периода. Счёта нет — значит и помечать нечего.
       */
      deps.logger.error(
        { userId: subscription.userId, plan: subscription.plan },
        'Продление некуда считать: цена снята, подписка помечена и человек предупреждён',
      );

      await giveUp(deps, { subscription, now });

      failed += 1;
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
      now,
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

      /**
       * Тем же хвостом, что и явный отказ.
       *
       * Прежде здесь была только запись в журнал: подписка оставалась
       * `active` с включённым продлением, человек не узнавал ничего, и
       * доступ кончался у него внезапно. Разница между «Робокасса
       * отказала» и «Робокасса не ответила» — только в тексте на счёте;
       * для человека это одно и то же событие.
       */
      await giveUp(deps, {
        subscription,
        invoiceId: claimed.id,
        now,
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

    await giveUp(deps, {
      subscription,
      invoiceId: claimed.id,
      now,
      /**
       * Текст — объяснение кода, если оно известно, иначе сырой ответ.
       *
       * «Услуга не подключена магазину» разбирающему говорит всё, а
       * «ERROR: 34» — ничего, пока он не откроет документацию.
       */
      ...(answer.reason === undefined
        ? answer.answer === ''
          ? {}
          : { errorText: answer.answer }
        : { errorText: `${answer.reason} (${answer.answer})` }),
      ...(answer.code === undefined ? {} : { errorCode: answer.code }),
    });

    failed += 1;
  }

  return { charged, failed, skipped };
}

/**
 * Продление не состоялось: пометить, предупредить, оставить доступ.
 *
 * **Одной функцией на все ветки неудачи, и это находка ревизии.** Прежде
 * хвост стоял только у явного отказа Робокассы, а у потерянного ответа
 * была лишь запись в журнал. То есть при обрыве сети человек, который
 * платил и не отменял, просто перестал бы получать разборы седьмого
 * числа — без предупреждения и без объяснения. План обещал обратное
 * дословно, и обещание было неверным.
 *
 * Три действия, и все три обязательны:
 *  - счёт помечен неудачным — иначе он не виден в разделе ошибок;
 *  - подписка помечена `past_due` — иначе она вечно первая в выборке
 *    продления и вытесняет живые (см. `dueForRenewal`);
 *  - человек предупреждён — молчание означает, что доступ кончится
 *    внезапно.
 *
 * Доступ **не** закрывается: §14 велит держать его до конца оплаченного
 * периода. Отобрать сегодня значило бы отобрать оплаченное.
 */
async function giveUp(
  deps: RenewalDeps,
  params: {
    readonly subscription: BillingSubscription;
    /** Счёт продления, если он успел завестись. */
    readonly invoiceId?: string | undefined;
    readonly errorText?: string | undefined;
    /**
     * Код ошибки провайдера (ревизия четвёртого этапа).
     *
     * Прежде столбец `error_code` у неудачного счёта оставался **вечно
     * пустым**: разбор кода существовал, а вызывающих у него не было ни
     * одного вне проверок. В панели неудачное продление выглядело как
     * «что-то не так», хотя код 34 («услуга не подключена») чинит
     * владелец магазина, а код 29 («недостаточно средств») — человек.
     */
    readonly errorCode?: number | undefined;
    readonly now: Date;
  },
): Promise<void> {
  if (params.invoiceId !== undefined) {
    await markInvoiceFailed(deps.db, {
      id: params.invoiceId,
      // Одно «сейчас» на весь отказ: та же метка уходит в `markPastDue`
      // ниже и в письмо человеку. Два своих времени у одного события
      // разошлись бы на длину прохода — и в журнале сбоев отказ стоял бы
      // не тогда, когда подписка стала просроченной.
      now: params.now,
      ...(params.errorText === undefined ? {} : { errorText: params.errorText }),
      ...(params.errorCode === undefined ? {} : { errorCode: params.errorCode }),
    });
  }

  await markPastDue(deps.db, {
    userId: params.subscription.userId,
    provider: ROBOKASSA_RAIL,
    now: params.now,
  });

  /**
   * Человеку говорим сами, и говорим до конца периода.
   *
   * Молчание здесь означало бы, что доступ кончится без предупреждения —
   * худший исход из возможных: он платил, он не отменял, и вдруг бот
   * перестал разбирать.
   */
  if (deps.onFailed === undefined) return;

  try {
    await deps.onFailed({
      userId: params.subscription.userId,
      paidUntil: params.subscription.currentPeriodEnd,
    });
  } catch (error) {
    deps.logger.error(
      { err: error, userId: params.subscription.userId },
      'Не удалось предупредить о неудачном продлении',
    );
  }
}

/**
 * Сколько ждём уведомления, прежде чем спросить самим.
 *
 * Два часа. Робокасса повторяет доставку, банк списывает не мгновенно, и
 * спрашивать через минуту значило бы принять «ещё не дошло» за «денег
 * нет». Два часа при суточном запасе до конца периода оставляют человеку
 * время заплатить руками, если продление всё-таки не прошло.
 */
export const AWAIT_ANSWER_MS = 2 * 3_600_000;

/**
 * Разбор ушедших списаний, не получивших ответа.
 *
 * **Зачем понадобился.** Ответ «OK<номер>» означает создание операции, а
 * не списание денег. Если денег на карте не хватило, уведомления не
 * будет **никогда** — и прежде такой счёт оставался «выставленным»
 * навсегда: не видно ни в выручке, ни в разделе ошибок, а человек не
 * знал, что доступ кончится. Подписка при этом вечно шла первой в
 * выборке продления и вытесняла живые.
 *
 * Здесь спрашиваем провайдера и делаем одно из двух:
 *  - деньги есть, а уведомление потерялось — **доводим оплату сами**.
 *    Ключ идемпотентности у события тот же, что принесло бы уведомление
 *    (номер счёта), поэтому опоздавшее уведомление отобьётся как повтор;
 *  - денег нет — помечаем подписку и предупреждаем человека, оставляя
 *    доступ до конца оплаченного периода (§14).
 */
export async function resolveAwaiting(deps: RenewalDeps): Promise<{
  readonly finished: number;
  readonly failed: number;
  readonly unknown: number;
}> {
  const provider = deps.provider;

  if (provider === undefined) return { finished: 0, failed: 0, unknown: 0 };

  const now = deps.now?.() ?? new Date();

  const waiting = await renewalsAwaitingAnswer(deps.db, {
    provider: ROBOKASSA_RAIL,
    olderThan: new Date(now.getTime() - AWAIT_ANSWER_MS),
    limit: BATCH,
  });

  let finished = 0;
  let failed = 0;
  let unknown = 0;

  for (const invoice of waiting) {
    if (invoice.userId === null || invoice.invId === null) {
      unknown += 1;
      continue;
    }

    const subscription = await subscriptionOf(deps.db, {
      userId: invoice.userId,
      provider: ROBOKASSA_RAIL,
    });

    if (subscription === undefined) {
      unknown += 1;
      continue;
    }

    let state;

    try {
      state = await provider.statusOf({
        tgId: 0,
        subscriptionRef: String(invoice.invId),
      });
    } catch (error) {
      /**
       * Не спросилось — не решаем ничего.
       *
       * Сеть моргнула, Робокасса не ответила: следующий проход
       * переспросит. Принять молчание провайдера за «денег нет» значило
       * бы напугать платящего человека без причины.
       */
      deps.logger.warn(
        { err: error, invId: invoice.invId },
        'Состояние ушедшего списания не спросилось: переспросим следующим проходом',
      );
      unknown += 1;
      continue;
    }

    if (state === undefined) {
      unknown += 1;
      continue;
    }

    if (state.active) {
      /**
       * Деньги есть, уведомление потерялось — доводим сами.
       *
       * Событие строится тем же ключом, который принёс бы уведомление:
       * номером счёта. Значит опоздавшее уведомление отобьётся как
       * повтор, а не продлит период второй раз.
       */
      const applied = await applyPaymentEvent(deps.db, {
        provider: ROBOKASSA_RAIL,
        event: {
          kind: 'paid',
          externalId: String(invoice.invId),
          ref: invoice.ref,
          amount: invoice.amountMinor,
          currency: invoice.currency,
          renewal: true,
        },
        method: 'opstate',
        payload: { source: 'opstate', invId: invoice.invId },
        now,
      });

      deps.logger.warn(
        { invId: invoice.invId, applied: applied.kind },
        'Уведомление о продлении потерялось, оплата доведена по состоянию операции',
      );

      finished += 1;
      continue;
    }

    deps.logger.error(
      { invId: invoice.invId, userId: invoice.userId },
      'Продление не оплачено: помечаю подписку и предупреждаю человека',
    );

    await giveUp(deps, {
      subscription,
      invoiceId: invoice.id,
      now,
      errorText: 'операция создана, но денег не поступило',
    });

    failed += 1;
  }

  return { finished, failed, unknown };
}

/**
 * Как часто просыпается продление.
 *
 * Час, а не сутки. Суточный проход, упавший на перезапуск, отложил бы
 * списание на сутки — и у половины подписок кончился бы период. Часовой
 * лишнего не спишет: за период каждый человек попадает в выборку много
 * раз, а взять деньги может только один — тот, кто первым завёл продление
 * на этот период.
 *
 * **Одного часа для этого мало, и это находка ревизии этапов 1–2.**
 * Перезапуск заводит таймер заново, то есть обнуляет час; выкладки чаще
 * часа не оставляют продлению ни одного прохода. Довод про перезапуск
 * был записан здесь с самого начала — и не был доведён до конца.
 * Доводит его первый проход при подъёме (см. `startRenewals`).
 */
export const RENEWAL_TICK_MS = 3_600_000;

/** Запускает продление и возвращает способ его остановить. */
export function startRenewals(deps: RenewalDeps, intervalMs = RENEWAL_TICK_MS): () => void {
  let running = false;

  const tick = (): void => {
    if (running) return;
    running = true;

    void runRenewals(deps)
      .then(async (round) => {
        if (round.charged > 0 || round.failed > 0) {
          deps.logger.info(round, 'Проход продления подписок');
        }

        /**
         * Разбор зависших идёт тем же тиком, а не своим таймером.
         *
         * Два расписания на одно дело разошлись бы: списание уходит в
         * одном проходе, а разбирать его исход стал бы другой, и
         * порядок между ними стал бы делом случая.
         */
        const resolved = await resolveAwaiting(deps);

        if (resolved.finished > 0 || resolved.failed > 0) {
          deps.logger.info(resolved, 'Разбор ушедших списаний без ответа');
        }
      })
      .catch((error: unknown) => {
        deps.logger.error({ err: error }, 'Проход продления не удался');
      })
      .finally(() => {
        running = false;
      });
  };

  /**
   * Первый проход — при подъёме, а не через час (ревизия этапов 1–2).
   *
   * Выкладка убивает процесс и заводит таймер заново, то есть обнуляет
   * час. День, когда выкладок больше одной в час, — это ровно тот день,
   * когда что-то чинят, — и продление не проходит **ни разу**. Стоит
   * оно дорого: списание уходит за сутки до конца периода, и в том же
   * проходе живёт `giveUp`. Человек, который платил и не отменял,
   * остался бы и без подписки, и без предупреждения.
   *
   * **Второго списания это не создаёт**, и держит это не осторожность
   * здесь, а база: продление на период заводится уникальным индексом
   * «рельс, человек, конец периода», а уже заведённое исключает
   * человека из выборки (`dueForRenewal`). Проверено на настоящей базе
   * выкладкой посреди суток списания, а не выведено рассуждением.
   *
   * У досмотра первого прохода нет **нарочно** (`startRecoverySweep`):
   * его работу при подъёме делает `recoverAfterRestart`, и второй раз
   * она была бы вредна — досмотр вернул бы в очередь то, что подъём
   * миллисекундой раньше отдал воркеру. У продления второго входа нет,
   * значит и повторять нечего.
   *
   * Проход не ждут: подъём бота не должен упираться в Робокассу. От
   * наложения на первый тик защищает тот же `running`, что и всегда.
   */
  tick();

  const timer = setInterval(tick, intervalMs);

  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
