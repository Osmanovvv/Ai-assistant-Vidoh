import pg from 'pg';

import { rublesOf } from '../modules/metering/account-spend.js';

/**
 * Сколько потратил счёт — по всем базам сразу (задача 3.79).
 *
 * **Главный урок 05.09.2026.** Ключ Yandex у нас **один**, а базы учёта
 * **четыре**: боевая, разработки, набора, сквозного. Каждый процесс
 * пишет расход в ту, к которой подключён, и любой отчёт по одной базе
 * врёт. Насколько: боевая база показывала 856 ₽, а счёт к тому моменту
 * был потрачен на ≈5 900 ₽ — то есть боевая знала 15% правды.
 *
 * Из-за этого расход выглядел вдесятеро меньше, чем был, и грант кончился
 * без предупреждения: 04.09 за сутки ушло 1 977 ₽ при плане 125 ₽.
 *
 * Здесь считается всё вместе: по каждой базе, по дням, по стадиям, с
 * накопленным итогом. Только чтение — ни одной правки.
 *
 * Запуск:
 *   npx tsx src/scripts/spend.ts
 *   npx tsx src/scripts/spend.ts postgres://…/vydoh vydoh_e2e vydoh_eval
 *
 * Без аргументов берёт `DATABASE_URL` и ищет рядом с ней все базы,
 * у которых есть таблица учёта.
 */

const DEFAULT_URL = process.env['DATABASE_URL'] ?? 'postgres://vydoh:vydoh@localhost:5434/vydoh';

const [, , ...args] = process.argv;
const base = new URL(args.find((one) => one.includes('://')) ?? DEFAULT_URL);
const named = args.filter((one) => !one.includes('://'));

function urlFor(database: string): string {
  const url = new URL(base.toString());
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Базы, чей расход идёт с нашего ключа Yandex.
 *
 * **Не «все, где есть таблица учёта»** — так в итог попадали тестовые и
 * черновые базы, а это выдуманные рубли: в `vydoh_test` учёт пишут
 * тесты с подставным провайдером, за который никто не платил. Отчёт,
 * завышающий расход, врёт так же, как отчёт, его занижающий.
 */
const ACCOUNT_DATABASES = ['vydoh_eval', 'vydoh_e2e', 'vydoh_rehearsal'] as const;

interface Found {
  readonly account: readonly string[];
  /** Базы с учётом, которые в счёт не идут: тесты, черновики, чужое. */
  readonly aside: readonly string[];
  /** Базы, до которых не дозвонились: неполноту надо назвать. */
  readonly unreachable: readonly { database: string; why: string }[];
}

/** Базы на том же сервере, у которых есть таблица учёта. */
async function databasesWithMetering(): Promise<Found> {
  if (named.length > 0) return { account: named, aside: [], unreachable: [] };

  const admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();

  let candidates: string[];
  try {
    const rows = await admin.query<{ datname: string }>(
      "select datname from pg_database where datistemplate = false and datname <> 'postgres' order by datname",
    );
    candidates = rows.rows.map((row) => row.datname);
  } finally {
    await admin.end();
  }

  const own = base.pathname.replace(/^\//u, '');
  const account: string[] = [];
  const aside: string[] = [];
  const unreachable: { database: string; why: string }[] = [];

  for (const database of candidates) {
    const client = new pg.Client({ connectionString: urlFor(database) });

    try {
      await client.connect();
      const has = await client.query<{ yes: boolean }>(
        "select to_regclass('public.ai_calls') is not null as yes",
      );

      if (has.rows[0]?.yes !== true) continue;

      const counts = database === own || ACCOUNT_DATABASES.includes(database as never);
      (counts ? account : aside).push(database);
    } catch (error) {
      /**
       * Молчать нельзя — это тот же способ соврать, что 05.09.2026.
       *
       * Имя чужой базы в этом списке ничего не стоит, а имя своей —
       * единственный способ узнать, что итог неполон.
       */
      unreachable.push({ database, why: error instanceof Error ? error.message : String(error) });
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  return { account, aside, unreachable };
}

interface Row {
  readonly day: string;
  /** Валюта строки: рубли с долларами не складываются. */
  readonly currency: string | null;
  readonly calls: number;
  readonly micros: number;
  readonly unpriced: number;
}

async function readSpend(database: string): Promise<readonly Row[]> {
  const client = new pg.Client({ connectionString: urlFor(database) });
  await client.connect();

  try {
    const rows = await client.query<{
      day: string;
      currency: string | null;
      calls: string;
      micros: string;
      unpriced: string;
    }>(
      /**
       * Сутки — в UTC, и это не мелочь: их же сторожит суточный потолок
       * (`windowStart` в modules/metering/account-spend.ts). Возьми день
       * в поясе сессии Postgres — и отчёт с потолком разошлись бы на
       * сервере с непустым TimeZone, а сегодня совпадали бы случайно.
       *
       * Валюта в группировке потому, что складывать рубли с долларами
       * нельзя: курс на дату вызова задним числом не восстановить. Так
       * же устроен `spendByUser` в modules/metering/ai-calls.repo.ts.
       */
      `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
              cost_currency as currency,
              count(*) as calls,
              coalesce(sum(cost_micros), 0)::bigint as micros,
              count(*) filter (where cost_micros is null and ok) as unpriced
         from ai_calls
        group by 1, 2
        order by 1`,
    );

    return rows.rows.map((row) => ({
      day: row.day,
      currency: row.currency,
      calls: Number(row.calls),
      micros: Number(row.micros),
      unpriced: Number(row.unpriced),
    }));
  } finally {
    await client.end();
  }
}

const found = await databasesWithMetering();

if (found.account.length === 0) {
  process.stderr.write('Ни одной базы счёта с таблицей учёта не нашлось.\n');
  process.exit(1);
}

/** Рубли — отдельно от всего прочего: валюты не складываются. */
const RUB = 'rub';

const byDay = new Map<string, { calls: number; micros: number; unpriced: number }>();
const lines: string[] = ['', 'Расход по базам счёта:', ''];

let totalMicros = 0;
let totalCalls = 0;
let totalUnpriced = 0;
const otherCurrencies = new Map<string, number>();

for (const database of found.account) {
  const rows = await readSpend(database);
  const rubles = rows.filter((row) => row.currency === RUB || row.micros === 0);

  const micros = rubles.reduce((sum, row) => sum + row.micros, 0);
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const unpriced = rows.reduce((sum, row) => sum + row.unpriced, 0);

  for (const row of rows) {
    if (row.currency !== null && row.currency !== RUB && row.micros > 0) {
      otherCurrencies.set(row.currency, (otherCurrencies.get(row.currency) ?? 0) + row.micros);
    }
  }

  totalMicros += micros;
  totalCalls += calls;
  totalUnpriced += unpriced;

  for (const row of rubles) {
    const already = byDay.get(row.day) ?? { calls: 0, micros: 0, unpriced: 0 };
    byDay.set(row.day, {
      calls: already.calls + row.calls,
      micros: already.micros + row.micros,
      unpriced: already.unpriced + row.unpriced,
    });
  }

  const days = [...new Set(rows.map((row) => row.day))].sort();
  const span = days.length === 0 ? '—' : `${days[0] ?? ''}…${days.at(-1) ?? ''}`;

  lines.push(
    `  ${database.padEnd(14)} ${String(calls).padStart(6)} обращений  ` +
      `${rublesOf(micros).padStart(10)} ₽   ${span}`,
  );
}

lines.push(
  '',
  `  ${'ВСЕГО'.padEnd(14)} ${String(totalCalls).padStart(6)} обращений  ` +
    `${rublesOf(totalMicros).padStart(10)} ₽`,
  '',
  'По дням, все базы счёта вместе (сутки по UTC):',
  '',
);

let running = 0;

for (const day of [...byDay.keys()].sort()) {
  const row = byDay.get(day);
  if (row === undefined) continue;

  running += row.micros;
  lines.push(
    `  ${day}  ${String(row.calls).padStart(5)} обращений  ` +
      `${rublesOf(row.micros).padStart(9)} ₽   накоплено ${rublesOf(running).padStart(10)} ₽`,
  );
}

if (totalUnpriced > 0) {
  lines.push(
    '',
    `Внимание: у ${String(totalUnpriced)} удавшихся вызовов цена не записана — ` +
      'итог является нижней оценкой, а не расходом.',
  );
}

/**
 * Всё, что в счёт не пошло, называется вслух.
 *
 * Молчаливая неполнота — тот же способ соврать, каким отчёт по одной
 * базе врал 05.09.2026. Пусть строка будет скучной, зато честной.
 */
if (found.aside.length > 0) {
  lines.push('', `В счёт не идут (тесты и черновики): ${found.aside.join(', ')}`);
}

if (found.unreachable.length > 0) {
  lines.push('', 'Не удалось прочитать — итог неполон:');
  for (const one of found.unreachable) {
    lines.push(`  ${one.database}: ${one.why}`);
  }
}

for (const [currency, micros] of otherCurrencies) {
  lines.push(
    '',
    `Отдельно, не сложено с рублями: ${rublesOf(micros)} в валюте «${currency}». ` +
      'Курс на дату вызова задним числом не восстановить.',
  );
}

lines.push('');
process.stdout.write(lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
