import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { checkThreshold, type EvalReport } from './report.js';
import { checkResolverThreshold, type ResolverReport } from './resolver-report.js';

/**
 * Прогнан ли контрольный набор на этих версиях промптов (§10.3 ТЗ).
 *
 * §10.3 дословно: «Любое изменение промпта прогоняется по контрольному
 * набору. **Выкладка только при отсутствии ухудшения.**»
 *
 * **Это правило уже нарушалось, и дорого.** 28.08.2026 выложили
 * `router@3`, потом `router@4`, не прогнав набор. Регрессия дошла до
 * боевого и жила там, пока не попросили перемерить приёмку: промпт терял
 * три единицы из сорока трёх — семь процентов сказанного человеком не
 * превращалось в записи.
 *
 * **Вынесено сюда из скрипта заливки, потому что читателей стало два.**
 * Второй — админ-панель (задача 4.8): §15 разрешает менять промпт без
 * выкладки, и без этой проверки «без выкладки» превращается в способ
 * уронить качество молча, минуя единственный заслон. Две копии одного
 * правила разошлись бы, и разошлись бы в сторону «разрешить».
 *
 * **Наборов два, и это важно.** Общий мерит разбор (маршрутизатор,
 * извлечение, классификация), у резолвера свой — со своим отчётом и своим
 * порогом. Пока проверка резолвера жила только в скрипте заливки, панель
 * могла включить его промпт вообще без измерения: ровно та дыра, ради
 * которой заслон и ставится. Теперь оба набора проверяются здесь.
 */

export interface FreshnessOk {
  readonly ok: true;
  /** Отчёты, которыми подтверждены включаемые версии. */
  readonly runs: readonly string[];
  /**
   * Стадии, у которых измерителя нет вовсе.
   *
   * Не «всё хорошо», а «мерить нечем»: включение разрешено, но человеку
   * это надо сказать вслух, иначе молчание прочтётся как проверка.
   */
  readonly unmeasured: readonly string[];
}

/**
 * Причина отказа — готовой строкой, а стадия, если она есть, отдельно.
 *
 * **Найдено ревизией панели.** Причина про стадию собиралась строкой
 * вместе с ключом из базы — `router: включается X, а мерили Y`, — и
 * уезжала человеку на экран как есть. Заказчица и проджект читают в
 * одном месте «Маршрутизатор», а в другом «router», и должны догадаться,
 * что это одно и то же. Ключи стадий не для глаз, но человеческие имена
 * живут в панели: здесь их взять негде, а значит и склеивать причину
 * здесь нельзя.
 *
 * Скриптам ключ как раз и нужен — таким, каким он в базе и в отчёте, —
 * поэтому они склеивают строку сами (`scripts/check-eval-fresh.ts`).
 */
export type FreshnessReason = string | { readonly stage: string; readonly text: string };

export interface FreshnessProblem {
  readonly ok: false;
  readonly reasons: readonly FreshnessReason[];
  /** Отчёты, которые смотрели: пусто, если их не нашлось. */
  readonly runs: readonly string[];
}

/** Прогона нет, он про другие версии или не прошёл порог. */
export type FreshnessVerdict = FreshnessOk | FreshnessProblem;

/**
 * Стадии, которые прогоняет общий набор.
 *
 * Представления здесь нет: набор мерит **разбор**, а не ответ. Поэтому
 * промпт представления можно менять без прогона — и это не послабление, а
 * отсутствие измерителя, о котором надо помнить.
 */
export const MEASURED_STAGES = ['router', 'extractor', 'classifier'] as const;

export type MeasuredStage = (typeof MEASURED_STAGES)[number];

/** У резолвера свой набор, свой отчёт и свой порог. */
export const RESOLVER_STAGE = 'resolver';

/**
 * Форма отчёта проверяется при чтении, а не приводится типом (ревизия 4).
 *
 * **Самая дорогая находка ревизии в этом файле.** Отчёт читался
 * `JSON.parse` и приводился к типу — то есть не проверялся вовсе. А все
 * сравнения с порогами односторонние: `report.retractedKept > 0` на
 * отсутствующем поле даёт `undefined > 0`, то есть **ложь**, то есть
 * «порог не превышен». Доли считаются делением, и `NaN < threshold` —
 * тоже ложь. Пустой объект проходил заслон целиком.
 *
 * И это не гипотеза: в окне заслона (шестьдесят отчётов) у двадцати пяти
 * нет поля `retractedKept` вовсе — оно появилось задачей 3.56, а отчёты
 * старше её остались как были. Заслон читал их как «порог пройден» и
 * пускал включение промпта без замера — при том, что весь его смысл в
 * обратном.
 *
 * Схема строгая по составу и мягкая по лишнему: новое поле в отчёте
 * ломать заслон не должно, а пропавшее — обязано.
 */
const EVAL_REPORT_SHAPE = z.object({
  expected: z.number(),
  found: z.number(),
  missed: z.number(),
  extra: z.number(),
  typeCorrect: z.number(),
  priorityCorrect: z.number(),
  topicCorrect: z.number(),
  recurrenceCorrect: z.number(),
  projectCorrect: z.number(),
  projectChecked: z.number(),
  deadlineCorrect: z.number(),
  falseDeadlines: z.number(),
  falseTasksFromDesires: z.number(),
  falseTasksFromEmotions: z.number(),
  retractedKept: z.number(),
  crisisExpected: z.number(),
  crisisDetected: z.number(),
  crisisFalse: z.number(),
  crisisMissed: z.number(),
  failed: z.number(),
  ambiguous: z.number(),
  cases: z.number(),
  promptVersions: z.record(z.string(), z.string()),
});

const RESOLVER_REPORT_SHAPE = z.object({
  cases: z.number(),
  decisionCorrect: z.number(),
  falseApplies: z.number(),
  extraQuestions: z.number(),
  missedPatches: z.number(),
  wrongTarget: z.number(),
  wrongDeadline: z.number(),
  wrongMode: z.number(),
  rewrittenText: z.number(),
  failed: z.number(),
  promptVersion: z.string(),
});

/** Какая форма ожидается в этой папке прогонов. */
export type RunShape = 'eval' | 'resolver';

function shapeOf(kind: RunShape): z.ZodType {
  return kind === 'eval' ? EVAL_REPORT_SHAPE : RESOLVER_REPORT_SHAPE;
}

/**
 * Чего не хватает в отчёте — словами, для причины отказа.
 *
 * Пропуск обязан быть **назван**. Иначе он снова прочтётся как тишина:
 * отчёт молча выпадет из выборки, заслон скажет «не прогоняли ни разу», и
 * разбирающий пойдёт искать прогон, который на диске есть.
 */
export function missingIn(report: unknown, kind: RunShape): readonly string[] {
  const checked = shapeOf(kind).safeParse(report);

  if (checked.success) return [];

  const names = new Set<string>();

  for (const issue of checked.error.issues) {
    const name = issue.path.map(String).join('.');
    names.add(name === '' ? 'весь отчёт' : name);
  }

  return [...names].sort((one, two) => one.localeCompare(two));
}

/**
 * Прочитать **именно тот** отчёт, который зачёл заслон (ревизия этапа).
 *
 * Скрипт проверки печатал числа самого свежего отчёта и подписывал их
 * словами «порог пройден» — а заслон мог зачесть другой: на откате
 * ищется прогон **этого сочетания версий**, а не последний по времени.
 * Человек читал числа одного прогона под вердиктом о другом, и заметить
 * подмену было нечем. Имя зачтённого лежало рядом, в `verdict.runs`, и
 * не использовалось.
 *
 * Форма проверяется тем же разбором, что и при чтении истории: неполный
 * отчёт сюда не пройдёт.
 */
export async function reportByName(runs: string, name: string, kind: RunShape): Promise<unknown> {
  let report: unknown;

  try {
    report = JSON.parse(await readFile(join(runs, name), 'utf8'));
  } catch {
    return undefined;
  }

  return missingIn(report, kind).length === 0 ? report : undefined;
}

/** Самый свежий отчёт прогона. Имена файлов — время, сортировка честная. */
export async function newestRun(
  evalDir: string,
): Promise<{ readonly name: string; readonly report: EvalReport } | undefined> {
  const found = await newestIn(join(evalDir, 'runs'), 'eval');
  return found === undefined ? undefined : { name: found.name, report: found.report as EvalReport };
}

/** Самый свежий отчёт прогона резолвера. */
export async function newestResolverRun(
  evalDir: string,
): Promise<{ readonly name: string; readonly report: ResolverReport } | undefined> {
  const found = await newestIn(join(evalDir, 'resolver', 'runs'), 'resolver');

  return found === undefined
    ? undefined
    : { name: found.name, report: found.report as ResolverReport };
}

async function newestIn(
  runs: string,
  kind: RunShape,
): Promise<{ readonly name: string; readonly report: unknown } | undefined> {
  for await (const run of runsNewestFirst(runs, kind)) return run;
  return undefined;
}

/**
 * Есть ли на диске хоть один отчёт прогона — общий или резолверский.
 *
 * Этим и только этим решается, показывать ли раздел промптов. Вопрос
 * нарочно грубый: **годность** отчёта — дело `evalFreshness`, и она
 * умеет объяснить словами, чем именно он не годится («Пригодного
 * прогона нет ни одного» плюс имена пропущенных). Спроси мы здесь про
 * годность — раздел исчезал бы целиком, а человек читал бы «отчётов
 * нет» там, где они есть и неполны, и лечил бы это заливкой тех же
 * файлов.
 *
 * Обе папки, а не одна: у резолвера свой набор и свои отчёты. Сервер,
 * где есть только они, промптом резолвера управлять обязан.
 */
export async function hasAnyRun(evalDir: string): Promise<boolean> {
  for (const runs of [join(evalDir, 'runs'), join(evalDir, 'resolver', 'runs')]) {
    let files: readonly string[];

    try {
      files = await readdir(runs);
    } catch {
      continue;
    }

    if (files.some((name) => name.endsWith('.json'))) return true;
  }

  return false;
}

/**
 * Сколько отчётов вообще смотрим, вглубь от свежего.
 *
 * Прогонов за год накопятся сотни, а откатываются всегда на недавнее.
 * Читать всю историю ради версии годовой давности — лишняя работа на
 * каждом открытии страницы.
 */
const HISTORY_DEPTH = 60;

/**
 * Окно названо словами в каждом отказе, где оно могло помешать.
 *
 * Ревизия четвёртого этапа: заслон печатал «такого сочетания версий не
 * прогоняли ни разу», просмотрев только шестьдесят свежих отчётов из
 * девяноста девяти. Это утверждение как факт о том, чего он не
 * проверял, — и отличить «глубже не смотрел» от «не мерили» человеку
 * было нечем. Отказ на откате к версии годовой давности выглядел
 * поломкой набора.
 *
 * Пустая папка — случай отдельный, и «ни разу» уместно только там.
 */
const DEPTH_NOTE = `Просмотрены последние ${String(HISTORY_DEPTH)} отчётов; глубже история не читалась.`;

/**
 * Отчёты от свежего к старому. Имена файлов — время, сортировка честная.
 *
 * **Неполный отчёт выбрасывается так же, как битый.** И то и другое —
 * «такого прогона нет», а не «прогон прошёл»: все сравнения с порогами
 * односторонние, и на отсутствующем поле они ложны. Чего именно не
 * хватало, складывается в `skipped` — пропуск обязан быть назван словами,
 * иначе он прочтётся как тишина.
 */
async function* runsNewestFirst(
  runs: string,
  kind: RunShape,
  skipped?: string[],
): AsyncGenerator<{ readonly name: string; readonly report: unknown }> {
  let files: string[];
  try {
    files = (await readdir(runs)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return;
  }

  for (const name of files.slice(-HISTORY_DEPTH).reverse()) {
    let report: unknown;

    try {
      report = JSON.parse(await readFile(join(runs, name), 'utf8'));
    } catch {
      // Битый отчёт — это «такого прогона нет», а не «прогон прошёл».
      // Молчаливое «всё хорошо» здесь стоило бы регрессии на боевом.
      skipped?.push(`${name}: отчёт не читается`);
      continue;
    }

    const missing = missingIn(report, kind);

    if (missing.length > 0) {
      skipped?.push(`${name}: в отчёте нет ${missing.join(', ')}`);
      continue;
    }

    yield { name, report };
  }
}

/**
 * Сверить версии, которые собираются включить, со свежими прогонами.
 *
 * `activating` — какие версии станут активными: стадия → версия.
 * Проверяется только то, что действительно включается: набор, который
 * никого из включаемых стадий не касается, ни на что не влияет.
 */
export async function evalFreshness(params: {
  readonly evalDir: string;
  readonly activating: ReadonlyMap<string, string>;
}): Promise<FreshnessVerdict> {
  const reasons: FreshnessReason[] = [];
  const runs: string[] = [];

  const touchesMain = MEASURED_STAGES.some((stage) => params.activating.has(stage));

  if (touchesMain) {
    const problem = await checkMain(params.evalDir, params.activating, runs);
    if (problem !== undefined) reasons.push(...problem);
  }

  if (params.activating.has(RESOLVER_STAGE)) {
    const problem = await checkResolver(
      params.evalDir,
      params.activating.get(RESOLVER_STAGE) ?? '',
      runs,
    );
    if (problem !== undefined) reasons.push(...problem);
  }

  if (reasons.length > 0) return { ok: false, reasons, runs };

  const unmeasured = [...params.activating.keys()].filter(
    (stage) => stage !== RESOLVER_STAGE && !(MEASURED_STAGES as readonly string[]).includes(stage),
  );

  return { ok: true, runs, unmeasured };
}

/**
 * Общий набор: разбор. Возвращает причины отказа или ничего.
 *
 * Ищется **самый свежий прогон именно этого сочетания версий**, а не
 * просто самый свежий. Разница видна на откате: включили новую версию,
 * измерили, стало хуже — и вернуться назад по правилу «сверять только с
 * последним прогоном» стало бы нельзя, хотя прежнее сочетание мерили и
 * оно прошло. Заслон, мешающий откатиться, опаснее отсутствующего:
 * откатываются в аварию.
 *
 * Сочетание, а не отдельная версия: 28.08.2026 подвело именно оно —
 * стадии мерили порознь, а включали вместе.
 */
async function checkMain(
  evalDir: string,
  activating: ReadonlyMap<string, string>,
  runs: string[],
): Promise<readonly FreshnessReason[] | undefined> {
  let newest: { readonly name: string; readonly report: EvalReport } | undefined;

  /**
   * Отчёты, выброшенные за неполноту, — чтобы **назвать** их в причине.
   *
   * Прежде неполный отчёт проходил порог целиком: сравнения
   * односторонние, и на отсутствующем поле они ложны. Теперь он
   * выбрасывается — но молчаливый пропуск был бы своей ошибкой:
   * разбирающий прочёл бы «не прогоняли ни разу» и пошёл искать прогон,
   * который на диске есть.
   */
  const skipped: string[] = [];

  for await (const run of runsNewestFirst(join(evalDir, 'runs'), 'eval', skipped)) {
    const report = run.report as EvalReport;
    newest ??= { name: run.name, report };

    const measured = report.promptVersions;
    const fits = MEASURED_STAGES.every((stage) => {
      const now = activating.get(stage);
      return now === undefined || now === measured[stage];
    });

    if (!fits) continue;

    runs.push(run.name);

    const verdict = checkThreshold(report);

    return verdict.passed
      ? undefined
      : [`Прогон этих версий (${run.name}) не прошёл порог:`, ...verdict.failures];
  }

  if (newest === undefined) {
    return [
      skipped.length === 0
        ? 'Прогона контрольного набора нет ни одного.'
        : 'Пригодного прогона контрольного набора нет ни одного.',
      '§10.3 ТЗ: выкладка промптов только при отсутствии ухудшения.',
      ...namedSkips(skipped),
    ];
  }

  runs.push(newest.name);

  const measured = newest.report.promptVersions;
  // Стадия — отдельным полем, а не внутри строки: имя для человека даёт
  // панель, а ключ из базы на экране означает «догадайтесь сами».
  const mismatch = MEASURED_STAGES.flatMap((stage) => {
    const now = activating.get(stage);
    if (now === undefined || now === measured[stage]) return [];

    return [{ stage, text: `включается ${now}, а мерили ${measured[stage] ?? 'ничего'}` }];
  });

  return [
    `Прогона этого сочетания версий не нашлось. Свежий прогон (${newest.name}):`,
    ...mismatch,
    DEPTH_NOTE,
    ...namedSkips(skipped),
  ];
}

/**
 * Пропущенные отчёты — строками причины, а не тишиной.
 *
 * Список обрезается: неполных отчётов в истории двадцать пять, и вывалить
 * все двадцать пять в отказ значит спрятать в них настоящую причину.
 * Сколько всего — сказано числом.
 */
function namedSkips(skipped: readonly string[]): readonly string[] {
  if (skipped.length === 0) return [];

  const shown = skipped.slice(0, 3);
  const rest = skipped.length - shown.length;

  return [
    `Отчётов пропущено за неполноту: ${String(skipped.length)}.`,
    ...shown,
    ...(rest > 0 ? [`…и ещё ${String(rest)}.`] : []),
  ];
}

/** Набор резолвера: свой отчёт, свой порог, та же логика поиска. */
async function checkResolver(
  evalDir: string,
  version: string,
  runs: string[],
): Promise<readonly FreshnessReason[] | undefined> {
  let newest: { readonly name: string; readonly report: ResolverReport } | undefined;
  const skipped: string[] = [];

  for await (const run of runsNewestFirst(join(evalDir, 'resolver', 'runs'), 'resolver', skipped)) {
    const report = run.report as ResolverReport;
    newest ??= { name: run.name, report };

    if (report.promptVersion !== version) continue;

    runs.push(run.name);

    const verdict = checkResolverThreshold(report);

    return verdict.passed
      ? undefined
      : [`Прогон резолвера на этой версии (${run.name}) не прошёл порог:`, ...verdict.failures];
  }

  if (newest === undefined) {
    return [
      skipped.length === 0
        ? 'Прогона контрольного набора резолвера нет ни одного.'
        : 'Пригодного прогона контрольного набора резолвера нет ни одного.',
      '§10.3 ТЗ: выкладка промптов только при отсутствии ухудшения.',
      ...namedSkips(skipped),
    ];
  }

  runs.push(newest.name);

  return [
    `Прогона резолвера ${version} не нашлось.`,
    `Свежий прогон (${newest.name}) сделан на ${newest.report.promptVersion}.`,
    DEPTH_NOTE,
    ...namedSkips(skipped),
  ];
}
