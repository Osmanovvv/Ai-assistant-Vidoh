import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Заглушка прогона контрольного набора — для браузерных проверок панели
 * (задача 4.8).
 *
 * Настоящий прогон ходит к живой модели по всему набору и стоит денег:
 * 05.09.2026 у продукта именно на таких прогонах кончился грант. Гонять
 * его на каждой проверке нельзя, а проверять кнопку надо — она стоит
 * рядом с заслоном §10.3 и от неё зависит, обойдут заслон или соблюдут.
 *
 * Заглушка делает ровно то, от чего заслон зависит: пишет отчёт **на той
 * версии, которую попросили измерить**. Всё остальное в проверке
 * настоящее — и отказ без отчёта, и разрешение с ним.
 *
 * Живёт рядом с проверками, а не в `src`: в образ ей попадать незачем.
 *
 * Запуск (так её зовёт стенд):
 *   node tests/admin/eval-stub.mjs <папка-набора> [--use стадия=версия]
 */

const [, , directory, ...rest] = process.argv;

if (directory === undefined) {
  process.stderr.write('Заглушке нужна папка набора\n');
  process.exit(2);
}

const runs = join(directory, 'runs');

/**
 * Версии из прошлого отчёта: заглушка меняет только прикреплённые.
 *
 * Разбор чужого JSON проверяется по полю, а не приводится к типу:
 * `JSON.parse` отдаёт `any`, и доверие к нему сделало бы заглушку тем
 * местом, где проверка падает по своей вине, а не по делу.
 */
async function previousVersions() {
  /** @type {Record<string, string>} */
  const empty = {};

  try {
    const files = (await readdir(runs)).filter((name) => name.endsWith('.json')).sort();
    const last = files.at(-1);
    if (last === undefined) return empty;

    /** @type {unknown} */
    const report = JSON.parse(await readFile(join(runs, last), 'utf8'));

    if (typeof report !== 'object' || report === null) return empty;

    const found = /** @type {{ promptVersions?: unknown }} */ (report).promptVersions;

    if (typeof found !== 'object' || found === null) return empty;

    for (const [stage, version] of Object.entries(found)) {
      if (typeof version === 'string') empty[stage] = version;
    }

    return empty;
  } catch {
    return empty;
  }
}

const versions = await previousVersions();

for (let index = 0; index < rest.length; index++) {
  if (rest[index] !== '--use') continue;

  const value = rest[index + 1] ?? '';
  const at = value.indexOf('=');
  if (at === -1) continue;

  versions[value.slice(0, at)] = value.slice(at + 1);
}

const report = {
  expected: 40,
  found: 40,
  missed: 0,
  extra: 0,
  typeCorrect: 40,
  priorityCorrect: 40,
  topicCorrect: 40,
  recurrenceCorrect: 40,
  projectCorrect: 40,
  projectChecked: 40,
  deadlineCorrect: 40,
  falseDeadlines: 0,
  falseTasksFromDesires: 0,
  falseTasksFromEmotions: 0,
  retractedKept: 0,
  crisisExpected: 0,
  crisisDetected: 0,
  crisisFalse: 0,
  crisisMissed: 0,
  failed: 0,
  ambiguous: 0,
  cases: 10,
  promptVersions: versions,
};

await mkdir(runs, { recursive: true });

// Имя отчёта — время: по нему заслон отличает свежий прогон от старого.
const name = `${new Date().toISOString().replaceAll(':', '-').replace('.', '-')}.json`;
await writeFile(join(runs, name), JSON.stringify(report), 'utf8');

process.stdout.write(
  `Заглушка прогона: отчёт ${name} на версиях ${JSON.stringify(versions)} — порог пройден.\n`,
);
