import { and, count, desc, eq, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  aiCalls,
  batches,
  billingInvoices,
  billingSubscriptions,
  itemRevisions,
  items,
  messagesRaw,
  pendingQuestions,
  users,
} from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { activePayersCount } from '../billing/billing.repo.js';
import { funnelOf, type Funnel } from './funnel.js';
import { unpricedCountSql, unpricedSql } from '../metering/unpriced.js';
import type { Money } from '../metering/cost-breakdown.js';

/**
 * Люди в админ-панели: обзор, список, карточка (§15 ТЗ, задача 4.6).
 *
 * **Условие готовности задачи — не «экран есть», а «по жалобе „бот
 * неправильно понял“ можно за минуту найти выгрузку, версию промпта и
 * результат».** Отсюда и устройство карточки: она собрана вокруг одного
 * вопроса, а не вокруг таблиц базы. Что человек сказал → что из этого
 * вышло → каким промптом это сделано → что потом поправили.
 *
 * Этот путь в проекте уже проходили руками: жалоба проджекта 31.08.2026
 * разбиралась запросами в боевую базу через ssh, и заняло это не минуту.
 * Карточка существует, чтобы такого больше не было.
 *
 * **Выручка и переход в оплату появились с задачей 4.2.** До неё обзор
 * честно говорил, что их нет: пустая колонка в панели читается как ноль,
 * то есть как факт. Теперь считается настоящее — оплаченные счёта и доля
 * тех, кто после пробного периода заплатил.
 *
 * **Выручка не сводится в одно число, и это не лень.** Рубли и звёзды —
 * разные деньги: курс звезды задаёт Telegram, он меняется, и сложить их
 * в «итого» значило бы придумать курс. Кроме того из звёзд Telegram
 * берёт свою долю. Показываем раздельно.
 */

// ── Обзор ─────────────────────────────────────────────────────────────

export interface Overview {
  readonly days: number;
  /** Кто хоть что-то присылал за период. */
  readonly activeUsers: number;
  /** Сколько людей всего. */
  readonly totalUsers: number;
  /** Появившиеся за период. */
  readonly newUsers: number;
  /** Разобранные выгрузки за период. */
  readonly dumps: number;
  /** Расход на модели за период, по валютам. */
  readonly spend: readonly Money[];
  /**
   * Вызовов за период без известной цены (ревизия четвёртого этапа).
   *
   * Больше нуля означает, что расход выше — сумма ниже настоящей на
   * стоимость этих вызовов. Прежде они молча выпадали, и расход
   * показывался как факт: раздел расходов такую оговорку печатает, обзор
   * молчал, и два числа про одно и то же расходились.
   */
  readonly unpricedCalls: number;
  /**
   * Выручка за период — по рельсам, а не одним числом.
   *
   * Рубли в копейках, звёзды штуками. Складывать нельзя: курс звезды
   * задаёт Telegram, он меняется, и «итого» пришлось бы придумать.
   */
  readonly revenue: readonly Revenue[];
  /**
   * Возвращено за период — по рельсам, как и выручка.
   *
   * Отдельной величиной, а не вычетом из выручки: «заработали 399 и
   * вернули 399» и «не заработали ничего» — разные новости, а сумма у
   * них одна. Прежде возвращённый счёт оставался оплаченным, и выручка
   * молча считала вернувшиеся деньги.
   */
  readonly refunded: readonly Revenue[];
  /** Сколько людей платят прямо сейчас. */
  readonly payers: number;
  /**
   * Воронка и разрез по источникам (§15, задача 4.4).
   *
   * Целиком, а не «переход из пробного в оплату» отдельным числом:
   * третий и четвёртый шаги воронки и есть этот переход, и посчитай мы
   * его здесь своим запросом — одно число оказалось бы посчитано двумя
   * способами.
   *
   * По всем людям, а не за период обзора: воронка — когорта, и смешивать
   * её с окном «за 30 дней» нельзя, иначе числа не сойдутся друг с
   * другом.
   */
  readonly funnel: Funnel;
  /**
   * Чего в обзоре нет и почему — списком, а не молчанием.
   *
   * Пустая колонка читается как «ноль», то есть как факт. Здесь вместо
   * факта стоит объяснение. Список пуст — значит показано всё, что §15
   * просит.
   */
  readonly missing: readonly string[];
}

export interface Revenue {
  /** `RUB` в копейках, `XTR` в штуках звёзд. */
  readonly currency: string;
  readonly minor: number;
  /** Сколько платежей: одна крупная оплата и десять мелких — разное. */
  readonly payments: number;
}

export async function overview(
  db: Executor,
  days: number,
  /**
   * Нынешний предел пробного периода — для воронки (ревизия этапа 4).
   *
   * Без него воронка называет «пробный ещё идёт» тех, кому бот уже
   * отказывает. Значением, а не реестром: этот модуль — запросы, и
   * второй читатель настроек мимо реестра разошёлся бы с первым.
   *
   * Необязателен: без него колонка честно пуста, и это сказано в
   * оговорках воронки.
   */
  trialLimit?: number,
): Promise<Overview> {
  const since = new Date(Date.now() - days * 24 * 3_600_000);
  const now = new Date();

  const [people] = await db.select({ total: count() }).from(users);

  const [fresh] = await db
    .select({ total: count() })
    .from(users)
    .where(gte(users.createdAt, since));

  const [active] = await db
    .select({ total: sql<number>`count(distinct ${messagesRaw.userId})::int` })
    .from(messagesRaw)
    .where(gte(messagesRaw.receivedAt, since));

  const [parsed] = await db
    .select({ total: count() })
    .from(batches)
    .where(and(eq(batches.status, 'done'), gte(batches.openedAt, since)));

  /**
   * Порядок валют задан **нами**, а не Postgres (ревизия этапа 4).
   *
   * У `group by` без `order by` порядок групп решает план запроса, и он
   * разный у разных запросов: карточка спрашивает про одного человека,
   * список — про двадцать, планы выходят разные, и один и тот же расход
   * приезжал то `[рубли, доллары]`, то `[доллары, рубли]`.
   *
   * Цена была не в красной проверке, а в том, что она краснела **через
   * раз**: пара «карточка и список» расходилась случайно, а случайное
   * расхождение чинят месяцами. И заказчица видела валюты в разном
   * порядке при каждом обновлении страницы.
   *
   * Порядок — по **тексту** валюты, а не по самому столбцу: `currency`
   * это перечисление Postgres, объявленное как `('usd', 'rub')`, и
   * сортировка по столбцу идёт по порядку объявления. Значит «по
   * возрастанию» дало бы `[доллары, рубли]`, а дописанная в конец
   * перечисления валюта встала бы последней независимо от имени.
   * Текстовый порядок предсказуем читающему и совпадает с разделом
   * расходов, где валюты внутри строки сортируются по имени.
   */
  const spendRows = await db
    .select({
      currency: aiCalls.costCurrency,
      total: sql<string>`coalesce(sum(${aiCalls.costMicros}), 0)::bigint`,
    })
    .from(aiCalls)
    .where(gte(aiCalls.createdAt, since))
    .groupBy(aiCalls.costCurrency)
    .orderBy(sql`${aiCalls.costCurrency}::text`);

  /**
   * Вызовы без цены — числом (ревизия четвёртого этапа).
   *
   * Модели нет в прайс-листе — цена не записана, и вызов молча выпадает
   * из суммы. Расход в обзоре показывался как факт, хотя был нижней
   * границей. Раздел расходов такую оговорку печатает, обзор — нет, и
   * два числа про одно и то же расходятся молча.
   */
  const [unpriced] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(aiCalls)
    .where(and(gte(aiCalls.createdAt, since), unpricedSql()));

  /**
   * Выручка — по **оплаченным** счетам, а не по выставленным.
   *
   * Выставленных счетов всегда больше: человек нажимает кнопку и уходит
   * думать. Считать их выручкой значило бы показать заказчице деньги,
   * которых нет.
   */
  const revenueRows = await db
    .select({
      currency: billingInvoices.currency,
      minor: sql<string>`coalesce(sum(${billingInvoices.amountMinor}), 0)::bigint`,
      payments: count(),
    })
    .from(billingInvoices)
    .where(and(eq(billingInvoices.status, 'paid'), gte(billingInvoices.paidAt, since)))
    .groupBy(billingInvoices.currency)
    // Порядок валют задан нами, по тексту — причина у расхода выше.
    .orderBy(sql`${billingInvoices.currency}::text`);

  const refundedRows = await db
    .select({
      currency: billingInvoices.currency,
      minor: sql<string>`coalesce(sum(${billingInvoices.amountMinor}), 0)::bigint`,
      payments: count(),
    })
    .from(billingInvoices)
    .where(and(eq(billingInvoices.status, 'refunded'), gte(billingInvoices.refundedAt, since)))
    .groupBy(billingInvoices.currency)
    // Порядок валют задан нами, по тексту — причина у расхода выше.
    .orderBy(sql`${billingInvoices.currency}::text`);

  const payers = await activePayersCount(db, now);

  /**
   * Переход из пробного в оплату — воронкой, одним источником.
   *
   * Реестр настроек ей не нужен вовсе: предел, при котором пробный
   * период кончился, записан в самом моменте. Спроси мы настройку —
   * получили бы нынешний предел вместо тогдашнего, то есть ровно ту
   * неправду, ради которой момент и пишется.
   */
  const funnel = await funnelOf(db, trialLimit === undefined ? {} : { trialLimit });

  return {
    days,
    activeUsers: active?.total ?? 0,
    totalUsers: people?.total ?? 0,
    newUsers: fresh?.total ?? 0,
    dumps: parsed?.total ?? 0,
    spend: spendRows
      .filter((row): row is { currency: 'rub' | 'usd'; total: string } => row.currency !== null)
      .map((row) => ({ currency: row.currency, micros: Number(row.total) })),
    revenue: revenueRows.map((row) => ({
      currency: row.currency,
      minor: Number(row.minor),
      payments: row.payments,
    })),
    refunded: refundedRows.map((row) => ({
      currency: row.currency,
      minor: Number(row.minor),
      payments: row.payments,
    })),
    payers,
    /** Сколько вызовов за период без известной цены: сумма — нижняя граница. */
    unpricedCalls: unpriced?.total ?? 0,
    funnel,
    /**
     * Оговорки берутся у воронки: они про её же числа.
     *
     * Свой список здесь означал бы два места, где объясняют одно и то
     * же, и однажды они разошлись бы.
     */
    missing: funnel.missing,
  };
}

// ── Список людей ──────────────────────────────────────────────────────

export interface PersonRow {
  readonly id: string;
  readonly tgId: number;
  readonly title: string;
  readonly username: string | null;
  /** Откуда пришёл: параметр реферальной ссылки (§14). */
  readonly source: string | null;
  readonly registeredAt: Date;
  readonly lastActiveAt: Date | null;
  /** Сколько выгрузок разобрано всего. */
  readonly dumps: number;
  /** Сколько из них потратили пробный период (задача 4.3). */
  readonly trialSpent: number;
  /** Расход на модели, по валютам. */
  readonly spend: readonly Money[];
  readonly blocked: boolean;
  /**
   * Подписка человека — или её отсутствие (§15, задача 4.2).
   *
   * `undefined` означает «не платил ни разу», и это не то же самое, что
   * «подписка кончилась»: разбирающий жалобу должен различать человека,
   * который никогда не платил, и человека, у которого период истёк.
   */
  readonly subscription?: PersonSubscription | undefined;
}

export interface PersonSubscription {
  readonly rail: string;
  readonly plan: string;
  /** `active`, `past_due`, `canceled` — как в базе. */
  readonly status: string;
  readonly autoRenew: boolean;
  readonly paidUntil: Date;
  /** Оплачено ли прямо сейчас. Считается здесь, а не в панели. */
  readonly live: boolean;
}

export interface PeoplePage {
  readonly rows: readonly PersonRow[];
  readonly total: number;
}

/**
 * Список людей.
 *
 * **Страницами, а не целиком.** План требует проверить постраничность на
 * тысяче человек: список, тянущий всех, работает до первой сотни и
 * ложится на тысяче — причём ложится не у нас, а у заказчицы, в момент,
 * когда бот стал популярным.
 *
 * Поиск по имени и телеграмному имени: жалоба приходит от человека, и
 * искать его по коду в базе неудобно.
 *
 * **Порядок с довеском по коду, и это не украшение.** Сортировка только
 * по дате регистрации неустойчива: у людей, зарегистрированных в одну
 * секунду (а при переносе данных — тысячами в одну транзакцию), время
 * совпадает, и база вправе отдавать их в любом порядке. Тогда один и тот
 * же человек попадает на две страницы подряд, а другой не попадает ни на
 * одну. Поймано проверкой постраничности на тысяче: сорок строк на двух
 * страницах дали тридцать девять разных.
 */
/**
 * Что искать в базе по тому, что человек набрал в панели.
 *
 * Панель подписывает поле «Имя или @имя» — и это обещание надо
 * исполнять. Telegram отдаёт телеграмное имя **без собаки**
 * (`update.from.username`), и мы пишем его как есть. Значит запрос
 * «@аня» превращался в `ilike '%@аня%'` и не совпадал ни с чем никогда:
 * панель отвечала «Никого не нашлось» на подсказку, которую сама же и
 * дала, — про человека, который в базе есть.
 *
 * Второе: `%` и `_` в `ilike` — служебные знаки, а не буквы. Без
 * экранирования «100%» искало «сто чего угодно», а одиночное `_` —
 * любого человека вовсе. Панель не место, где вводят шаблоны: человек
 * набирает имя.
 *
 * `undefined` означает «искать нечего» — тогда список показывается
 * целиком. Пустая строка и строка из одних пробелов — тот же случай.
 */
function searchFor(query: string | undefined): string | undefined {
  const said = query?.trim();

  if (said === undefined || said === '') return undefined;

  // Собака — часть обозначения, а не имени: срезается только ведущая.
  const name = said.startsWith('@') ? said.slice(1) : said;

  if (name === '') return undefined;

  // Обратная косая — первой: иначе она сама себя и заэкранирует.
  const safe = name.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

  return `%${safe}%`;
}

export async function people(
  db: Executor,
  params: {
    readonly limit: number;
    readonly offset: number;
    readonly query?: string | undefined;
  },
): Promise<PeoplePage> {
  const search = searchFor(params.query);

  const where =
    search === undefined
      ? undefined
      : or(ilike(users.firstName, search), ilike(users.username, search));

  const [totals] = await (where === undefined
    ? db.select({ total: count() }).from(users)
    : db.select({ total: count() }).from(users).where(where));

  /** Довесок по коду делает порядок устойчивым — см. пояснение выше. */
  const order = [desc(users.createdAt), desc(users.id)];

  const rows = await (where === undefined
    ? db
        .select()
        .from(users)
        .orderBy(...order)
        .limit(params.limit)
        .offset(params.offset)
    : db
        .select()
        .from(users)
        .where(where)
        .orderBy(...order)
        .limit(params.limit)
        .offset(params.offset));

  return { rows: await withNumbers(db, rows), total: totals?.total ?? 0 };
}

/** Профиль из базы: только те поля, что нужны строке списка. */
type Profile = typeof users.$inferSelect;

/**
 * Дописать к профилям числа: выгрузки, пробный период, расход.
 *
 * **Одним запросом на всю страницу, а не по одному на человека.**
 * Двадцать строк по три запроса — шестьдесят обращений в базу на
 * открытие списка. Так пишутся панели, которые «почему-то медленные».
 *
 * Общий помощник у списка и у карточки: иначе одно и то же число
 * считалось бы двумя способами и однажды разошлось бы.
 */
async function withNumbers(db: Executor, profiles: readonly Profile[]): Promise<PersonRow[]> {
  if (profiles.length === 0) return [];

  const ids = profiles.map((row) => row.id);

  /**
   * **Разобранные и пробные считаются по разным множествам** — правка
   * ревизии четвёртого этапа.
   *
   * Прежде оба числа брались из одного запроса с условием
   * `status = 'done'`, и «Пробных» получалось **четвёртым** способом:
   * гейт доступа считает по отметке без всякого условия на статус,
   * карточка — по своему запросу, сегмент рассылки — по общему
   * выражению. Расхождение не гипотетическое: отметка ставится в конце
   * разбора, а конвейер может вернуть выгрузку в очередь **после** неё
   * при сбое отправки ответа — тогда отметка есть, а статус не `done`.
   * Панель показывала бы «потрачено 4», гейт блокировал бы на пятой.
   *
   * Теперь «Пробных» считается тем же выражением, что отдаёт
   * `trialSpentSql` для гейта, воронки и сегмента: одно определение на
   * всех, кто про это спрашивает.
   */
  const dumpCounts = await db
    .select({
      userId: batches.userId,
      total: sql<number>`count(*) filter (where ${batches.status} = 'done')::int`,
      trial: sql<number>`count(*) filter (where ${batches.trialCountedAt} is not null)::int`,
    })
    .from(batches)
    .where(inArray(batches.userId, ids))
    .groupBy(batches.userId);

  const spendRows = await db
    .select({
      userId: aiCalls.userId,
      currency: aiCalls.costCurrency,
      total: sql<string>`coalesce(sum(${aiCalls.costMicros}), 0)::bigint`,
      /**
       * Вызовы без цены — числом, а не молчанием (ревизия этапа 4).
       *
       * Модели нет в прайс-листе — цена не записана, и вызов молча
       * выпадал из суммы. Расход человека показывался как факт, хотя был
       * нижней границей. Раздел расходов такую оговорку печатает, список
       * людей и обзор — нет.
       */
      unknownPrices: unpricedCountSql(),
    })
    .from(aiCalls)
    .where(inArray(aiCalls.userId, ids))
    .groupBy(aiCalls.userId, aiCalls.costCurrency)
    /**
     * Порядок валют задан нами, а не планом запроса (ревизия этапа 4).
     *
     * Этот запрос зовут **оба** пути: карточка через `peopleById` с одним
     * человеком, список — с двадцатью. Один и тот же код, разные планы, и
     * расход приезжал в разном порядке — проверка «числа в карточке те же,
     * что в списке» краснела через раз.
     *
     * Порядок — по **тексту** валюты, а не по самому столбцу: `currency`
     * это перечисление Postgres, объявленное как `('usd', 'rub')`, и
     * сортировка по столбцу идёт по порядку объявления. Значит «по
     * возрастанию» дало бы `[доллары, рубли]`, а дописанная в конец
     * перечисления валюта встала бы последней независимо от имени.
     * Текстовый порядок предсказуем читающему и совпадает с разделом
     * расходов, где валюты внутри строки сортируются по имени.
     */
    .orderBy(aiCalls.userId, sql`${aiCalls.costCurrency}::text`);

  /**
   * Подписки — одним запросом на страницу, как и остальные числа.
   *
   * Берётся самая долгая: рельсов два, а доступ общий, и показывать
   * человеку с двумя рельсами тот, что кончится раньше, значило бы
   * пугать разбирающего жалобу без причины.
   */
  const subscriptionRows = await db
    .select()
    .from(billingSubscriptions)
    .where(inArray(billingSubscriptions.userId, ids))
    .orderBy(desc(billingSubscriptions.currentPeriodEnd));

  const now = Date.now();
  const subscriptionBy = new Map<string, PersonSubscription>();

  for (const row of subscriptionRows) {
    // Первая для человека и есть самая долгая: порядок задан запросом.
    if (subscriptionBy.has(row.userId)) continue;

    subscriptionBy.set(row.userId, {
      rail: row.provider,
      plan: row.plan,
      status: row.status,
      autoRenew: row.autoRenew,
      paidUntil: row.currentPeriodEnd,
      live: row.currentPeriodEnd.getTime() > now,
    });
  }

  const dumpsBy = new Map(dumpCounts.map((row) => [row.userId, row]));
  const spendBy = new Map<string, Money[]>();

  for (const row of spendRows) {
    if (row.userId === null || row.currency === null) continue;

    const list = spendBy.get(row.userId) ?? [];
    list.push({ currency: row.currency, micros: Number(row.total) });
    spendBy.set(row.userId, list);
  }

  return profiles.map((row) => ({
    id: row.id,
    tgId: row.tgId,
    // Имя, если есть; иначе код — но не пустая ячейка: пустая читается
    // как «нет данных», а человек-то есть.
    title: row.firstName ?? `без имени (${row.id.slice(0, 8)})`,
    username: row.username,
    source: row.referralSource,
    registeredAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    dumps: dumpsBy.get(row.id)?.total ?? 0,
    trialSpent: dumpsBy.get(row.id)?.trial ?? 0,
    spend: spendBy.get(row.id) ?? [],
    blocked: row.isBlocked,
    ...(subscriptionBy.has(row.id) ? { subscription: subscriptionBy.get(row.id) } : {}),
  }));
}

// ── Карточка ──────────────────────────────────────────────────────────

export interface CardDump {
  readonly id: string;
  readonly openedAt: Date;
  readonly status: string;
  /**
   * Что человек сказал: расшифровки и текст, как их склеил буфер.
   *
   * Пусто **только** если сообщений нет вовсе. Прежде здесь было пусто и
   * у выгрузок, сорвавшихся до склейки, и карточка печатала «(текста
   * нет)» как факт — у той самой выгрузки, из-за которой человек и
   * написал жалобу. Теперь склейки нет — поднимаются сами сообщения.
   */
  readonly said: string | null;
  /** Потратила ли пробный период. */
  readonly trialCounted: boolean;
  readonly error: string | null;
  /** Что из этого вышло: заголовки записей и черновиков. */
  readonly results: readonly {
    readonly id: string;
    readonly text: string;
    readonly type: string;
    readonly topic: string | null;
    readonly isDraft: boolean;
    readonly draftReason: string | null;
  }[];
  /**
   * Каким промптом это сделано — по этапам.
   *
   * Ровно то, ради чего задача существует: «бот неправильно понял» без
   * версии промпта не разобрать, потому что промпт с тех пор мог
   * поменяться (§15 разрешает менять его без выкладки).
   */
  readonly prompts: readonly { readonly stage: string; readonly version: string | null }[];
}

export interface CardChange {
  readonly id: string;
  readonly at: Date;
  readonly changedBy: string;
  readonly reason: string | null;
  readonly reverted: boolean;
  readonly itemText: string | null;
}

export interface CardQuestion {
  readonly id: string;
  readonly at: Date;
  /** Что человек сказал, из-за чего возник вопрос. */
  readonly segment: string;
  /** Чем кончился: ответил, ответил «отдельно», истёк, вытеснен. */
  readonly outcome: string | null;
  /** Когда вопрос закрылся. Пусто — ещё открыт. */
  readonly resolvedAt: Date | null;
}

export interface PersonCard {
  readonly person: PersonRow;
  /**
   * Сколько выгрузок у человека всего (ревизия четвёртого этапа).
   *
   * Список обрезан двадцатью, и прежде об этом не было сказано ничего:
   * разбирающий жалобу читал его как полный.
   */
  readonly dumpsTotal: number;
  /**
   * Сказанное вне выгрузок (ревизия четвёртого этапа).
   *
   * Сообщение после отказа гейта сохраняется и не попадает ни в
   * выгрузку, ни в записи: прежде его не видел никто — ни человек, ни
   * разбирающий жалобу «куда девались мои слова».
   */
  readonly orphans: readonly {
    readonly id: string;
    readonly kind: string;
    readonly text: string | null;
    readonly at: Date;
  }[];
  readonly orphansTotal: number;
  readonly dumps: readonly CardDump[];
  readonly changes: readonly CardChange[];
  readonly questions: readonly CardQuestion[];
}

/**
 * Карточка человека — вокруг вопроса «что он сказал и что из этого вышло».
 *
 * Порядок частей и есть ответ на жалобу: сказанное, разбор, версия
 * промпта, потом правки и вопросы. Ровно тем путём, которым 31.08.2026
 * пришлось идти через ssh и SQL.
 */
export async function personCard(
  db: Executor,
  params: { readonly userId: string; readonly dumpLimit?: number | undefined },
): Promise<PersonCard | undefined> {
  const page = await peopleById(db, params.userId);
  if (page === undefined) return undefined;

  const limit = Math.min(50, Math.max(1, params.dumpLimit ?? 20));

  const dumpRows = await db
    .select()
    .from(batches)
    .where(eq(batches.userId, params.userId))
    .orderBy(desc(batches.openedAt))
    .limit(limit);

  /**
   * Сказанное **вне выгрузок** — правка ревизии четвёртого этапа.
   *
   * Сообщение, пришедшее после отказа гейта, сохраняется (инвариант 1:
   * сохранить до всякого разбора) и не попадает ни в выгрузку, ни в
   * записи. Прежде его не видел никто: `/menu` показывает записи,
   * карточка — выгрузки. Человек, которому реплика обещала «всё
   * сказанное на месте», шёл проверять и не находил своих слов, а
   * разбирающий жалобу не мог даже подтвердить, что слова дошли.
   *
   * Показываются последние: их может накопиться много, а нужны свежие —
   * те, из-за которых человек и написал.
   */
  const orphanRows = await db
    .select({
      id: messagesRaw.id,
      kind: messagesRaw.kind,
      text: messagesRaw.text,
      at: messagesRaw.receivedAt,
    })
    .from(messagesRaw)
    .where(and(eq(messagesRaw.userId, params.userId), isNull(messagesRaw.batchId)))
    .orderBy(desc(messagesRaw.receivedAt))
    .limit(20);

  const [orphansAll] = await db
    .select({ total: count() })
    .from(messagesRaw)
    .where(and(eq(messagesRaw.userId, params.userId), isNull(messagesRaw.batchId)));

  /**
   * Сколько выгрузок у человека **всего** (ревизия четвёртого этапа).
   *
   * Карточка молча обрезана двадцатью, и разбирающий жалобу читал список
   * как полный: «сказала три раза за месяц» вместо «двадцать первый раз
   * не показан». Число выше списка снимает эту неправду; кнопки «ещё»
   * пока нет, и это названо словами в панели.
   */
  const [dumpsAll] = await db
    .select({ total: count() })
    .from(batches)
    .where(eq(batches.userId, params.userId));

  const dumpIds = dumpRows.map((row) => row.id);

  /**
   * Сказанное человеком — из сообщений, если склейки ещё нет.
   *
   * **Ревизия четвёртого этапа: карточка теряла слова именно там, где
   * они нужнее всего.** `combined_text` пишется в начале разбора; у
   * выгрузки, сорвавшейся до него (или ещё не начатой), поле пусто — и
   * карточка печатала «(текста нет)» **как факт**. Разбирающий жалобу
   * «бот меня не понял» видел пустоту у той самой выгрузки, из-за
   * которой человек и написал.
   *
   * Сообщения при этом на месте: инвариант проекта — сохранить до
   * всякого разбора. Поднимаем их тем же порядком, каким их клеит
   * `combineBatch`: по времени получения.
   */
  const rawRows =
    dumpIds.length === 0
      ? []
      : await db
          .select({
            batchId: messagesRaw.batchId,
            kind: messagesRaw.kind,
            text: messagesRaw.text,
            at: messagesRaw.receivedAt,
          })
          .from(messagesRaw)
          .where(inArray(messagesRaw.batchId, dumpIds))
          .orderBy(messagesRaw.receivedAt);

  const rawBy = new Map<string, { readonly text: string | null; readonly kind: string }[]>();

  for (const row of rawRows) {
    if (row.batchId === null) continue;

    const list = rawBy.get(row.batchId) ?? [];
    list.push({ text: row.text, kind: row.kind });
    rawBy.set(row.batchId, list);
  }

  /**
   * Что показать вместо склейки — и почему её нет.
   *
   * Голосовое без расшифровки текста не имеет вовсе: сказать «голосовое
   * не расшифровано» честнее, чем показать пустоту.
   */
  const saidOf = (batchId: string, combined: string | null): string => {
    if (combined !== null && combined !== '') return combined;

    const parts = rawBy.get(batchId) ?? [];

    if (parts.length === 0) return '';

    const texts = parts.map((one) => one.text).filter((one): one is string => one !== null);

    if (texts.length > 0) return texts.join('\n');

    return parts.every((one) => one.kind === 'voice')
      ? '(голосовое не расшифровано)'
      : '(сообщения есть, текста в них нет)';
  };

  const itemRows =
    dumpIds.length === 0
      ? []
      : await db
          .select()
          .from(items)
          .where(inArray(items.sourceBatchId, dumpIds))
          .orderBy(items.createdAt);

  /**
   * Версии промптов — из учёта обращений.
   *
   * Не из таблицы промптов: там лежит **сегодняшняя** активная версия, а
   * жалоба всегда про прошлое. Версия, которой разобрали эту выгрузку,
   * записана в строке учёта — там её и берём.
   */
  const promptRows =
    dumpIds.length === 0
      ? []
      : await db
          .selectDistinct({
            batchId: aiCalls.batchId,
            stage: aiCalls.stage,
            promptVersion: aiCalls.promptVersion,
          })
          .from(aiCalls)
          .where(inArray(aiCalls.batchId, dumpIds));

  const changeRows = await db
    .select({
      id: itemRevisions.id,
      at: itemRevisions.createdAt,
      changedBy: itemRevisions.changedBy,
      reason: itemRevisions.reason,
      revertedAt: itemRevisions.revertedAt,
      itemText: items.text,
    })
    .from(itemRevisions)
    .leftJoin(items, eq(items.id, itemRevisions.itemId))
    .where(eq(itemRevisions.userId, params.userId))
    .orderBy(desc(itemRevisions.createdAt))
    .limit(100);

  const questionRows = await db
    .select()
    .from(pendingQuestions)
    .where(eq(pendingQuestions.userId, params.userId))
    .orderBy(desc(pendingQuestions.createdAt))
    .limit(100);

  return {
    person: page,
    /** Сколько выгрузок всего: список обрезан, и это должно быть видно. */
    dumpsTotal: dumpsAll?.total ?? 0,
    /** Сказанное вне выгрузок: после отказа гейта его не видел никто. */
    orphans: orphanRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      text: row.text,
      at: row.at,
    })),
    orphansTotal: orphansAll?.total ?? 0,
    dumps: dumpRows.map((dump) => ({
      id: dump.id,
      openedAt: dump.openedAt,
      status: dump.status,
      said: saidOf(dump.id, dump.combinedText),
      trialCounted: dump.trialCountedAt !== null,
      error: dump.error,
      results: itemRows
        .filter((item) => item.sourceBatchId === dump.id)
        .map((item) => ({
          id: item.id,
          text: item.text,
          type: item.type ?? 'черновик',
          topic: item.topic,
          isDraft: item.isDraft,
          draftReason: item.draftReason,
        })),
      prompts: promptRows
        .filter((row) => row.batchId === dump.id)
        .map((row) => ({ stage: row.stage, version: row.promptVersion })),
    })),
    changes: changeRows.map((row) => ({
      id: row.id,
      at: row.at,
      changedBy: row.changedBy,
      reason: row.reason,
      reverted: row.revertedAt !== null,
      itemText: row.itemText,
    })),
    questions: questionRows.map((row) => ({
      id: row.id,
      at: row.createdAt,
      segment: row.segment,
      outcome: row.outcome,
      resolvedAt: row.resolvedAt,
    })),
  };
}

/** Одна строка списка — тем же кодом, чтобы карточка и список сошлись. */
async function peopleById(db: Executor, userId: string): Promise<PersonRow | undefined> {
  const [found] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!found) return undefined;

  const [row] = await withNumbers(db, [found]);

  return row;
}
