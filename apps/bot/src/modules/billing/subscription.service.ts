import { and, eq, isNull, sql, type AnyColumn, type SQL } from 'drizzle-orm';

import { batches, billingSubscriptions } from '../../db/schema.js';
import type { Database, Executor } from '../../infra/db.js';
import type { SettingsRegistry } from '../settings/settings.repo.js';
import {
  createInvoice,
  endPeriodNow,
  invoiceByRef,
  markEventProcessed,
  markInvoiceFailed,
  markInvoicePaid,
  markInvoiceRefunded,
  markPastDue,
  recordEvent,
  stopAutoRenew,
  subscriptionOf,
  subscriptionsOf,
  upsertSubscription,
} from './billing.repo.js';
import type { PaymentEvent, PaymentProvider } from './provider.js';
import { periodEndAfter, renewFrom, type Rail } from './tariffs.js';

/**
 * Пробный период и деградация (§14 ТЗ, задача 4.3).
 *
 * **Пробный период считается выгрузками, а не днями** — так требует §14,
 * и это не придирка к формулировке: женщина, которая записала три мысли
 * за месяц, не должна терять доступ раньше той, что записала тридцать за
 * неделю. Дни мерят наше терпение, выгрузки — её пользу.
 *
 * **Что считается тратой.** Только доведённый до конца разбор. Не
 * считаются:
 *  - быстрое добавление «добавь ещё купить витамины» (§13.3) — плана
 *    4.3 требование прямое, и оно справедливо: полсекунды не равны
 *    разбору;
 *  - сбой на нашей стороне — иначе человек платит попыткой за нашу
 *    поломку;
 *  - выгрузка, висящая в очереди из-за отказа модели: 05.09.2026 доступ
 *    к Yandex закрылся, и такие выгрузки ждут в `queued`, ничего не
 *    потратив;
 *  - ответ на вопрос бота и нажатие кнопки — они выгрузкой не
 *    становятся вовсе.
 *
 * Отметку ставит разбор, в самом конце удавшегося пути (`dump.handler`).
 * Здесь только чтение и подсчёт: служба не решает, потратилась ли
 * выгрузка, — она отвечает, сколько уже потрачено.
 *
 * **Деградация — это чтение без записи.** §14: «после окончания доступа
 * бэклог остаётся доступен на чтение, новые выгрузки блокируются, данные
 * не удаляются». Поэтому запрет живёт ровно в одном месте — там, где
 * сообщение превращается в выгрузку, — и ни в одном другом. Меню,
 * карточки, напоминания и вопросы по бэклогу идут мимо: нажатие кнопки
 * не проходит через приём сообщений вовсе.
 *
 * **Подписка пришла задачей 4.2, и обещание сдержано:** `accessOf`
 * получила второй источник доступа, а всё остальное — гейт, реплика,
 * деградация — осталось как было. Гейт по-прежнему один, в приёме
 * сообщений, и по-прежнему не знает, откуда взялся доступ.
 *
 * **Оплата живёт здесь же, а не рядом.** Пробный период и подписка
 * отвечают на один и тот же вопрос — «можно ли человеку завести
 * выгрузку», — и разводить их по разным службам значило бы, что однажды
 * одна разрешит, а другая нет.
 */

export interface AccessState {
  /** Можно ли заводить новую выгрузку. */
  readonly allowed: boolean;
  /**
   * Чем открыт доступ. Нужно не для красоты: реплика человеку разная,
   * и пробный период не должен тратиться у того, кто уже платит.
   */
  readonly source: 'trial' | 'subscription' | 'none';
  /** До какого времени оплачено, если доступ от подписки. */
  readonly paidUntil?: Date | undefined;
  /** Сколько выгрузок пробного периода уже потрачено. */
  readonly spent: number;
  /** Сколько всего даёт пробный период. */
  readonly limit: number;
  /** Сколько осталось. Ноль — пробный период исчерпан. */
  readonly left: number;
}

/**
 * Есть ли у человека право на новую выгрузку.
 *
 * Считается запросом, а не счётчиком в профиле: счётчик, разойдясь с
 * правдой, не сверяется ни с чем, а этот подсчёт всегда равен тому, что
 * человек увидит в своей карточке в админке.
 */
export async function accessOf(
  db: Executor,
  params: {
    readonly userId: string;
    readonly settings: SettingsRegistry;
    readonly now?: Date | undefined;
  },
): Promise<AccessState> {
  const now = params.now ?? new Date();
  const limit = await params.settings.number('trialDumps');
  const spent = await trialSpent(db, params.userId);
  const left = Math.max(0, limit - spent);

  /**
   * **Подписка спрашивается первой, и порядок здесь — смысл.**
   *
   * Человек, который платит, не должен тратить пробный период: иначе,
   * отменив подписку через год, он остался бы вообще без ничего, хотя
   * бесплатными выгрузками не пользовался. Поэтому доступ от подписки
   * не только разрешает выгрузку, но и отменяет отметку о трате
   * (см. `markTrialSpent`).
   *
   * Рельсы складываются по максимуму: у человека может оказаться и
   * подписка за рубли, и подписка за звёзды — тогда действует та, что
   * кончается позже. Обратное («последняя выигрывает») отобрало бы
   * оплаченное у того, кто заплатил дважды.
   */
  const paid = await subscriptionsOf(db, params.userId);

  const paidUntil = paid
    .map((one) => one.currentPeriodEnd)
    .filter((end) => end.getTime() > now.getTime())
    .sort((first, second) => second.getTime() - first.getTime())[0];

  if (paidUntil !== undefined) {
    return { allowed: true, source: 'subscription', paidUntil, spent, limit, left };
  }

  return {
    allowed: spent < limit,
    source: spent < limit ? 'trial' : 'none',
    spent,
    limit,
    left,
  };
}

/**
 * Платит ли человек прямо сейчас.
 *
 * Отдельно от `accessOf`, потому что у неё другой вопрос: та отвечает
 * «пустить ли», а эта — «тратить ли пробный период». Считать одно через
 * другое значило бы тащить реестр настроек туда, где он не нужен.
 */
export async function hasPaidAccess(
  db: Executor,
  params: { readonly userId: string; readonly now?: Date | undefined },
): Promise<boolean> {
  const now = params.now ?? new Date();
  const paid = await subscriptionsOf(db, params.userId);

  return paid.some((one) => one.currentPeriodEnd.getTime() > now.getTime());
}

/**
 * Сколько пробных выгрузок у человека — условием SQL, а не числом.
 *
 * Одно определение на всех, кто про это спрашивает: гейт доступа, сегмент
 * рассылки, воронка. Сегодня оно было написано **тремя** способами, и
 * своё определение в любом из них означало бы, что панель показывает
 * воронку не про тех людей, которых бот на самом деле блокирует.
 *
 * Принимает выражение «чей человек»: у гейта это конкретный
 * идентификатор, у рассылки и у воронки — колонка соседней таблицы.
 */
export function trialSpentSql(who: SQL | AnyColumn | string): SQL {
  return sql`(
    select count(*) from ${batches}
    where ${batches.userId} = ${who} and ${batches.trialCountedAt} is not null
  )`;
}

/** Исчерпан ли пробный период — тем же условием. */
export function trialOverSql(who: SQL | AnyColumn | string, limit: number): SQL {
  return sql`${trialSpentSql(who)} >= ${limit}`;
}

/**
 * Сколько выгрузок этого человека потратили пробный период.
 *
 * Считает **тем же** условием, что отдаёт `trialSpentSql`, а не своим
 * запросом. Иначе извлечение вышло бы половинчатым: я убрал бы третье
 * определение и завёл четвёртое, а расхождение гейта с воронкой — ровно
 * то, против чего всё это делалось.
 */
export async function trialSpent(db: Executor, userId: string): Promise<number> {
  const result = await db.execute<{ total: number }>(
    sql`select ${trialSpentSql(sql`${userId}::uuid`)}::int as total`,
  );

  return result.rows[0]?.total ?? 0;
}

/**
 * Отметить, что эта выгрузка потратила пробный период.
 *
 * Только если ещё не отмечена: повторная обработка одной выгрузки не
 * должна тратить период дважды, а `processUserBatches` возвращает
 * выгрузку в очередь при временном сбое — то есть повтор здесь не
 * теоретический.
 *
 * **И только если человек не платит** (задача 4.2). Иначе платящий тратил
 * бы бесплатные выгрузки, которыми не пользовался, и, отменив подписку
 * через год, остался бы вообще без ничего. Проверка стоит внутри условия
 * запроса, а не рядом с ним: между чтением «платит ли» и записью отметки
 * успевает пройти оплата, и тогда отметка встала бы уже платящему.
 *
 * Возвращает `true`, если отметка поставлена именно этим вызовом.
 */
export async function markTrialSpent(
  db: Executor,
  params: {
    readonly batchId: string;
    /**
     * Предел, действующий сейчас (задача 4.4).
     *
     * Передаётся значением, а не читается здесь: реестр настроек — тот
     * же, из которого предел читает гейт, и второй читатель мимо реестра
     * разошёлся бы с первым на разборе мусора и на умолчании.
     *
     * Не задан — момент «конец пробного» не пишется, и воронка честно
     * скажет, что третьего шага у неё нет. Это законное состояние: так
     * работали все проверки, писавшиеся до 4.4.
     */
    readonly trialLimit?: number | undefined;
    readonly now?: Date | undefined;
  },
): Promise<boolean> {
  const now = params.now ?? new Date();

  const updated = await db
    .update(batches)
    .set({ trialCountedAt: now })
    .where(
      and(
        eq(batches.id, params.batchId),
        isNull(batches.trialCountedAt),
        sql`not exists (
          select 1 from ${billingSubscriptions}
          where ${billingSubscriptions.userId} = ${batches.userId}
            and ${billingSubscriptions.currentPeriodEnd} > ${now}
        )`,
      ),
    )
    .returning({ id: batches.id, userId: batches.userId });

  const marked = updated[0];

  if (marked === undefined) return false;

  /**
   * Последняя капля — момент конца пробного периода (4.4).
   *
   * Пишется той же выгрузкой, которая предел добила, и ровно один раз на
   * человека: за это отвечает уникальный индекс, а не порядок вызовов.
   * `on conflict` здесь не нужен — условие `where` само отбивает
   * повторную запись, а гонку двух процессов отобьёт индекс, и его отказ
   * означал бы настоящую ошибку.
   */
  if (params.trialLimit === undefined || params.trialLimit <= 0) return true;

  const spent = await trialSpent(db, marked.userId);

  if (spent < params.trialLimit) return true;

  await db
    .update(batches)
    .set({ trialOverAt: now, trialLimit: params.trialLimit })
    .where(
      and(
        eq(batches.id, params.batchId),
        isNull(batches.trialOverAt),
        sql`not exists (
          select 1 from ${batches} as already
          where already.user_id = ${marked.userId} and already.trial_over_at is not null
        )`,
      ),
    );

  return true;
}

// ── Оплаченная подписка (§14, задача 4.2) ─────────────────────────────

/**
 * Приложить событие оплаты. Возвращает, что произошло.
 *
 * **Идемпотентность — условие готовности задачи 4.2**, и держится она не
 * здесь, а в базе: `recordEvent` вставляет строку с уникальным ключом
 * «рельс, идентификатор у провайдера, вид». Первая доставка вставилась —
 * обрабатываем; повторная не вставилась — молча отвечаем «уже
 * обработано». Проверять чтением было бы неверно: Робокасса повторяет
 * уведомления, в том числе одновременно, и две параллельные доставки
 * прошли бы обе.
 *
 * **Событие с несошедшейся подписью сюда не попадает** — его отбивает
 * обработчик уведомления, но записывает в журнал (§16): подделка обязана
 * быть видна, а не выглядеть посторонним запросом.
 */
export type AppliedEvent =
  | { readonly kind: 'applied'; readonly paidUntil: Date }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'failed' }
  /**
   * Заплатили не столько, сколько в счёте, — доступа не даём.
   *
   * Подпись при этом сошлась: это не подделка, а другая сумма. Робокасса
   * присылает `OutSum` — сумму, **зачисленную магазину**, и она может
   * отличаться от запрошенной: конвертация валюты, изменение суммы в
   * кабинете, частичная оплата. Считать любой пришедший платёж полным
   * значило бы продать месяц за рубль.
   *
   * Событие записано и видно в панели: деньги пришли, услуга не выдана,
   * и разбирать это должен человек.
   */
  | {
      readonly kind: 'underpaid';
      readonly expected: number;
      readonly got: number;
      readonly currency: string;
    }
  /** Событие не про нас: метки нет в счетах. */
  | { readonly kind: 'unknown'; readonly why: string };

export async function applyPaymentEvent(
  db: Database,
  params: {
    readonly provider: Rail;
    readonly event: PaymentEvent;
    readonly method?: string | undefined;
    readonly payload?: unknown;
    /**
     * Сумма строкой, как пришла от провайдера.
     *
     * Хранится сырой, потому что подпись считается по строке: в бою
     * Робокасса присылает шесть знаков после точки, в тесте два, и
     * воспроизвести подпись по числу потом невозможно.
     */
    readonly outSum?: string | undefined;
    readonly now?: Date | undefined;
  },
): Promise<AppliedEvent> {
  /**
   * **Всё тело — одна транзакция, и это защита денег.**
   *
   * Найдено ревизией четвёртого этапа. Барьер идемпотентности —
   * уникальный индекс `billing_events` — вставлялся первым, а работа
   * (пометить счёт оплаченным, продлить подписку) шла отдельными
   * запросами после него. Значит **барьер переживал работу, которую
   * охраняет**: моргни база или убей процесс выкладкой между вставкой
   * события и продлением подписки — и повторная доставка отбивалась как
   * «уже обработано», хотя обработки не было.
   *
   * Итог того сценария: счёт помечен оплаченным, выручка посчитана,
   * подписки нет, доступа нет, человеку не сказано ничего, а в журнале
   * стоит обвинение в подделке — потому что сбой уходил в тот же
   * `catch`, что и несошедшаяся подпись. Обнаружить это можно было
   * только по жалобе человека, который заплатил.
   *
   * В транзакции откат снимает и барьер: следующая доставка (Робокасса
   * повторяет, пока не получит `OK`) доработает начатое. Наружу из
   * транзакции ничего не уходит — оповещение человека зовёт вызывающий,
   * уже после успеха.
   */
  return await db.transaction(async (tx) => await applyInside(tx, params));
}

async function applyInside(
  db: Executor,
  params: {
    readonly provider: Rail;
    readonly event: PaymentEvent;
    readonly method?: string | undefined;
    readonly payload?: unknown;
    readonly outSum?: string | undefined;
    readonly now?: Date | undefined;
  },
): Promise<AppliedEvent> {
  const now = params.now ?? new Date();
  const event = params.event;

  const invoice = await invoiceByRef(db, { provider: params.provider, ref: event.ref });

  if (invoice === undefined) {
    return { kind: 'unknown', why: `метки ${event.ref} нет ни в одном счёте` };
  }

  if (invoice.userId === null) {
    /**
     * Человек удалил данные, а платёж пришёл — и след обязан остаться.
     *
     * **Найдено ревизией четвёртого этапа.** Прежде здесь стоял простой
     * возврат `unknown` — до записи события. Робокасса получала `OK` и
     * не повторяла, строки события не было, счёт оставался
     * «выставленным»: деньги пришли и не были видны **нигде** — ни в
     * выручке (та считает оплаченные), ни в разделе ошибок (тот читает
     * неудачные). Обращение «я заплатила» в панели не находилось.
     *
     * Сценарий не выдуманный: человек нажимает «Перейти к оплате», уходит
     * на страницу провайдера и до её завершения нажимает «Удалить мои
     * данные».
     *
     * Теперь событие записывается, а счёт помечается оплаченным
     * пришедшей суммой. Доступ возвращать некому — подписка ушла
     * каскадом вместе с человеком, — но деньги видны, и разобрать
     * обращение есть чем. Обезличенные строки панель уже умеет
     * показывать.
     */
    const externalId = 'externalId' in event ? event.externalId : `${event.kind}:${event.ref}`;

    const noted = await recordEvent(db, {
      provider: params.provider,
      externalId,
      kind: event.kind,
      signatureOk: true,
      payload: params.payload ?? {},
      ...(params.method === undefined ? {} : { method: params.method }),
      invoiceId: invoice.id,
    });

    if (!noted.first) return { kind: 'duplicate' };

    if (event.kind === 'paid') {
      await markInvoicePaid(db, {
        id: invoice.id,
        ...(params.outSum === undefined ? {} : { outSumReceived: params.outSum }),
        now,
      });
    }

    if (noted.id !== undefined) await markEventProcessed(db, noted.id, now);

    return { kind: 'unknown', why: 'счёт обезличен: человек удалил данные' };
  }

  /**
   * Ключ идемпотентности берётся у провайдера, а где его нет — у метки.
   *
   * У денежных событий это идентификатор платежа: он уникален и у
   * продлений тоже. У «человек отключил продление» такого ключа нет и не
   * нужно: выставить признак дважды — то же, что один раз.
   */
  const externalId = 'externalId' in event ? event.externalId : `${event.kind}:${event.ref}`;

  const noted = await recordEvent(db, {
    provider: params.provider,
    externalId,
    kind: event.kind,
    signatureOk: true,
    payload: params.payload ?? {},
    ...(params.method === undefined ? {} : { method: params.method }),
    invoiceId: invoice.id,
  });

  if (!noted.first) return { kind: 'duplicate' };

  const finish = async (): Promise<void> => {
    if (noted.id !== undefined) await markEventProcessed(db, noted.id, now);
  };

  if (event.kind === 'renewalStopped') {
    await stopAutoRenew(db, { userId: invoice.userId, provider: params.provider, now });
    await finish();

    return { kind: 'stopped' };
  }

  if (event.kind === 'renewalFailed') {
    /**
     * Доступ не закрывается здесь.
     *
     * Продление не прошло — значит деньги не списались, но оплаченный
     * период ещё идёт: §14 велит держать доступ до его конца. Закрыть
     * сегодня значило бы отобрать оплаченное.
     */
    await markPastDue(db, { userId: invoice.userId, provider: params.provider, now });
    await finish();

    return { kind: 'failed' };
  }

  if (event.kind === 'refunded') {
    /**
     * Возврат обрывает оплаченный период немедленно.
     *
     * Деньги вернулись — значит услуга не оплачена. Оставить доступ до
     * конца периода значило бы отдать месяц бесплатно, и это не то же
     * самое, что отмена автопродления: там человек **заплатил** и вправе
     * дожить период.
     *
     * **Частичный возврат обрывает период целиком, и это осознанно.**
     * Сумма здесь не сверяется нарочно: возврат у нас ручной — его
     * делает человек, разобравший обращение через `/paysupport`, — и
     * пропорционально урезать срок он умеет лучше любой формулы. Гадать
     * же, «сколько месяца осталось после возврата трёхсот рублей из
     * трёхсот девяноста девяти», значит однажды посчитать не так.
     */
    await stopAutoRenew(db, { userId: invoice.userId, provider: params.provider, now });
    await endPeriodNow(db, { userId: invoice.userId, provider: params.provider, now });

    /**
     * И счёт помечается возвращённым, а не остаётся оплаченным.
     *
     * **Найдено ревизией.** Прежде доступ снимался правильно, а счёт
     * оставался `paid`: выручка в панели продолжала считать вернувшиеся
     * деньги, отличить возврат было нечем, а человек навсегда числился
     * платившим — то есть терял право на промокод «первый период», не
     * получив периода.
     */
    await markInvoiceRefunded(db, { id: invoice.id, now });

    await finish();

    return { kind: 'stopped' };
  }

  /**
   * Осталось `paid`. И прежде чем выдать месяц — сверить сумму.
   *
   * **Подпись не про сумму, а про целостность.** Она подтверждает, что
   * уведомление от Робокассы, а не то, что заплачено столько, сколько мы
   * просили: `OutSum` — сумма, зачисленная магазину, и она может
   * отличаться от запрошенной. Без этой сверки платёж на рубль по счёту
   * на 399 давал бы полный месяц, и заметить это было бы нечем: событие
   * прошло, подписка продлилась, в журнале успех.
   *
   * Сравнение «меньше», а не «не равно»: переплату забирать у человека
   * незачем, а доступ он получил. Валюта сверяется тоже — 150 звёзд по
   * рублёвому счёту это не 150 рублей.
   */
  if (event.currency !== invoice.currency || event.amount < invoice.amountMinor) {
    await markInvoiceFailed(db, {
      id: invoice.id,
      errorText: `заплачено ${String(event.amount)} ${event.currency}, а в счёте ${String(invoice.amountMinor)} ${invoice.currency}`,
      ...(params.outSum === undefined ? {} : { outSumReceived: params.outSum }),
    });

    await finish();

    return {
      kind: 'underpaid',
      expected: invoice.amountMinor,
      got: event.amount,
      currency: event.currency,
    };
  }

  const subscription = await subscriptionOf(db, {
    userId: invoice.userId,
    provider: params.provider,
  });

  /**
   * Срок считается от конца оплаченного, а не от «сейчас».
   *
   * Иначе продление, пришедшее на день позже (а оно придёт позже:
   * списание не мгновенно), съедало бы у человека день каждый месяц.
   * Просроченное продление, наоборот, считается от «сейчас» — дарить
   * время задним числом не за что.
   *
   * Если провайдер сам сказал, до какого срока оплачено, верим ему:
   * у звёзд это `subscription_expiration_date`, и спорить с Telegram о
   * его же подписке бессмысленно.
   */
  const from = subscription === undefined ? now : renewFrom(subscription.currentPeriodEnd, now);
  const paidUntil = event.paidUntil ?? periodEndAfter(from, invoice.plan);

  /**
   * Фактический номер счёта берётся из идентификатора платежа.
   *
   * У Робокассы это и есть пришедший `InvId` — тот, по которому потом
   * пойдёт продление. У звёзд идентификатор не числовой, и номера тут
   * нет вовсе; поле останется пустым, и это верно.
   */
  const providerInvId = /^\d+$/u.test(externalId) ? Number(externalId) : undefined;

  /**
   * Продление оплаченного счёта заводит **новую** строку, а не правит
   * старую.
   *
   * Так устроены звёзды: Telegram присылает продление с тем же
   * `invoice_payload`, и счёт по метке находится **тот же самый** — тот,
   * что оплачен месяц назад. Пометь мы его оплаченным снова, и `paid_at`
   * уехал бы на новую дату, уничтожив дату первого платежа, а выручка
   * увидела бы за три месяца **один** платёж вместо трёх. Отчёт по
   * звёздному рельсу занижался бы ровно на всё, кроме последнего периода.
   *
   * Схема и говорит «одна строка на каждую попытку оплаты» — здесь это
   * правило и восстанавливается. Робокассы это не касается: у неё
   * продление уже заводит свой счёт со своей меткой (`claimRenewal`), и
   * сюда приходит именно он, ещё неоплаченный.
   *
   * `invoiceByRef` берёт самый свежий счёт по метке, поэтому следующее
   * продление найдёт эту новую строку, а не первую.
   *
   * **Условие «это продление» здесь убрано на ревизии.** Промо-счёт
   * уходит разовым, значит вторая оплата **той же ссылки** приходит без
   * признака продления — и прежде переписывала уже оплаченную строку:
   * восемьдесят звёзд получены, сорок учтены, в промокодах «одно
   * применение» вместо двух. Дважды оплаченная ссылка — это два платежа,
   * чем бы они себя ни называли.
   */
  const paying =
    invoice.status === 'paid'
      ? await createInvoice(db, {
          provider: params.provider,
          userId: invoice.userId,
          plan: invoice.plan,
          /**
           * Вид берём у события, а не ставим «продление» всегда.
           *
           * Вторая оплата разовой ссылки продлением не является: назвать
           * её так значило бы соврать в отчёте о том, за что заплатили.
           */
          kind: event.renewal ? 'renewal' : 'initial',
          amountMinor: event.amount,
          currency: event.currency,
          ref: invoice.ref,
          /**
           * Скидка не переносится ни на продление, ни на вторую оплату.
           *
           * Промокод — на первый период; поставь мы здесь его код и
           * полную цену, «недополучено по кодам» росло бы каждый месяц
           * само. Пустая полная цена означает «без скидки».
           */
          autoRenew: event.renewal,
        })
      : invoice;

  await markInvoicePaid(db, {
    id: paying.id,
    ...(providerInvId === undefined || !Number.isSafeInteger(providerInvId)
      ? {}
      : { providerInvId }),
    ...(params.outSum === undefined ? {} : { outSumReceived: params.outSum }),
    now,
  });

  await upsertSubscription(db, {
    userId: invoice.userId,
    provider: params.provider,
    plan: invoice.plan,
    currentPeriodEnd: paidUntil,
    ...(event.subscriptionRef === undefined ? {} : { subscriptionRef: event.subscriptionRef }),
    /**
     * Автопродление берётся с счёта, а не угадывается по тарифу.
     *
     * Прежде здесь стояло `plan === 'monthly'`, и это была догадка,
     * неверная на **обоих** рельсах: у звёзд годовой тариф продлеваться не
     * умеет вовсе (`subscription_period` в Bot API обязан быть тридцатью
     * днями), а у Робокассы даже месячное продление работает лишь после
     * согласования услуги. Пометь мы подписку продлеваемой без обещания —
     * человек ждал бы автосписания, которого не будет, а суточный
     * работник каждый день ходил бы списывать несписуемое.
     *
     * Пришедшее продление — доказательство, что продление **умеет**
     * работать, и только это. О воле человека оно не говорит ничего:
     * решение «включить обратно или нет» принимает `upsertSubscription`,
     * читая отметку отмены существующей строки. Отмена в один тап (§14)
     * не должна превращаться в отмену на один раз.
     */
    autoRenew: event.renewal ? true : (invoice.autoRenew ?? false),
    renewal: event.renewal,
    now,
  });

  await finish();

  return { kind: 'applied', paidUntil };
}

/**
 * Отменить продление у всех провайдеров — перед удалением данных (§16).
 *
 * **Найдено ревизией четвёртого этапа, и это была утечка денег
 * человека.** Ключ отмены звёздной подписки лежит в
 * `billing_subscriptions.subscription_ref`, а эта строка уходит
 * **каскадом** вместе с человеком: §16 требует удалить его данные, и
 * ключ — тоже его данные.
 *
 * Что получалось: человек с звёздной подпиской нажимал «удалить данные»,
 * бот отвечал «Готово. Всё удалено», а Telegram продолжал списывать 150
 * звёзд каждый месяц. Отменить это не мог **никто**: он — потому что бот
 * отвечал «нечего отменять» (подписок в базе нет), мы — потому что ключа
 * больше не существовало, панель — по той же причине. Деньги уходили
 * ежемесячно и бессрочно.
 *
 * Поэтому отмена зовётся **до** удаления. Наружу мы ходим до
 * транзакции, а не внутри: держать замок на строках, пока отвечает
 * Telegram, значило бы поставить удаление данных в зависимость от чужой
 * доступности.
 *
 * **Отказ провайдера удаление не отменяет.** §16 — право человека, и
 * заложником чужого сбоя оно быть не может. Но и молчать нельзя: тогда
 * он узнает о списании из своего счёта. Отказ возвращается наверх,
 * чтобы бот сказал словами, где отменить подписку самому.
 */
export async function stopAllRenewals(
  db: Executor,
  params: {
    readonly userId: string;
    readonly tgId: number;
    readonly providers: Partial<Record<Rail, PaymentProvider>>;
    readonly logger?: { readonly error: (context: object, message: string) => void } | undefined;
    readonly now?: Date | undefined;
  },
): Promise<{ readonly stopped: readonly Rail[]; readonly failed: readonly Rail[] }> {
  const now = params.now ?? new Date();
  const stopped: Rail[] = [];
  const failed: Rail[] = [];

  for (const subscription of await subscriptionsOf(db, params.userId)) {
    const rail = subscription.provider as Rail;

    /**
     * Отменяем только то, что ещё может списаться.
     *
     * Кончившийся период списаний не породит, а звать провайдера по
     * мёртвой подписке — это лишний отказ, который человек прочтёт как
     * «что-то не удалилось».
     */
    if (!subscription.autoRenew || subscription.currentPeriodEnd.getTime() <= now.getTime()) {
      continue;
    }

    const provider = params.providers[rail];

    if (provider === undefined || subscription.subscriptionRef === null) {
      /**
       * Отменять нечем — и это тоже отказ, а не «всё в порядке».
       *
       * Рельс выключен или ключа не было: списание продолжится, а
       * сказать об этом надо. Молчание здесь и есть та самая утечка.
       */
      failed.push(rail);
      continue;
    }

    try {
      await provider.stopRenewal({
        tgId: params.tgId,
        subscriptionRef: subscription.subscriptionRef,
      });

      await stopAutoRenew(db, { userId: params.userId, provider: rail, now });
      stopped.push(rail);
    } catch (error) {
      params.logger?.error(
        { err: error, rail, userId: params.userId },
        'Провайдер не отменил продление перед удалением данных: списания продолжатся',
      );
      failed.push(rail);
    }
  }

  return { stopped, failed };
}

/**
 * Отменить автопродление — §14 «в один тап».
 *
 * Доступ не трогается: §14 требует сохранить его до конца оплаченного
 * периода. Провайдеру говорит вызывающий — у него есть `subscriptionRef`
 * и клиент; здесь только наша память.
 */
export async function cancelRenewal(
  db: Executor,
  params: { readonly userId: string; readonly provider: Rail; readonly now?: Date | undefined },
): Promise<{ readonly stopped: boolean; readonly paidUntil: Date | undefined }> {
  const now = params.now ?? new Date();
  const before = await subscriptionOf(db, { userId: params.userId, provider: params.provider });

  const stopped = await stopAutoRenew(db, {
    userId: params.userId,
    provider: params.provider,
    now,
  });

  return { stopped, paidUntil: before?.currentPeriodEnd };
}
