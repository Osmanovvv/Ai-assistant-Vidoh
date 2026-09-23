import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BadBudgetError,
  estimateLine,
  isLiveRun,
  latestReportName,
  parseBudget,
  recordingEnvFor,
  refusalWithoutBudget,
  reportNames,
  withRunBudget,
} from '../eval/budget.js';
import { loadDataset } from '../eval/dataset.js';
import { BadPinError, parsePins } from '../eval/pins.js';
import { ANY, checkThreshold, collect, format, type EvalReport } from '../eval/report.js';
import { runDataset } from '../eval/runner.js';
import { modelEnvSchema } from '../config/env.js';
import type { AiStage } from '../db/schema.js';
import { closeDb, getDb } from '../infra/db.js';
import { ceilingFromEnv } from '../modules/metering/account-spend.js';
import { costLine, runCost, type RunCost } from '../modules/metering/run-cost.js';
import { createSpendGuard } from '../modules/metering/spend-guard.js';
import { createLogger } from '../infra/logger.js';
import { flushCassette } from '../modules/ai/cassette/session.js';
import { PromptRegistry } from '../modules/ai/prompts/registry.js';
import { createLlmProvider } from '../modules/ai/providers/factory.js';
import { createEmbeddingProvider } from '../modules/embedder/providers/factory.js';

/**
 * Прогон контрольного набора (задачи 2.19 и 2.20).
 *
 * Запуск:
 *   DATABASE_URL=… AI_PROVIDER=yandex YANDEX_API_KEY=… YANDEX_FOLDER_ID=… \
 *     npx tsx src/scripts/run-eval.ts ../../docs/eval
 *
 * §10.3 требует прогона на каждое изменение промпта. Отчёт печатается и
 * складывается в `<папка>/runs`, чтобы следующий прогон показал разницу:
 * без сравнения с прошлым числа не значат ничего.
 *
 * **Базу берёт ту, что дана.** Расход прогона пишется в учёт, как у
 * настоящих вызовов (§10.5) — значит боевую базу подставлять нельзя,
 * иначе прогоны исказят себестоимость выгрузки.
 */

/**
 * Аргументы: путь к набору, потолок прогона и необязательные
 * прикрепления версий.
 *
 *   npx tsx src/scripts/run-eval.ts ../../docs/eval --budget 40
 *   npx tsx src/scripts/run-eval.ts ../../docs/eval --budget 40 --use classifier=classifier@6
 *
 * Прикрепление нужно, чтобы измерить версию **до** включения: этого
 * требует связка §15 и §10.3 (см. `eval/pins.ts`).
 *
 * **Потолок обязателен у живого прогона** (20.09.2026, см. `eval/budget.ts`):
 * без него прогон не начнётся, а перед отказом назовёт цену прошлого
 * прогона из журнала. Живой прогон всегда пишет ответы модели рядом с
 * отчётом — `runs/<штамп>.cassette.json`, — и повторить его по записи
 * можно бесплатно:
 *
 *   AI_PROVIDER=cassette CASSETTE_PATH=../../docs/eval/runs/<штамп>.cassette.json \
 *     npx tsx src/scripts/run-eval.ts ../../docs/eval
 */
function usage(problem?: string): never {
  process.stderr.write(
    (problem === undefined ? '' : `${problem}\n\n`) +
      'Использование: run-eval <папка-с-набором> --budget <₽> [--use стадия=версия]\n' +
      '  Настоящий набор лежит в docs/eval — вне репозитория.\n' +
      '  Синтетический, для проверки самого стенда: src/eval/synthetic\n' +
      '  --budget — потолок этого прогона в рублях; обязателен для живой модели.\n',
  );
  process.exit(2);
}

let pinned: ReadonlyMap<AiStage, string>;
let budgetRub: number | undefined;
let rest: readonly string[];

try {
  const pins = parsePins(process.argv.slice(2));
  const budget = parseBudget(pins.rest);
  pinned = pins.pinned;
  budgetRub = budget.budgetRub;
  rest = budget.rest;
} catch (error) {
  if (error instanceof BadPinError || error instanceof BadBudgetError) usage(error.message);
  throw error;
}

const [directory] = rest;

if (directory === undefined) usage();

/** Папка набора — уже проверенная: объявлениям функций ниже сужение не видно. */
const datasetDir: string = directory;

// Читаемый вывод — только в терминале человека: в контейнере
// без `pino-pretty` он не нужен и раньше ронял скрипт.
const logger = createLogger({ level: 'info', pretty: process.stdout.isTTY });
const env = modelEnvSchema.parse(process.env);
const db = getDb();

/** Прошлый прогон: по нему считается разница. */
async function previousRun(runs: string): Promise<EvalReport | undefined> {
  try {
    const last = latestReportName(await readdir(runs));
    if (last === undefined) return undefined;

    return JSON.parse(await readFile(join(runs, last), 'utf8')) as EvalReport;
  } catch {
    // Первого прогона ещё не было — это не ошибка.
    return undefined;
  }
}

/**
 * Последний прогон **с ценой**: по нему оценивается этот.
 *
 * Не просто последний: между живыми прогонами бывают прогоны по записи и
 * на подмене, у них цены нет — и оценка «около 0 ₽» была бы ложью.
 */
async function lastPricedRun(runs: string): Promise<EvalReport | undefined> {
  try {
    const names = [...reportNames(await readdir(runs))].reverse();
    for (const name of names) {
      const report = JSON.parse(await readFile(join(runs, name), 'utf8')) as EvalReport;
      if (report.cost !== undefined) return report;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Отметка начала прогона — до первого обращения к модели (задача 3.79).
 *
 * По ней в конце считается цена **этого** прогона. Ставится здесь, а не
 * внутри: всё, что записалось в учёт после неё, прогоном и потрачено.
 */
const startedAt = new Date();

/**
 * Штамп прогона — один на отчёт, след и запись ответов, и ставится до
 * первого обращения к модели: путь записи нужен провайдеру при создании.
 */
const stamp = startedAt.toISOString().replace(/[:.]/gu, '-');
const runs = join(directory, 'runs');
const live = isLiveRun(env);

/** Сохранить записанные ответы; печатает, как повторить прогон бесплатно. */
async function saveAnswers(): Promise<void> {
  if (!live) return;

  try {
    const summary = await flushCassette();
    if (summary === undefined) return;

    process.stdout.write(
      [
        '',
        `Ответы модели записаны: ${summary.path} (${String(summary.answers)} ответов` +
          (summary.collisions > 0 ? `, ${String(summary.collisions)} разночтений` : '') +
          (summary.reused.llm + summary.reused.vectors > 0
            ? `; из основы бесплатно: ${String(summary.reused.llm)} ответов и ${String(summary.reused.vectors)} векторов`
            : '') +
          ').',
        'Повторить прогон бесплатно, по записи:',
        `  AI_PROVIDER=cassette CASSETTE_PATH=${summary.path} npx tsx src/scripts/run-eval.ts ${datasetDir}`,
        '',
      ].join('\n'),
    );
  } catch (error) {
    logger.warn({ err: error }, 'Запись ответов модели не сохранилась');
  }
}

try {
  const cases = await loadDataset(directory);
  logger.info({ случаев: cases.length }, 'Набор загружен');
  const previous = await previousRun(runs);

  /**
   * Живой прогон — только с названным потолком (20.09.2026).
   *
   * Оценка печатается из журнала прошлого прогона, а не из головы:
   * «≈20–25 ₽» из головы обернулись 73 ₽ трижды. Без суммы прогон не
   * начинается.
   */
  if (live) {
    const priced = await lastPricedRun(runs);

    if (budgetRub === undefined) {
      process.stderr.write(`\n${refusalWithoutBudget(priced, cases.length)}\n\n`);
      await closeDb();
      process.exit(2);
    }

    process.stdout.write(
      `\n${estimateLine(priced, cases.length)}\nПотолок этого прогона: ${budgetRub.toFixed(2)} ₽.\n\n`,
    );
    await mkdir(runs, { recursive: true });
  }

  /**
   * Потолок расхода проверяется **до** прогона (задача 3.79).
   *
   * Прогон набора стоит 42–350 ₽ и делается по многу раз в день. Узнать
   * о перейдённом потолке после того, как деньги ушли, — то же, что не
   * узнать: именно так 05.09.2026 и кончился грант.
   */
  const ceilings = {
    ...(ceilingFromEnv(env.ACCOUNT_SPEND_CEILING_RUB) === undefined
      ? {}
      : { total: ceilingFromEnv(env.ACCOUNT_SPEND_CEILING_RUB) }),
    ...(ceilingFromEnv(env.ACCOUNT_SPEND_DAILY_RUB) === undefined
      ? {}
      : { daily: ceilingFromEnv(env.ACCOUNT_SPEND_DAILY_RUB) }),
  };

  const accountGuard = createSpendGuard({
    db,
    ceilings,
    warnShare: env.ACCOUNT_SPEND_WARN_SHARE,
    logger,
  });

  // Потолок прогона — поверх потолков счёта: первый про эти деньги,
  // вторые про все.
  const spendGuard =
    budgetRub === undefined
      ? accountGuard
      : withRunBudget(accountGuard, { db, startedAt, budgetRub });

  try {
    await spendGuard.beforeCall();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      ['', `Прогон не начат: ${why}`, 'Поднимите потолок или подождите новых суток.', '', ''].join(
        '\n',
      ),
    );
    await closeDb();
    process.exit(3);
  }

  // Кэш ни к чему: прогон читает промпт по разу на стадию.
  const prompts = new PromptRegistry(db, 0, pinned);

  if (pinned.size > 0) {
    logger.info(
      { версии: Object.fromEntries(pinned) },
      'Прогон на прикреплённых версиях, а не на активных',
    );
  }

  // Живой прогон всегда пишет ответы: следующий замер той же правки кода
  // будет по записи и бесплатно.
  const modelEnv = recordingEnvFor(env, join(runs, `${stamp}.cassette.json`));
  const full = createLlmProvider(modelEnv);
  const light = createLlmProvider(modelEnv, { light: true });
  // Маршрутизатор — своей моделью, как в бою (решение Никиты 23.09.2026).
  const routerModel = createLlmProvider(modelEnv, { router: true });

  // Вектора — тем же провайдером, что модель: в бою они есть, и без них
  // стенд отсеивал бы повторы и искал цели правок иначе, чем бой.
  const embedder = createEmbeddingProvider(modelEnv);

  logger.info(
    {
      полная: full.name,
      лёгкая: light.name,
      маршрутизатор: routerModel.name,
      вектора: embedder.name,
    },
    'Провайдеры выбраны',
  );

  /**
   * Случаи идут через боевой обработчик выгрузки (20.09.2026): у каждого
   * свой пользователь стенда с поясом и сферами случая — их заводит
   * прогонщик. Расход ложится в учёт с привязкой к выгрузке, как в бою.
   */
  const outcomes = await runDataset(
    {
      ai: { db, provider: full, prompts, logger, spendGuard },
      aiLight: { db, provider: light, prompts, logger, spendGuard },
      aiRouter: { db, provider: routerModel, prompts, logger, spendGuard },
      embedder,
      logger,
    },
    cases,
  );

  /**
   * Цена прогона считается до отчёта: она ложится в него, и по ней
   * следующий прогон оценивается заранее.
   *
   * В своём try/catch: это три запроса к базе, и отвались соединение —
   * код выхода соврал бы про **качество** из-за строчки про деньги.
   */
  let cost: RunCost | undefined;
  try {
    cost = await runCost(db, { startedAt, now: new Date() });
  } catch (error) {
    logger.warn({ err: error }, 'Цену прогона посчитать не удалось');
  }

  // Модели пишутся в отчёт вместе с версиями промптов: разница между
  // двумя прогонами может быть не в промпте, а в поколении модели.
  const report: EvalReport = {
    ...collect(outcomes),
    models: { полная: full.name, лёгкая: light.name },
    // Цена — только у живого прогона, который что-то потратил: прогон по
    // записи или на подмене стоит ноль, и как основа оценки он врал бы.
    ...(live && cost !== undefined && cost.runMicros > 0
      ? { cost: { runMicros: cost.runMicros, calls: cost.calls } }
      : {}),
  };

  process.stdout.write(`\n${format(report, previous)}\n\n`);

  // Промахи по одному: без них отчёт говорит «85%», но не говорит, где
  // именно ошиблись, а править надо промпт, а не число.
  for (const outcome of outcomes) {
    for (const unit of outcome.result.missed) {
      process.stdout.write(
        `  потеряно [${outcome.id}] ${unit.keywords.join(' + ')}${unit.why === '' ? '' : ` — ${unit.why}`}\n`,
      );
    }
    for (const { expected, actual } of outcome.result.matched) {
      if (actual.type !== expected.type) {
        process.stdout.write(
          `  тип [${outcome.id}] «${actual.text}»: ожидался ${expected.type}, получен ${actual.type}\n`,
        );
      }
    }
    /**
     * Тема, важность и повторение считались числом, но построчно не
     * печатались.
     *
     * Из-за этого просадку было видно, а причину — нет: 01.09.2026
     * точность темы упала с 43 из 43 до 42, и найти виновную запись
     * оказалось нечем. Отчёт, который говорит «стало хуже» и не говорит
     * «где именно», заставляет гадать — а стенд затевали как раз против
     * гадания.
     */
    for (const { expected, actual } of outcome.result.matched) {
      if (expected.topic !== ANY && actual.topic !== expected.topic) {
        process.stdout.write(
          `  тема [${outcome.id}] «${actual.text}»: ожидалась ${expected.topic}, получена ${actual.topic}\n`,
        );
      }

      if (expected.priority !== ANY && actual.priority !== expected.priority) {
        process.stdout.write(
          `  важность [${outcome.id}] «${actual.text}»: ожидалась ${expected.priority}, получена ${actual.priority}\n`,
        );
      }

      /**
       * Проект: своя строка, потому что число без неё ничего не доказывает.
       *
       * Урок дня 05.09.2026, и я наступил на него дважды. Сперва счёт
       * «точность срока» учитывал промах по дате и не печатал строку — я
       * прочёл молчание как «верно». Потом добавил счётчик проекта и снова
       * забыл строку: отчёт сказал «3 из 5», а какая цель не распознана,
       * узнать было нечем.
       *
       * Правило: добавил число — добавь строку.
       */
      if (expected.isProject !== ANY && actual.isProject !== expected.isProject) {
        const asGoal = (flag: boolean): string => (flag ? 'большой целью' : 'обычным делом');

        process.stdout.write(
          `  проект [${outcome.id}] «${actual.text}»: ожидался ${asGoal(expected.isProject)}, ` +
            `получен ${asGoal(actual.isProject)}\n`,
        );
      }

      const kind =
        actual.recurrence?.text !== undefined && actual.recurrence.rule === undefined
          ? 'unclear'
          : (actual.recurrence?.rule?.kind ?? 'none');

      if (kind !== expected.recurrence) {
        process.stdout.write(
          `  повторение [${outcome.id}] «${actual.text}»: ожидалось ${expected.recurrence}, получено ${kind}\n`,
        );
      }
    }
    for (const { expected, actual } of outcome.result.matched) {
      const accuracy = actual.deadline?.accuracy ?? 'none';
      if (expected.deadline === '*') continue;

      /**
       * Дата печатается в поясе человека, а не в UTC.
       *
       * В UTC московский срок выглядит на день раньше: «5 сентября»
       * печаталось как 2026-09-04, и я чуть не пошёл искать ошибку
       * off-by-one, которой не было. Сравнение всегда считалось в поясе —
       * врал только вывод, то есть ровно то, на что смотрят.
       */
      const isoDate =
        actual.deadline === undefined
          ? ''
          : new Intl.DateTimeFormat('sv-SE', { timeZone: outcome.timeZone }).format(
              actual.deadline.at,
            );
      const date = isoDate === '' ? '' : ` ${isoDate}`;

      if (accuracy !== expected.deadline) {
        process.stdout.write(
          `  срок [${outcome.id}] «${actual.text}»: ожидался ${expected.deadline}, получен ${accuracy}${date}
`,
        );
        continue;
      }

      /**
       * Верная точность при неверной дате тоже промах — и он был невидим
       * (задача 3.59).
       *
       * Счёт «точность срока» такой промах учитывал, а построчно он не
       * печатался: проверка выше выходила, как только точность совпала.
       * 04.09.2026 на живой расшифровке «позвонить бабушке» получало
       * 05.09 вместо 04.09 — точность дневная, дата чужая, — и отчёт
       * показывал 97,4% без единой строки, где именно. Я прочёл это как
       * «на стенде верно», и это было неправдой.
       */
      if (expected.deadlineDate !== undefined && isoDate !== expected.deadlineDate) {
        process.stdout.write(
          `  дата [${outcome.id}] «${actual.text}»: ожидалась ${expected.deadlineDate}, получена ${
            isoDate === '' ? 'нет' : isoDate
          }
`,
        );
      }
    }
    for (const item of outcome.result.extra) {
      process.stdout.write(`  лишнее [${outcome.id}] «${item.text}»\n`);
    }
    // Двоякое ожидание — это наша ошибка разметки, и она искажает счёт:
    // одно ожидание забирает запись, которую ждало другое, и второе
    // считается потерянным. Поэтому надо назвать виновника, а не только
    // сообщить, что он есть.
    for (const unit of outcome.result.ambiguous) {
      process.stdout.write(
        `  двояко [${outcome.id}] ${unit.keywords.join(' + ')} — корни подошли больше чем одной записи\n`,
      );
    }
    if (outcome.failed !== undefined) {
      process.stdout.write(`  отказ [${outcome.id}] ${outcome.failed}\n`);
    }
  }

  const verdict = checkThreshold(report);
  process.stdout.write(
    verdict.passed
      ? '\nПорог качества пройден.\n'
      : `\nПорог качества НЕ пройден:\n${verdict.failures.map((line) => `  — ${line}`).join('\n')}\n`,
  );

  /**
   * Прогон, в котором не разобрался ни один случай, в замеры не идёт.
   *
   * **Случилось 01.09.2026.** Набор запустили без залитых промптов, все
   * три случая отказали — и этот ноль лёг в `runs` и стал точкой
   * сравнения. Следующий прогон бодро показал «+100 процентных пунктов»
   * ко всему, то есть скрыл настоящую разницу с последним настоящим
   * замером. Такой файл хуже отсутствующего: он не измеряет ничего, но
   * выглядит как измерение.
   *
   * Отказ **части** случаев сохраняется: это уже наблюдение о качестве.
   */
  const nothingMeasured = report.failed === report.cases && report.cases > 0;

  /**
   * Прогон, остановленный потолком, точкой сравнения не становится
   * (задача 3.79, находка встречной проверки).
   *
   * Кончись деньги посреди прогона — страж бросает на каждом следующем
   * случае, разбор считает их потерянными, и в `runs/` ложится отчёт с
   * провальной точностью. Следующий прогон сравнится с ним и покажет
   * «фантастическое улучшение». У этого проекта уже пять случаев, когда
   * набор мерил не то; шестой будет про деньги, если не остановиться.
   */
  const overCeiling = (await spendGuard.report()).some((notice) => notice.exceeded);

  /**
   * Уточнение по встречной проверке: перейдённый потолок сам по себе
   * замер не портит.
   *
   * Прогон, где все случаи прошли, а последний вызов перевёл расход через
   * потолок, — годное наблюдение, и выкидывать его значило бы терять
   * измерение из-за денег. Портит замер другое: случаи, которые не
   * разобрались. Поэтому признак — оба условия вместе.
   */
  const stoppedByCeiling = overCeiling && report.failed > 0;

  if (stoppedByCeiling) {
    logger.warn(
      { провалено: report.failed, случаев: report.cases },
      'Прогон упёрся в потолок расхода — отчёт не сохранён: он мерил бы деньги, а не качество',
    );
  } else if (nothingMeasured) {
    logger.warn(
      { случаев: report.cases },
      'Ни один случай не разобрался — прогон не сохранён, чтобы не стать точкой сравнения',
    );
  } else {
    await mkdir(runs, { recursive: true });
    await writeFile(join(runs, `${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');
    /**
     * След — отдельным файлом: отчёт сравнивается с прошлым, и лишнее в
     * нём мешало бы; след читается руками, когда промах надо объяснить.
     */
    await writeFile(
      join(runs, `${stamp}.trace.json`),
      JSON.stringify(
        outcomes.map((outcome) => ({
          id: outcome.id,
          routed: outcome.routed,
          trace: outcome.trace,
        })),
        null,
        2,
      ),
      'utf8',
    );
    logger.info({ файл: `${stamp}.json` }, 'Прогон сохранён');
  }

  // Цена прогона — последней строкой, рядом с итогом.
  if (cost !== undefined) {
    process.stdout.write(['', costLine(cost, ceilings), '', ''].join('\n'));
  }

  await saveAnswers();
  await closeDb();
  process.exit(verdict.passed ? 0 : 1);
} catch (error) {
  logger.error({ err: error }, 'Прогон не удался');
  // Ответы, за которые уже заплачено, сохраняются и при отказе прогона.
  await saveAnswers();
  await closeDb();
  process.exit(1);
}
