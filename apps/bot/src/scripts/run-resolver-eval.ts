import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BadBudgetError,
  isLiveRun,
  parseBudget,
  recordingEnvFor,
  withRunBudget,
} from '../eval/budget.js';
import { BadOnlyError, parseOnly, pickCases } from '../eval/only.js';
import { loadResolverCases } from '../eval/resolver-dataset.js';
import { parsePins } from '../eval/pins.js';
import {
  checkResolverThreshold,
  collectResolver,
  formatResolver,
} from '../eval/resolver-report.js';
import { runResolverDataset } from '../eval/resolver-runner.js';
import { closeDb, getDb } from '../infra/db.js';
import { createRunGuard } from '../modules/metering/run-guard.js';
import { createLogger } from '../infra/logger.js';
import { flushCassette } from '../modules/ai/cassette/session.js';
import { PromptRegistry } from '../modules/ai/prompts/registry.js';
import { modelEnvSchema } from '../config/env.js';
import { createLlmProvider } from '../modules/ai/providers/factory.js';
import { PRICING } from '../modules/metering/pricing.js';

/**
 * Прогон контрольного набора резолвера (§10.3 ТЗ).
 *
 * Запуск:
 *   DATABASE_URL=… AI_PROVIDER=yandex YANDEX_API_KEY=… YANDEX_FOLDER_ID=… \
 *     npx tsx src/scripts/run-resolver-eval.ts ../../docs/eval/resolver
 *
 * База нужна не для случаев — они заданы разметкой, — а для учёта
 * расхода и промптов: §10.5 требует записывать каждый вызов, включая
 * прогоны стенда. Иначе себестоимость замеров окажется невидимой, а она
 * уже однажды составила три четверти всего расхода.
 *
 * Отчёт кладётся в `runs/` рядом с набором: заслон перед заливкой
 * промпта ищет его там же.
 */

/**
 * Аргументы: набор, необязательная папка отчётов и прикрепления версий.
 *
 * `--use resolver=resolver@8` меряет версию до её включения — без
 * этого §15 и §10.3 запирают друг друга (см. `eval/pins.ts`).
 */
function usage(problem?: string): never {
  process.stderr.write(
    (problem === undefined ? '' : `${problem}\n\n`) +
      'Использование: run-resolver-eval <набор> [отчёты] --budget <₽> [--use resolver=версия] [--only начало-id,…] [--without-dialog]\n' +
      '  --budget — потолок этого прогона в рублях; обязателен для живой модели.\n' +
      '  --only — гнать только случаи, чей id начинается с одного из перечисленного.\n' +
      '  --without-dialog — не показывать модели разговор случаев: замер «как сейчас».\n',
  );
  process.exit(2);
}

let pinned: ReturnType<typeof parsePins>['pinned'];
let budgetRub: number | undefined;
let only: readonly string[] | undefined;
/** Замер «как сейчас»: разговор случаев модели не показывать (план docs/26). */
let withoutDialog: boolean;
let rest: readonly string[];

try {
  const pins = parsePins(process.argv.slice(2));
  const budget = parseBudget(pins.rest);
  const filter = parseOnly(budget.rest);
  pinned = pins.pinned;
  budgetRub = budget.budgetRub;
  only = filter.only;
  withoutDialog = filter.rest.includes('--without-dialog');
  rest = filter.rest.filter((argument) => argument !== '--without-dialog');
} catch (error) {
  if (error instanceof BadBudgetError || error instanceof BadOnlyError) usage(error.message);
  throw error;
}

const [datasetArg, outArg] = rest;

if (datasetArg === undefined) usage();

const dataset: string = datasetArg;
const runs = outArg ?? join(dataset, 'runs');

const env = modelEnvSchema.parse(process.env);

/**
 * Живой прогон — только с названным потолком (правило 20.09.2026, см.
 * `eval/budget.ts`). Стенд выгрузок получил его тогда же, этот — 23.09,
 * когда понадобился первый живой прогон резолвера после того правила.
 * Цена прошлого прогона в отчётах не хранится — сумму по журналу
 * называет тот, кто запускает, из `ai_calls` стенда.
 */
if (isLiveRun(env) && budgetRub === undefined) {
  usage('Живой прогон без --budget не начинается: назовите потолок в рублях.');
}

/** Перевод строки константой: в исходнике его легко потерять правкой. */
const NEWLINE = String.fromCharCode(10);

/** Отметка начала прогона — по ней считается его цена (задача 3.79). */
const startedAt = new Date();
/** Одна отметка на отчёт и плёнку: пару видно по имени файла. */
const stamp = startedAt.toISOString().replace(/[:.]/gu, '-');
const logger = createLogger({ level: 'warn' });
const db = getDb();

/**
 * Живой прогон пишет ответы модели на плёнку (план docs/26, задача 1).
 *
 * Как у стенда выгрузок: следующая проверка правки кода идёт по записи
 * и бесплатно. Повтор и подмена проходят как есть — им писать нечего.
 */
const modelEnv = recordingEnvFor(env, join(runs, `${stamp}.cassette.json`));

/** Сохранить записанное и сказать, как повторить прогон бесплатно. */
async function saveAnswers(): Promise<void> {
  try {
    const summary = await flushCassette();
    if (summary === undefined) return;

    if (summary.mode === 'replay') {
      process.stdout.write(
        `По записи ${summary.path}: промахов ${String(summary.misses)}` +
          (summary.misses > 0 ? ' — вход модели изменился, эти случаи мерят не запись.' : '.') +
          NEWLINE,
      );
      return;
    }

    process.stdout.write(
      [
        `Ответы модели записаны: ${summary.path} (${String(summary.answers)} ответов).`,
        'Повторить бесплатно, по записи:',
        `  AI_PROVIDER=cassette CASSETTE_PATH=${summary.path} npx tsx src/scripts/run-resolver-eval.ts ${process.argv.slice(2).join(' ')}`,
        '',
      ].join(NEWLINE),
    );
  } catch (error) {
    logger.warn({ err: error }, 'Запись ответов модели не сохранилась');
  }
}

try {
  const loaded = await loadResolverCases(dataset);

  if (loaded.length === 0) {
    process.stderr.write(`В «${dataset}» нет ни одного случая.\n`);
    process.exit(2);
  }

  let cases: typeof loaded;
  try {
    cases = pickCases(loaded, only);
  } catch (error) {
    if (error instanceof BadOnlyError) usage(error.message);
    throw error;
  }

  const prompts = new PromptRegistry(db, 0, pinned);
  const active = await prompts.get('resolver');

  process.stdout.write(
    `Прогон ${String(cases.length)} случаев на ${active.version}${withoutDialog ? ', без разговора' : ''}\n\n`,
  );

  /**
   * Потолок расхода до прогона, цена после (задача 3.79).
   *
   * Прогон целого набора по полной модели стоит столько же, сколько
   * набор выгрузок. Первый заход задачи закрыл только два прогона из
   * пяти — этот нашла встречная проверка.
   */
  const guard = createRunGuard({ db, env, logger, startedAt });
  const refused = await guard.checkBefore();

  if (refused !== undefined) {
    process.stderr.write(
      [
        '',
        `Прогон не начат: ${refused}`,
        'Поднимите потолок или подождите новых суток.',
        '',
        '',
      ].join(NEWLINE),
    );
    await closeDb();
    process.exit(3);
  }

  const outcomes = await runResolverDataset(
    {
      db,
      provider: createLlmProvider(modelEnv),
      prompts,
      pricing: PRICING,
      logger,
      // Потолок прогона — поверх потолков счёта: первый про эти деньги,
      // вторые про все.
      spendGuard:
        budgetRub === undefined
          ? guard.spendGuard
          : withRunBudget(guard.spendGuard, { db, startedAt, budgetRub }),
    },
    cases,
    (outcome) => {
      // Верно — и вид решения, и запись: иначе строка «·» врёт, как врал
      // заголовок отчёта до 24.09.2026.
      const right =
        outcome.expected === outcome.actual && (outcome.expected === 'create' || outcome.targetOk);
      const mark = right ? '·' : '×';
      const target = outcome.targetOk ? '' : ' (не та запись)';
      const deadline = outcome.deadlineOk ? '' : ' (не тот срок)';
      const mode = outcome.modeOk ? '' : ' (замена вместо дополнения)';
      const rewrite = outcome.textOk ? '' : ' (переписал слова человека)';

      process.stdout.write(
        `  ${mark} ${outcome.id.padEnd(24)} ждали ${outcome.expected.padEnd(7)} получили ${outcome.actual}${target}${deadline}${mode}${rewrite}\n`,
      );
    },
    { withoutDialog },
  );

  const report = collectResolver(outcomes, active.version);
  process.stdout.write(formatResolver(report));

  const verdict = checkResolverThreshold(report);

  if (verdict.passed) {
    process.stdout.write('Порог пройден.\n');
  } else {
    process.stdout.write(
      `Порог не пройден:\n${verdict.failures.map((line) => `  ${line}`).join('\n')}\n`,
    );
  }

  /**
   * Отчёт сохраняется всегда, включая непройденный.
   *
   * Прогон, который «не получился» и потому не записан, — это потерянное
   * наблюдение: разброс между запусками виден только по череде отчётов.
   */
  await mkdir(runs, { recursive: true });
  await writeFile(join(runs, `${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(`${NEWLINE}${await guard.costReport()}${NEWLINE}${NEWLINE}`);
  await saveAnswers();

  process.exit(verdict.passed ? 0 : 1);
} catch (error) {
  // Оплаченные ответы не теряются и при сбое посреди прогона.
  await saveAnswers();
  throw error;
} finally {
  await closeDb();
}
