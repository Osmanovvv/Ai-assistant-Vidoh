import type { ModelEnv } from '../config/env.js';
import type { Executor } from '../infra/db.js';
import { SpendCeilingError } from '../infra/failures.js';
import { rublesOf } from '../modules/metering/account-spend.js';
import { runCost } from '../modules/metering/run-cost.js';
import type { SpendGuard, SpendNotice } from '../modules/metering/spend-guard.js';

/**
 * Потолок прогона и запись ответов (20.09.2026).
 *
 * **Что случилось.** Замер живого набора обещался в «≈20–25 ₽», а стоил
 * 73 ₽ за прогон; три прогона подряд — 219 ₽, и ни один не записал
 * ответов модели, так что повторить их бесплатно нельзя. Оценка была из
 * головы, а не из журнала, и остановить прогон было нечем, кроме руки.
 *
 * Суточный и общий потолки (задача 3.79) тут не помогают: они про счёт
 * целиком, а не про один прогон, и на стенде их никто не выставил.
 * Поэтому у прогона свой потолок — **сумма, названная перед запуском**:
 *
 * 1. живой прогон без `--budget` не запускается, а перед отказом
 *    печатает цену прошлого прогона из журнала — оценка берётся оттуда,
 *    а не из головы;
 * 2. живой прогон всегда пишет ответы модели рядом с отчётом: любой
 *    следующий замер той же правки кода бесплатен;
 * 3. как только расход прогона по учёту дошёл до потолка, следующий
 *    вызов модели не делается.
 */

export class BadBudgetError extends Error {
  constructor(argument: string | undefined) {
    super(
      argument === undefined
        ? 'После --budget нужна сумма в рублях, например --budget 40'
        : `Не разобрал потолок «${argument}»: нужна сумма в рублях больше нуля, например --budget 40`,
    );
    this.name = 'BadBudgetError';
  }
}

/**
 * Вынимает `--budget <₽>` из аргументов. Остаток — позиционные пути,
 * как у `parsePins`: обе записи флага понимаются одинаково.
 */
export function parseBudget(argv: readonly string[]): {
  readonly budgetRub: number | undefined;
  readonly rest: readonly string[];
} {
  let budgetRub: number | undefined;
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) continue;

    const value =
      argument === '--budget'
        ? argv[++index]
        : argument.startsWith('--budget=')
          ? argument.slice('--budget='.length)
          : undefined;

    if (value === undefined) {
      if (argument === '--budget') throw new BadBudgetError(undefined);
      rest.push(argument);
      continue;
    }

    const parsed = Number(value.replace(',', '.'));
    if (value.trim() === '' || !Number.isFinite(parsed) || parsed <= 0) {
      throw new BadBudgetError(value);
    }

    budgetRub = parsed;
  }

  return { budgetRub, rest };
}

/** Платит ли прогон за ответы: живой Yandex или запись с живого. */
export function isLiveRun(env: Pick<ModelEnv, 'AI_PROVIDER' | 'CASSETTE_MODE'>): boolean {
  return (
    env.AI_PROVIDER === 'yandex' ||
    (env.AI_PROVIDER === 'cassette' && env.CASSETTE_MODE === 'record')
  );
}

/**
 * Живой прогон — всегда с записью ответов по названному пути.
 *
 * Воспроизведение и подмена возвращаются как есть: им писать нечего.
 * Явная запись (`AI_PROVIDER=cassette CASSETTE_MODE=record`) тоже не
 * трогается — человек назвал путь сам.
 */
export function recordingEnvFor<
  E extends Pick<ModelEnv, 'AI_PROVIDER' | 'CASSETTE_MODE' | 'CASSETTE_PATH'>,
>(env: E, cassettePath: string): E {
  if (env.AI_PROVIDER !== 'yandex') return env;

  return { ...env, AI_PROVIDER: 'cassette', CASSETTE_MODE: 'record', CASSETTE_PATH: cassettePath };
}

/** Что из прошлого отчёта нужно оценке: число случаев и цена, если писалась. */
export interface PricedReport {
  readonly cases: number;
  readonly cost?: { readonly runMicros: number; readonly calls: number } | undefined;
}

/**
 * Оценка перед прогоном — из журнала.
 *
 * Прошлый прогон стоил столько-то за столько-то случаев; значит этот, на
 * N случаев, — около такой суммы. Не прогноз, а арифметика по последнему
 * замеру: модель может подорожать, набор — удлиниться, но «из головы»
 * ошибалось втрое, а это — на проценты.
 */
export function estimateLine(previous: PricedReport | undefined, cases: number): string {
  if (previous?.cost === undefined || previous.cases <= 0) {
    return 'Прошлого прогона с ценой нет — оценить не по чему. Первый живой прогон — с малым потолком.';
  }

  const perCase = previous.cost.runMicros / previous.cases;
  const estimate = perCase * cases;

  return (
    `Прошлый прогон: ${rublesOf(previous.cost.runMicros)} ₽ за ${String(previous.cases)} случаев ` +
    `(${rublesOf(perCase)} ₽ на случай). Этот, ${String(cases)} случаев: около ${rublesOf(estimate)} ₽.`
  );
}

/** Отказ живому прогону без потолка — с оценкой и командой. */
export function refusalWithoutBudget(previous: PricedReport | undefined, cases: number): string {
  return [
    'Живой прогон без потолка не запускается.',
    estimateLine(previous, cases),
    'Назовите сумму: --budget <₽>. Дойдя до неё по учёту, прогон остановится.',
  ].join('\n');
}

export interface RunBudgetDeps {
  readonly db: Executor;
  /** Отметка начала прогона: всё, что легло в учёт после неё, — прогон. */
  readonly startedAt: Date;
  readonly budgetRub: number;
  readonly now?: (() => Date) | undefined;
}

/**
 * Страж потолка прогона поверх стража счёта.
 *
 * Перед каждым обращением к модели — расход прогона по учёту; дошёл до
 * потолка — обращение не делается, а прогон помечает случай отказом.
 * Вердикт `exceeded` попадает в `report()`, и отчёт такого прогона в
 * точку сравнения не идёт — как при суточном потолке.
 *
 * Запрос к базе на каждый вызов — сознательно без кэша: у прогона три
 * вызова на случай, а кэш в пятнадцать секунд пропустил бы ровно тот
 * дорогой вызов, ради которого потолок и стоит.
 */
export function withRunBudget(inner: SpendGuard, deps: RunBudgetDeps): SpendGuard {
  const ceilingMicros = Math.round(deps.budgetRub * 1_000_000);
  const now = deps.now ?? ((): Date => new Date());
  let last: SpendNotice | undefined;

  const check = async (): Promise<SpendNotice> => {
    const cost = await runCost(deps.db, { startedAt: deps.startedAt, now: now() });
    const share = cost.runMicros / ceilingMicros;

    last = {
      window: 'all',
      verdict: {
        exceeded: cost.runMicros >= ceilingMicros,
        share,
        warn: share >= 0.8,
        spentMicros: cost.runMicros,
        ceilingMicros,
        partial: cost.partial,
      },
      exceeded: cost.runMicros >= ceilingMicros,
      ...(cost.partial ? { blind: true } : {}),
    };

    return last;
  };

  return {
    beforeCall: async (): Promise<void> => {
      const notice = await check();
      if (notice.exceeded) {
        throw new SpendCeilingError(
          `потолок прогона ${rublesOf(ceilingMicros)} ₽ достигнут: ` +
            `потрачено ${rublesOf(notice.verdict.spentMicros)} ₽`,
        );
      }
      await inner.beforeCall();
    },
    noteSpent: (micros) => {
      inner.noteSpent(micros);
    },
    report: async (): Promise<readonly SpendNotice[]> => [
      ...(await inner.report()),
      ...(last === undefined ? [] : [last]),
    ],
  };
}

/**
 * Последний **отчёт** среди файлов папки `runs`.
 *
 * Рядом с отчётом лежат `<штамп>.trace.json` и `<штамп>.cassette.json`,
 * и по алфавиту оба идут после отчёта того же прогона. «Последний .json»
 * оказывался следом — массивом, — и разница с прошлым прогоном считалась
 * от него. Отчёт — это ровно штамп и `.json`, без вторых расширений.
 */
export function latestReportName(names: readonly string[]): string | undefined {
  return reportNames(names).at(-1);
}

/** Отчёты среди файлов папки `runs`, от старого к новому. */
export function reportNames(names: readonly string[]): readonly string[] {
  return names.filter((name) => /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/u.test(name)).sort();
}
