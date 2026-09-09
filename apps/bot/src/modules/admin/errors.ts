import { and, count, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';

import {
  aiCalls,
  batches,
  billingInvoices,
  broadcastDeliveries,
  broadcasts,
  reminders,
  users,
} from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Журнал сбоев в панели (§15 ТЗ, задача 4.10).
 *
 * §15 просит «журнал неуспешных вызовов и сбоев с возможностью
 * повторного запуска». Пять источников, и они разные по смыслу:
 *
 *  - **сорвавшиеся выгрузки** — единственное, что видит человек: он
 *    сказал мысль и не получил разбора. Это и есть главное здесь;
 *  - **неуспешные вызовы модели** — причина, по которой выгрузка
 *    сорвалась, и заодно счёт: 403 не тарифится, а таймаут после
 *    отправки — да (задача 3.82);
 *  - **неудачные отправки рассылки** — их повтор живёт в самой рассылке;
 *  - **не ушедшие напоминания** — человек ждал утреннего списка и не
 *    получил его, а сам об этом не узнает никогда;
 *  - **неудачные платежи** (задача 4.2) — самый дорогой источник:
 *    человек мог заплатить и не получить доступ. Сюда попадают
 *    недоплаты (сумма не сошлась со счётом) и несостоявшиеся продления.
 *
 * **Неоткрывшейся страницы оплаты здесь нет, и быть не может.** Прежде
 * этот абзац её обещал — ревизия панели поймала обещание на слове.
 * Робокассе мы страницу не запрашиваем, а только собираем ссылку
 * (`providers/robokassa.ts`, `createCheckout` не делает ни одного
 * запроса), и код ошибки — например 34, «услуга не подключена
 * магазину» — приезжает внутри HTML уже **в браузере человека**, после
 * нажатия кнопки. Со стороны бота это событие невидимо: счёт остаётся
 * выставленным, и отличить «не заплатил» от «не смог» нечем. Узнаётся
 * такое из жалобы и из перечня кодов у провайдера, а не отсюда.
 *
 * **Перезапуск есть только у выгрузок, и это не недоделка.** Повторить
 * вызов модели в отрыве от выгрузки нельзя: он часть конвейера, и его
 * место — внутри разбора, а не рядом. Повторяется то, что имеет смысл
 * повторить целиком.
 *
 * **Текстов расшифровок здесь нет.** Видно, что выгрузка сорвалась, кто
 * её хозяин и на чём именно; сказанное человеком — в карточке (задача
 * 4.6), где доступ к нему пишется в журнал §16. Журнал ошибок читают
 * часто и мимоходом, и содержимому чужих мыслей в нём делать нечего.
 */

export interface FailedBatch {
  readonly id: string;
  readonly userId: string | null;
  readonly who: string;
  readonly tgId: number | null;
  readonly status: string;
  readonly attempts: number;
  readonly error: string | null;
  readonly openedAt: string;
  /** Сколько знаков сказал человек. Сам текст — в карточке. */
  readonly length: number;
}

export interface FailedCall {
  readonly id: string;
  readonly stage: string;
  readonly model: string;
  readonly promptVersion: string | null;
  readonly error: string | null;
  readonly latencyMs: number;
  readonly at: string;
  /**
   * У кого сорвался вызов (ревизия панели).
   *
   * Жалоба приходит от конкретного человека и в конкретное время, а
   * строка вызова не называла ни того, ни другого: связать «classifier
   * упал в 9:15» с человеком было нечем, хотя `user_id` у вызова лежит
   * и уже читается в разрезах расходов. У соседней таблицы сорвавшихся
   * разборов «У кого» есть с самого начала.
   *
   * Имя, а не идентификатор выгрузки: `batch_id` прежде довозился сюда
   * двумя слоями типов и не рисовался нигде — показывать в панели голый
   * UUID некуда, потому что ни в одной таблице его нет, а выгрузка
   * сорвавшегося вызова часто и не сорвана (её переподхватили). Имя
   * ведёт к карточке человека, где выгрузки видны.
   */
  readonly who: string;
  /** Заплатили ли за этот неудачный вызов. */
  readonly paid: boolean;
}

/**
 * Неудачный платёж (§14, задача 4.2).
 *
 * **Отдельный источник, потому что цена промаха здесь другая.** Не
 * увидеть сорвавшуюся выгрузку значит не ответить человеку; не увидеть
 * недоплату значит взять деньги и не выдать услугу. Второе разбирается
 * руками и разбирается срочно.
 *
 * Суммы обе: та, что в счёте, и та, что пришла. Разница между ними и
 * есть весь разбор.
 */
export interface FailedPayment {
  readonly id: string;
  readonly rail: string;
  readonly userId: string | null;
  readonly who: string;
  readonly tgId: number | null;
  readonly plan: string;
  readonly kind: string;
  /** Сколько ждали, в наименьших единицах. */
  readonly expectedMinor: number;
  readonly currency: string;
  /** Что пришло строкой, как её присылает провайдер. Пусто — не платили. */
  readonly received: string | null;
  readonly errorCode: number | null;
  readonly errorText: string | null;
  readonly at: string;
}

/**
 * Не дошедшее письмо рассылки.
 *
 * **Подпись под таблицей велела идти к «нужной рассылке», а сказать,
 * какая это, было нечем** (ревизия панели). `broadcastId` приезжал сюда
 * и не рисовался нигде: раздел «Рассылка» идентификаторов не печатает,
 * так что сопоставлять приходилось по времени — при том что журнал
 * смотрит до 366 дней, а список рассылок обрезан двадцатью. Поэтому
 * рядом с письмом едут время рассылки и начало её текста: по ним строку
 * из журнала видно в разделе рассылки глазами.
 *
 * Имя получателя — по той же причине: сырой телеграмный номер в панели
 * не ищется (поиск в «Пользователях» идёт по имени и @имени).
 */
export interface FailedSend {
  readonly id: string;
  readonly broadcastId: string;
  readonly tgId: number;
  readonly who: string;
  readonly broadcastAt: string;
  /** Начало текста рассылки — столько, чтобы отличить одну от другой. */
  readonly broadcastText: string;
  readonly error: string | null;
  readonly at: string | null;
}

/**
 * Сколько знаков текста рассылки едет в панель.
 *
 * Не весь текст: рассылка бывает до 4096 знаков, а строк в списке до
 * пятидесяти — это двести килобайт в браузер ради одной колонки.
 * Обрезка здесь, а не в вёрстке: чего не показываем, того и не
 * отправляем (ревизия четвёртого этапа нашла обратное у телеграмных
 * номеров — они уезжали в браузер и не рисовались нигде).
 */
const BROADCAST_HINT = 80;

/**
 * Сорвавшееся напоминание (§18, ревизия четвёртого этапа).
 *
 * Пятый источник сбоев, которого в журнале не было вовсе, и о его
 * отсутствии не было сказано словами. Напоминание, исчерпавшее попытки,
 * помечается `skipped_reason = 'failed'`, и эту колонку читал только сам
 * планировщик: человек не получил утреннего письма, а в панели — тишина.
 */
export interface FailedReminder {
  readonly id: string;
  readonly userId: string;
  readonly firstName: string | null;
  readonly tgId: number | null;
  /**
   * Какое именно — код `reminder_kind` из базы, пять значений: morning,
   * evening, deadline_eve, deadline_day, project.
   *
   * Человеческие слова к ним подбирает панель: перечисление здесь
   * обещало «утреннее, вечернее, по делу», то есть три значения из пяти
   * и одно несуществующее — по такому обещанию в панели и печатался код.
   */
  readonly kind: string;
  readonly at: string | null;
}

export interface ErrorsView {
  readonly days: number;
  readonly batches: readonly FailedBatch[];
  readonly calls: readonly FailedCall[];
  readonly sends: readonly FailedSend[];
  readonly payments: readonly FailedPayment[];
  readonly reminders: readonly FailedReminder[];
  /** Всего сорвавшихся выгрузок за период — список ограничен. */
  readonly batchesTotal: number;
  readonly callsTotal: number;
  readonly paymentsTotal: number;
  /**
   * Всего не дошедших писем рассылки за период.
   *
   * Ревизия этапа: список был обрезан пятьюдесятью **без итога** и не
   * подчинялся выбранному периоду — пятьдесят строк читались как полный
   * список, а строка месячной давности была видна при выборе «сутки».
   */
  readonly sendsTotal: number;
  readonly remindersTotal: number;
  /** Чего в журнале нарочно нет — словами, а не пустыми колонками. */
  readonly missing: readonly string[];
}

/**
 * Сколько строк отдаём в списке. Больше человек всё равно не прочтёт.
 *
 * Рядом с каждым списком идёт итог за период (`*Total`), и он здесь не
 * для красоты: пятьдесят строк без итога читаются как полный список.
 * В сбое, породившем сотни срывов, разбирающий решил бы, что перезапустил
 * всех, а перезапустил последних пятьдесят — поэтому панель обязана
 * сказать словами, сколько строк не показано.
 */
const LIMIT = 50;

function since(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60_000);
}

export async function errorsView(db: Executor, days: number): Promise<ErrorsView> {
  const from = since(days);

  const failedBatches = await db
    .select({
      id: batches.id,
      userId: batches.userId,
      firstName: users.firstName,
      username: users.username,
      tgId: users.tgId,
      status: batches.status,
      attempts: batches.attempts,
      error: batches.error,
      openedAt: batches.openedAt,
      length: sql<number>`coalesce(length(${batches.combinedText}), 0)`,
    })
    .from(batches)
    .leftJoin(users, eq(users.id, batches.userId))
    .where(and(eq(batches.status, 'failed'), gte(batches.openedAt, from)))
    .orderBy(desc(batches.openedAt))
    .limit(LIMIT);

  const [batchesCount] = await db
    .select({ total: count() })
    .from(batches)
    .where(and(eq(batches.status, 'failed'), gte(batches.openedAt, from)));

  const failedCalls = await db
    .select({
      id: aiCalls.id,
      stage: aiCalls.stage,
      model: aiCalls.model,
      promptVersion: aiCalls.promptVersion,
      error: aiCalls.error,
      latencyMs: aiCalls.latencyMs,
      at: aiCalls.createdAt,
      firstName: users.firstName,
      username: users.username,
      tgId: users.tgId,
      costMicros: aiCalls.costMicros,
    })
    .from(aiCalls)
    /**
     * Имя берётся связью, как у выгрузок: `user_id` у вызова пусто у
     * ушедшего человека (`on delete set null`), и тогда `nameOf` скажет
     * «данные удалены» вместо пустой клетки.
     */
    .leftJoin(users, eq(users.id, aiCalls.userId))
    .where(and(eq(aiCalls.ok, false), gte(aiCalls.createdAt, from)))
    .orderBy(desc(aiCalls.createdAt))
    .limit(LIMIT);

  const [callsCount] = await db
    .select({ total: count() })
    .from(aiCalls)
    .where(and(eq(aiCalls.ok, false), gte(aiCalls.createdAt, from)));

  const failedSends = await db
    .select({
      id: broadcastDeliveries.id,
      broadcastId: broadcastDeliveries.broadcastId,
      tgId: broadcastDeliveries.tgId,
      error: broadcastDeliveries.error,
      at: broadcastDeliveries.at,
      firstName: users.firstName,
      username: users.username,
      broadcastAt: broadcasts.createdAt,
      broadcastText: broadcasts.text,
    })
    .from(broadcastDeliveries)
    /**
     * Рассылка и человек — связью (ревизия панели).
     *
     * Без них строка не отвечала ни на «какая это рассылка», ни на «кто
     * этот номер», а подпись под таблицей велела идти к «нужной
     * рассылке». Связь по человеку внешняя, потому что имя может быть
     * снято при удалении данных, — тогда `nameOf` возьмёт номер из
     * самой строки доставки, а не оставит пустую клетку.
     */
    .innerJoin(broadcasts, eq(broadcasts.id, broadcastDeliveries.broadcastId))
    .leftJoin(users, eq(users.id, broadcastDeliveries.userId))
    /**
     * Период — как у трёх соседних источников (ревизия этапа 4).
     *
     * Прежде границы не было вовсе: при выборе «сутки» в списке стояли
     * письма месячной давности, а пятьдесят строк без итога читались как
     * полный список. Три соседних источника фильтруются по периоду и
     * печатают своё число — этот один молчал.
     */
    .where(
      and(
        eq(broadcastDeliveries.status, 'failed'),
        isNotNull(broadcastDeliveries.at),
        gte(broadcastDeliveries.at, from),
      ),
    )
    .orderBy(desc(broadcastDeliveries.at))
    .limit(LIMIT);

  const [sendsCount] = await db
    .select({ total: count() })
    .from(broadcastDeliveries)
    .where(
      and(
        eq(broadcastDeliveries.status, 'failed'),
        isNotNull(broadcastDeliveries.at),
        gte(broadcastDeliveries.at, from),
      ),
    );

  /**
   * Сорвавшиеся напоминания — пятый источник (§18, ревизия этапа 4).
   *
   * Прежде их не было в журнале вовсе, и о их отсутствии не было сказано
   * словами. Напоминание, исчерпавшее попытки, помечается
   * `skipped_reason = 'failed'` — колонку читал только планировщик.
   * Человек не получал утреннего письма, а панель молчала.
   */
  const failedReminders = await db
    .select({
      id: reminders.id,
      userId: reminders.userId,
      firstName: users.firstName,
      tgId: users.tgId,
      kind: reminders.kind,
      at: reminders.dueAt,
    })
    .from(reminders)
    .leftJoin(users, eq(users.id, reminders.userId))
    .where(and(eq(reminders.skippedReason, 'failed'), gte(reminders.dueAt, from)))
    .orderBy(desc(reminders.dueAt))
    .limit(LIMIT);

  const [remindersCount] = await db
    .select({ total: count() })
    .from(reminders)
    .where(and(eq(reminders.skippedReason, 'failed'), gte(reminders.dueAt, from)));

  /**
   * Время отказа, а не дата счёта (ревизия панели).
   *
   * Недоплата приходит уведомлением провайдера тогда, когда человек
   * соберётся заплатить, а счёт заведён в момент нажатия кнопки и живёт
   * до `expires_at`. Поэтому счёт трёхдневной давности, недоплаченный
   * сегодня, при выборе «сутки» в журнал не попадал вовсе, а в колонке
   * «Когда» стояла дата счёта — не время разбираемого события.
   *
   * `coalesce` — из-за счетов, помеченных неудачными до появления
   * колонки: времени отказа у них нет, и фильтр по одному `failed_at`
   * выкинул бы их из журнала совсем. У таких берётся дата счёта, то есть
   * прежнее поведение. Выражение одно на всё — фильтр, порядок, число за
   * период и колонка, — чтобы «Когда» не разошлось с отбором.
   */
  const refusedAt = sql`coalesce(${billingInvoices.failedAt}, ${billingInvoices.createdAt})`
    /**
     * Разбор значения — тот же, что у столбца со временем.
     *
     * Драйвер отдаёт время строкой, а в дату её превращает разбор
     * столбца; у своего выражения столбца нет, и без `mapWith` в ответ
     * ушла бы сырая строка Postgres вместо даты — то есть журнал
     * платежей падал бы на каждой строке.
     */
    .mapWith(billingInvoices.createdAt);

  /**
   * Неудачные платежи за период (задача 4.2).
   *
   * Человек берётся связью со счётом, а не по имени в счёте: имени там
   * нет и быть не должно. Обезличенный счёт (человек удалил данные)
   * остаётся видимым — деньги были, и в учёте они наши.
   */
  const failedPayments = await db
    .select({
      id: billingInvoices.id,
      rail: billingInvoices.provider,
      userId: billingInvoices.userId,
      firstName: users.firstName,
      username: users.username,
      tgId: users.tgId,
      plan: billingInvoices.plan,
      kind: billingInvoices.kind,
      expectedMinor: billingInvoices.amountMinor,
      currency: billingInvoices.currency,
      received: billingInvoices.outSumReceived,
      errorCode: billingInvoices.errorCode,
      errorText: billingInvoices.errorText,
      at: refusedAt,
    })
    .from(billingInvoices)
    .leftJoin(users, eq(users.id, billingInvoices.userId))
    .where(and(eq(billingInvoices.status, 'failed'), gte(refusedAt, from)))
    .orderBy(desc(refusedAt))
    .limit(LIMIT);

  const [paymentsCount] = await db
    .select({ total: count() })
    .from(billingInvoices)
    .where(and(eq(billingInvoices.status, 'failed'), gte(refusedAt, from)));

  return {
    days,
    batches: failedBatches.map((row) => ({
      id: row.id,
      userId: row.userId,
      who: nameOf(row),
      tgId: row.tgId,
      status: row.status,
      attempts: row.attempts,
      error: row.error,
      openedAt: row.openedAt.toISOString(),
      length: row.length,
    })),
    calls: failedCalls.map((row) => ({
      id: row.id,
      stage: row.stage,
      model: row.model,
      promptVersion: row.promptVersion,
      error: row.error,
      latencyMs: row.latencyMs,
      at: row.at.toISOString(),
      who: nameOf(row),
      // За неудачный вызов иногда всё равно платят: отправка состоялась,
      // а ответа мы не дождались (задача 3.82).
      paid: (row.costMicros ?? 0) > 0,
    })),
    sends: failedSends.map((row) => ({
      id: row.id,
      broadcastId: row.broadcastId,
      tgId: row.tgId,
      // Номер берётся из самой строки доставки: он там копией, и у
      // человека с удалёнными данными это единственное, чем его назвать.
      who: nameOf({ firstName: row.firstName, username: row.username, tgId: row.tgId }),
      broadcastAt: row.broadcastAt.toISOString(),
      broadcastText: row.broadcastText.slice(0, BROADCAST_HINT),
      error: row.error,
      at: row.at?.toISOString() ?? null,
    })),
    payments: failedPayments.map((row) => ({
      id: row.id,
      rail: row.rail,
      userId: row.userId,
      who: nameOf(row),
      tgId: row.tgId,
      plan: row.plan,
      kind: row.kind,
      expectedMinor: row.expectedMinor,
      currency: row.currency,
      received: row.received,
      errorCode: row.errorCode,
      errorText: row.errorText,
      at: row.at.toISOString(),
    })),
    reminders: failedReminders.map((row) => ({
      id: row.id,
      userId: row.userId,
      firstName: row.firstName,
      tgId: row.tgId,
      kind: row.kind,
      at: row.at.toISOString(),
    })),
    batchesTotal: batchesCount?.total ?? 0,
    callsTotal: callsCount?.total ?? 0,
    paymentsTotal: paymentsCount?.total ?? 0,
    sendsTotal: sendsCount?.total ?? 0,
    remindersTotal: remindersCount?.total ?? 0,
    missing: [
      'Текстов расшифровок здесь нет нарочно: сказанное человеком — в его карточке, где доступ к нему журналируется (§16).',
      'Повторный запуск есть у выгрузок и у рассылки. Отдельный вызов модели повторить нельзя: он часть разбора, а не сам по себе.',
      'У неудачных платежей повтора нет и не будет: повторить списание — значит взять деньги второй раз. Недоплата и возврат разбираются руками, через обращение человека.',
      'У сорвавшихся напоминаний повтора нет: время прошло, и вечернее письмо, присланное на следующий день, — не то напоминание, о котором просили. Планировщик поставит следующее в свой срок.',
    ],
  };
}

function nameOf(row: {
  readonly firstName: string | null;
  readonly username: string | null;
  readonly tgId: number | null;
}): string {
  if (row.firstName !== null && row.firstName !== '') return row.firstName;
  if (row.username !== null && row.username !== '') return `@${row.username}`;

  return row.tgId === null ? 'данные удалены' : `id ${String(row.tgId)}`;
}

export type RestartOutcome =
  | { readonly ok: true; readonly userId: string }
  /** Нечего перезапускать: выгрузки нет или она не сорвана. */
  | { readonly ok: false; readonly why: string };

/**
 * Вернуть сорвавшуюся выгрузку в очередь — «повторный запуск» из §15.
 *
 * **Ровно то, чего не хватало до этой задачи.** Сбойные выгрузки
 * намеренно не переподхватываются: бесконечный повтор на нашей же ошибке
 * сжигает чужие деньги и прячет причину. Но это значило, что человек,
 * чей разбор сорвался, не получал его никогда — и об этом прямо сказано в
 * коде конвейера и в тексте извинения (§17). Обещанная там «админка, из
 * которой их перезапускают», — здесь.
 *
 * Счётчик попыток сбрасывается: разбирался сбой руками, значит причину
 * либо устранили, либо решили попробовать ещё раз осознанно. Оставить
 * счётчик на пределе означало бы, что кнопка ничего не делает.
 *
 * Постановку в очередь эта функция не делает: очередь — дело вызывающего.
 * Иначе модуль панели знал бы про Redis, а знать ему незачем.
 */
export async function restartBatch(db: Executor, batchId: string): Promise<RestartOutcome> {
  const [row] = await db
    .select({ userId: batches.userId, status: batches.status })
    .from(batches)
    .where(eq(batches.id, batchId))
    .limit(1);

  if (row === undefined) return { ok: false, why: 'такой выгрузки нет' };

  if (row.status !== 'failed') {
    // Перезапускать идущую выгрузку — способ получить два разбора одной
    // мысли и два счёта за неё.
    return { ok: false, why: `выгрузка в состоянии «${row.status}», а не «failed»` };
  }

  const back = await db
    .update(batches)
    .set({ status: 'queued', attempts: 0, error: null })
    .where(and(eq(batches.id, batchId), eq(batches.status, 'failed')))
    .returning({ userId: batches.userId });

  const restarted = back[0];

  // Условие в `where` могло не сойтись: кто-то перезапустил раньше нас.
  if (restarted === undefined) return { ok: false, why: 'выгрузку уже перезапустили' };

  return { ok: true, userId: restarted.userId };
}
