import { sql } from 'drizzle-orm';

import { batches, billingInvoices, users } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Воронка и разрез по источникам (§15, §14 и §19 ТЗ, задача 4.4).
 *
 * Условие готовности задачи названо прямо: «в админке виден срез по
 * источникам и воронка „регистрация, первая выгрузка, конец пробного,
 * оплата“». §14 требует того же про реферальный параметр, §19 — замер
 * возврата с первой недели.
 *
 * **Все четыре шага считаются по одному множеству людей.** Не каждый по
 * своей таблице: числитель и знаменатель из разных источников однажды
 * дают долю больше единицы, и объяснить её потом нельзя. Здесь один
 * `users` в окне когорты, а шаги — признаки на нём.
 *
 * **Когорта, а не период.** Смешивать нельзя: «зарегистрировались в
 * сентябре» и «заплатили в сентябре» — разные множества, и числа не
 * сойдутся друг с другом. Окно задаёт **регистрацию**, а шаги случаются
 * когда угодно после неё.
 *
 * **Ни одного определения не придумано здесь.** «Первая выгрузка» — это
 * `status = 'done'`, то же, чем обзор считает разобранные выгрузки, а
 * список людей — их число; третье определение было бы четвёртым способом
 * ответить на один вопрос. «Конец пробного» — записанный **момент**, а не
 * пересчёт по нынешнему пределу. «Оплата» — **состояние** счёта, а не
 * дата: у платящего звёздами продление живёт своей строкой, и считать по
 * датам значило бы отвечать на другой вопрос.
 *
 * **Ряд законно немонотонен, и лишнее вынесено рядом.** Заплатить можно,
 * не дойдя до границы пробного периода — платящему отметка о трате не
 * ставится вовсе. Такие идут отдельным названным числом, а не внутри
 * ряда: они не «перешли из пробного в оплату», они не дошли до вопроса.
 *
 * **Своей таблицы событий здесь нет, и это расхождение с планом.** План
 * говорил: «таблица `events` заводится здесь, потому что без неё нечем
 * закрыть §19 и воронку». Оба названных числа выводятся из рабочих
 * таблиц, а строка `events(kind='trial_over')` соответствовала бы один к
 * одному строке выгрузки, то есть стала бы второй правдой о ней. Что
 * таблица действительно добавила бы — переживание удаления данных; за
 * это заплачено согласованностью: шаги живут на каскадных строках и
 * уходят вместе с человеком одинаково, а не вразнобой.
 */

/** Один разрез воронки. */
export interface FunnelRow {
  /** Источник перехода или `null` — прямой заход без ссылки. */
  readonly source: string | null;
  readonly registered: number;
  /** Из них: есть разобранная выгрузка. */
  readonly firstDump: number;
  /** Из них: записан момент конца пробного периода. */
  readonly trialOver: number;
  /** Из дошедших до границы — заплатившие. */
  readonly paidAfterTrial: number;
  /** Заплатившие, не дойдя до границы. Рядом с рядом, а не внутри. */
  readonly paidWithoutTrialOver: number;
  /** У кого пробный период ещё идёт: он не «не купил», он не выбирал. */
  readonly trialStillRunning: number;
}

export interface Funnel {
  /** Всё вместе, без разреза. */
  readonly total: FunnelRow;
  /** По источникам, от большего к меньшему. */
  readonly bySource: readonly FunnelRow[];
  /**
   * Пределы пробного периода, встреченные в моментах.
   *
   * Список, а не число: предел правится из панели, и у людей разных
   * недель он разный. Одно число здесь было бы неправдой ровно после
   * первой правки.
   */
  readonly trialLimits: readonly number[];
  /**
   * С какого момента ведутся записи о конце пробного периода.
   *
   * Пусто — ни одного момента ещё нет. Печатается рядом с числами
   * обязательно: моменты задним числом не досыпаются, и ноль на третьем
   * шаге без этой даты читается как факт «никто не дошёл».
   */
  readonly momentsSince: Date | null;
  /** Оплаченные счёта людей, которых больше нет: данные удалены. */
  readonly paidWithoutPerson: number;
  /** Чего в воронке нет и почему — словами, а не пустыми колонками. */
  readonly missing: readonly string[];
}

/**
 * Признаки по каждому человеку — одним запросом.
 *
 * Сырым SQL, а не сборщиком: четыре условных счёта и два подзапроса
 * читаются на SQL прямо, а на сборщике превращаются в головоломку. Имена
 * таблиц и колонок берутся из схемы, поэтому переименование колонки
 * роняет сборку, а не запрос в бою.
 */
async function rowsOf(
  db: Executor,
  params: { readonly since?: Date | undefined; readonly until?: Date | undefined },
): Promise<readonly FunnelRow[]> {
  const since = params.since;
  const until = params.until;

  const result = await db.execute<{
    source: string | null;
    registered: number;
    first_dump: number;
    trial_over: number;
    paid_after_trial: number;
    paid_without_trial_over: number;
    trial_still_running: number;
  }>(sql`
    with own as (
      select
        ${users.referralSource} as source,
        coalesce(d.done, 0) as done,
        coalesce(d.trial, 0) as trial,
        d.over_at as over_at,
        coalesce(p.paid, 0) as paid
      from ${users}
      left join (
        select
          ${batches.userId} as user_id,
          count(*) filter (where ${batches.status} = 'done') as done,
          count(*) filter (where ${batches.trialCountedAt} is not null) as trial,
          max(${batches.trialOverAt}) as over_at
        from ${batches}
        group by ${batches.userId}
      ) d on d.user_id = ${users.id}
      left join (
        select ${billingInvoices.userId} as user_id, count(*) as paid
        from ${billingInvoices}
        where ${billingInvoices.status} = 'paid'
        group by ${billingInvoices.userId}
      ) p on p.user_id = ${users.id}
      where ${since === undefined ? sql`true` : sql`${users.createdAt} >= ${since}`}
        and ${until === undefined ? sql`true` : sql`${users.createdAt} < ${until}`}
    )
    select
      source,
      count(*)::int as registered,
      count(*) filter (where done > 0)::int as first_dump,
      count(*) filter (where over_at is not null)::int as trial_over,
      count(*) filter (where over_at is not null and paid > 0)::int as paid_after_trial,
      count(*) filter (where over_at is null and paid > 0)::int as paid_without_trial_over,
      count(*) filter (where over_at is null and trial > 0 and paid = 0)::int
        as trial_still_running
    from own
    group by source
  `);

  return result.rows.map((row) => ({
    /**
     * Пустая строка и `null` — одно и то же: прямой заход.
     *
     * Параметр ссылки может прийти пустым, и две строки «без источника»
     * в отчёте выглядели бы как два разных источника.
     */
    source: row.source === null || row.source === '' ? null : row.source,
    registered: row.registered,
    firstDump: row.first_dump,
    trialOver: row.trial_over,
    paidAfterTrial: row.paid_after_trial,
    paidWithoutTrialOver: row.paid_without_trial_over,
    trialStillRunning: row.trial_still_running,
  }));
}

function sumRows(rows: readonly FunnelRow[]): FunnelRow {
  return rows.reduce<FunnelRow>(
    (all, row) => ({
      source: null,
      registered: all.registered + row.registered,
      firstDump: all.firstDump + row.firstDump,
      trialOver: all.trialOver + row.trialOver,
      paidAfterTrial: all.paidAfterTrial + row.paidAfterTrial,
      paidWithoutTrialOver: all.paidWithoutTrialOver + row.paidWithoutTrialOver,
      trialStillRunning: all.trialStillRunning + row.trialStillRunning,
    }),
    {
      source: null,
      registered: 0,
      firstDump: 0,
      trialOver: 0,
      paidAfterTrial: 0,
      paidWithoutTrialOver: 0,
      trialStillRunning: 0,
    },
  );
}

/**
 * Свести разрезы с одинаковым источником.
 *
 * После приведения пустого источника к `null` строк «без источника»
 * может оказаться две — та, где было `null`, и та, где была пустая
 * строка. В отчёте это выглядело бы как два источника.
 */
function mergeSame(rows: readonly FunnelRow[]): FunnelRow[] {
  const by = new Map<string, FunnelRow>();

  for (const row of rows) {
    const key = row.source ?? '';
    const before = by.get(key);

    by.set(key, before === undefined ? row : { ...sumRows([before, row]), source: row.source });
  }

  return [...by.values()].sort((first, second) => second.registered - first.registered);
}

export async function funnelOf(
  db: Executor,
  params: { readonly since?: Date | undefined; readonly until?: Date | undefined } = {},
): Promise<Funnel> {
  const bySource = mergeSame(await rowsOf(db, params));
  const total = sumRows(bySource);

  /**
   * Пределы и дата начала ведения — из самих моментов.
   *
   * Не из настроек: настройка говорит, каков предел **сейчас**, а
   * воронка показывает, каким он был тогда. Спроси мы настройку — и
   * получили бы ровно ту неправду, ради которой момент и пишется.
   */
  const moments = await db.execute<{ limits: number[] | null; since: Date | null }>(sql`
    select
      array_agg(distinct ${batches.trialLimit}) as limits,
      min(${batches.trialOverAt}) as since
    from ${batches}
    where ${batches.trialOverAt} is not null
  `);

  /**
   * Оплаченные счёта без человека — отдельной строкой.
   *
   * Люди уходят каскадом, а счета обезличиваются: §16 требует удалить
   * данные человека, но выручка — наша история. Без этой строки сумма по
   * источникам была бы меньше общей выручки, то есть отчёт не сходился
   * бы сам с собой, и объяснить это было бы нечем.
   */
  const orphans = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from ${billingInvoices}
    where ${billingInvoices.status} = 'paid' and ${billingInvoices.userId} is null
  `);

  const momentsSince = moments.rows[0]?.since ?? null;
  const trialLimits = [...(moments.rows[0]?.limits ?? [])].sort((first, second) => first - second);
  const paidWithoutPerson = orphans.rows[0]?.total ?? 0;

  const missing: string[] = [];

  if (momentsSince === null) {
    missing.push(
      'Моментов конца пробного периода пока нет ни одного: они пишутся с выкладки задачи 4.4 ' +
        'и задним числом не досыпаются. Ноль на третьем шаге означает «записей нет», а не «никто не дошёл».',
    );
  }

  if (trialLimits.length > 1) {
    missing.push(
      `Размер пробного периода за это время менялся: встречены пределы ${trialLimits.join(', ')}. ` +
        'Третий шаг считается по пределу, действовавшему в тот момент, а не по нынешнему.',
    );
  }

  if (total.trialStillRunning > 0) {
    missing.push(
      `У ${String(total.trialStillRunning)} человек пробный период ещё идёт. ` +
        'В третий шаг они не попадают: они не «не купили», они не дошли до вопроса.',
    );
  }

  if (total.paidWithoutTrialOver > 0) {
    missing.push(
      `${String(total.paidWithoutTrialOver)} человек заплатили, не дойдя до границы пробного периода. ` +
        'Они стоят отдельным числом: перехода из пробного в оплату у них не было.',
    );
  }

  if (paidWithoutPerson > 0) {
    missing.push(
      `${String(paidWithoutPerson)} оплаченных счетов без человека: данные удалены (§16). ` +
        'В разрезе по источникам их нет, а в общей выручке есть.',
    );
  }

  return { total, bySource, trialLimits, momentsSince, paidWithoutPerson, missing };
}
