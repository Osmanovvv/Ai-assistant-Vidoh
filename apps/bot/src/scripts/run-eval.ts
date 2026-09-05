import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadDataset } from '../eval/dataset.js';
import { ANY, checkThreshold, collect, format, type EvalReport } from '../eval/report.js';
import { runDataset } from '../eval/runner.js';
import { modelEnvSchema } from '../config/env.js';
import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { PromptRegistry } from '../modules/ai/prompts/registry.js';
import { createLlmProvider } from '../modules/ai/providers/factory.js';
import { upsertUser } from '../modules/users/users.repo.js';

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

const [, , directory] = process.argv;

if (directory === undefined) {
  process.stderr.write(
    'Использование: run-eval <папка-с-набором>\n' +
      '  Настоящий набор лежит в docs/eval — вне репозитория.\n' +
      '  Синтетический, для проверки самого стенда: src/eval/synthetic\n',
  );
  process.exit(2);
}

// Читаемый вывод — только в терминале человека: в контейнере
// без `pino-pretty` он не нужен и раньше ронял скрипт.
const logger = createLogger({ level: 'info', pretty: process.stdout.isTTY });
const env = modelEnvSchema.parse(process.env);
const db = getDb();

/** Прошлый прогон: по нему считается разница. */
async function previousRun(runs: string): Promise<EvalReport | undefined> {
  try {
    const files = (await readdir(runs)).filter((name) => name.endsWith('.json')).sort();
    const last = files.at(-1);
    if (last === undefined) return undefined;

    return JSON.parse(await readFile(join(runs, last), 'utf8')) as EvalReport;
  } catch {
    // Первого прогона ещё не было — это не ошибка.
    return undefined;
  }
}

try {
  const cases = await loadDataset(directory);
  logger.info({ случаев: cases.length }, 'Набор загружен');

  const prompts = new PromptRegistry(db);
  const full = createLlmProvider(env);
  const light = createLlmProvider(env, { light: true });

  logger.info({ полная: full.name, лёгкая: light.name }, 'Провайдеры выбраны');

  /**
   * Пользователь стенда: от его имени открываются выгрузки, к которым
   * привязывается расход. Без привязки себестоимость выгрузки (2.21) из
   * учёта не собирается — вызовы есть, а к чему они относятся, нет.
   *
   * Идентификатор заведомо не занят живым человеком: у Telegram таких
   * не бывает. Тот же приём, что в сквозном тесте первого этапа.
   */
  const owner = await upsertUser(db, { tgId: 999_000_777, firstName: 'стенд' });

  const outcomes = await runDataset(
    {
      ai: { db, provider: full, prompts, logger },
      aiLight: { db, provider: light, prompts, logger },
      logger,
      owner: owner.id,
    },
    cases,
  );

  // Модели пишутся в отчёт вместе с версиями промптов: разница между
  // двумя прогонами может быть не в промпте, а в поколении модели.
  const report = { ...collect(outcomes), models: { полная: full.name, лёгкая: light.name } };
  const runs = join(directory, 'runs');
  const previous = await previousRun(runs);

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

  if (nothingMeasured) {
    logger.warn(
      { случаев: report.cases },
      'Ни один случай не разобрался — прогон не сохранён, чтобы не стать точкой сравнения',
    );
  } else {
    await mkdir(runs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    await writeFile(join(runs, `${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');
    logger.info({ файл: `${stamp}.json` }, 'Прогон сохранён');
  }

  await closeDb();
  process.exit(verdict.passed ? 0 : 1);
} catch (error) {
  logger.error({ err: error }, 'Прогон не удался');
  await closeDb();
  process.exit(1);
}
