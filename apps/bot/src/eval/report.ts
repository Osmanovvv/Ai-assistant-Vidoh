import type { CaseOutcome } from './runner.js';

/**
 * Пометка «разметка не решает».
 *
 * Ставится там, где правильный ответ спорен и его нет даже у человека:
 * «конспектировать марафон» — это работа или личное? Считать такие случаи
 * промахами значило бы мерить не качество разбора, а смелость разметки, а
 * заодно навсегда закрыть путь к порогу 85%.
 */
export const ANY = '*';

/**
 * Отчёт прогона контрольного набора (задача 2.19).
 *
 * §21 п.10 говорит о доле верной классификации, задача 2.20 задаёт порог:
 * точность типа не ниже 85%, ноль ложных задач из желаний и эмоций.
 * Поэтому в отчёте не одно число, а те, по которым порог и проверяется.
 *
 * **Потерянные единицы считаются отдельно от неверных.** Дело, которое
 * разбор не увидел, человек не увидит нигде — это хуже, чем дело с
 * неверной темой. Одна общая «точность» такую разницу скрыла бы.
 */

export interface EvalReport {
  /** Сколько ожидалось единиц по всему набору. */
  readonly expected: number;
  /** Сколько найдено. */
  readonly found: number;
  /** Сколько потеряно. */
  readonly missed: number;
  /** Сколько лишних: разбор придумал или раздробил. */
  readonly extra: number;

  readonly typeCorrect: number;
  readonly priorityCorrect: number;
  readonly topicCorrect: number;
  readonly recurrenceCorrect: number;

  /**
   * §6.2: правило, которое модели нарушают чаще всего. Порог по нему
   * жёсткий — ноль, поэтому и считается отдельным числом, а не долей.
   */
  readonly falseTasksFromDesires: number;
  readonly falseTasksFromEmotions: number;

  readonly crisisExpected: number;
  readonly crisisDetected: number;
  /** Сработал там, где не ждали. Ложное срабатывание — тоже промах. */
  readonly crisisFalse: number;
  readonly crisisMissed: number;

  /** Случаи, где разбор не удался целиком. */
  readonly failed: number;
  /** Ожидания, поймавшие несколько записей: разметку надо править. */
  readonly ambiguous: number;

  readonly cases: number;
  readonly promptVersions: Readonly<Record<string, string>>;
}

export interface Shares {
  readonly recall: number;
  readonly type: number;
  readonly priority: number;
  readonly topic: number;
  readonly recurrence: number;
}

export function collect(outcomes: readonly CaseOutcome[]): EvalReport {
  let expected = 0;
  let found = 0;
  let missed = 0;
  let extra = 0;
  let typeCorrect = 0;
  let priorityCorrect = 0;
  let topicCorrect = 0;
  let recurrenceCorrect = 0;
  let falseTasksFromDesires = 0;
  let falseTasksFromEmotions = 0;
  let crisisExpected = 0;
  let crisisDetected = 0;
  let crisisFalse = 0;
  let crisisMissed = 0;
  let failed = 0;
  let ambiguous = 0;

  const versions: Record<string, string> = {};

  for (const outcome of outcomes) {
    expected += outcome.result.matched.length + outcome.result.missed.length;
    found += outcome.result.matched.length;
    missed += outcome.result.missed.length;
    extra += outcome.result.extra.length;
    ambiguous += outcome.result.ambiguous.length;
    if (outcome.failed !== undefined) failed++;

    if (outcome.crisis.expected) crisisExpected++;
    if (outcome.crisis.detected) crisisDetected++;
    if (outcome.crisis.detected && !outcome.crisis.expected) crisisFalse++;
    if (!outcome.crisis.detected && outcome.crisis.expected) crisisMissed++;

    for (const [stage, version] of Object.entries(outcome.promptVersions)) {
      if (version !== undefined) versions[stage] = version;
    }

    for (const { expected: unit, actual } of outcome.result.matched) {
      if (actual.type === unit.type) typeCorrect++;
      // Звёздочка означает «разметка не решает»: у «замариновать мясо»
      // важность спорна, и штрафовать за неё значило бы мерить не
      // качество разбора, а нашу решительность при разметке.
      if (unit.priority === ANY || actual.priority === unit.priority) priorityCorrect++;
      if (unit.topic === ANY || actual.topic === unit.topic) topicCorrect++;

      const actualRecurrence = actual.recurrence?.rule?.kind ?? 'none';
      // Фраза без правила — это `unclear`: регулярность названа, но
      // выражена не набором.
      const asKind =
        actual.recurrence?.text !== undefined && actual.recurrence.rule === undefined
          ? 'unclear'
          : actualRecurrence;
      if (asKind === unit.recurrence) recurrenceCorrect++;

      // §6.2, главное правило: желание и эмоция не становятся задачей.
      if (unit.type === 'DESIRE' && actual.type === 'TASK') falseTasksFromDesires++;
      if (unit.type === 'EMOTION' && actual.type === 'TASK') falseTasksFromEmotions++;
    }
  }

  return {
    expected,
    found,
    missed,
    extra,
    typeCorrect,
    priorityCorrect,
    topicCorrect,
    recurrenceCorrect,
    falseTasksFromDesires,
    falseTasksFromEmotions,
    crisisExpected,
    crisisDetected,
    crisisFalse,
    crisisMissed,
    failed,
    ambiguous,
    cases: outcomes.length,
    promptVersions: versions,
  };
}

/** Доли считаются от найденного: тип у потерянной единицы не определён. */
export function shares(report: EvalReport): Shares {
  const of = (part: number): number => (report.found === 0 ? 0 : part / report.found);

  return {
    recall: report.expected === 0 ? 0 : report.found / report.expected,
    type: of(report.typeCorrect),
    priority: of(report.priorityCorrect),
    topic: of(report.topicCorrect),
    recurrence: of(report.recurrenceCorrect),
  };
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** Читаемый отчёт для человека. Печатается прямо в вывод скрипта. */
export function format(report: EvalReport, previous?: EvalReport): string {
  const now = shares(report);
  const was = previous ? shares(previous) : undefined;

  const delta = (current: number, before: number | undefined): string => {
    if (before === undefined) return '';
    const difference = current - before;
    if (Math.abs(difference) < 0.0005) return '  (без изменений)';
    return `  (${difference > 0 ? '+' : ''}${(difference * 100).toFixed(1)} п.п.)`;
  };

  const deltaCount = (current: number, before: number | undefined): string => {
    if (before === undefined) return '';
    const difference = current - before;
    if (difference === 0) return '  (без изменений)';
    return `  (${difference > 0 ? '+' : ''}${String(difference)})`;
  };

  const lines = [
    `Случаев: ${String(report.cases)}, единиц ожидалось: ${String(report.expected)}`,
    `Версии промптов: ${Object.entries(report.promptVersions)
      .map(([stage, version]) => `${stage}=${version}`)
      .join(', ')}`,
    '',
    `Найдено единиц:      ${percent(now.recall)}${delta(now.recall, was?.recall)}   (${String(report.found)} из ${String(report.expected)})`,
    `Потеряно:            ${String(report.missed)}${deltaCount(report.missed, previous?.missed)}`,
    `Лишних:              ${String(report.extra)}${deltaCount(report.extra, previous?.extra)}`,
    '',
    `Точность типа:       ${percent(now.type)}${delta(now.type, was?.type)}`,
    `Точность важности:   ${percent(now.priority)}${delta(now.priority, was?.priority)}`,
    `Точность темы:       ${percent(now.topic)}${delta(now.topic, was?.topic)}`,
    `Точность повторения: ${percent(now.recurrence)}${delta(now.recurrence, was?.recurrence)}`,
    '',
    `Ложных задач из желаний: ${String(report.falseTasksFromDesires)}${deltaCount(report.falseTasksFromDesires, previous?.falseTasksFromDesires)}`,
    `Ложных задач из эмоций:  ${String(report.falseTasksFromEmotions)}${deltaCount(report.falseTasksFromEmotions, previous?.falseTasksFromEmotions)}`,
    '',
    `Кризис: ожидался ${String(report.crisisExpected)}, сработал ${String(report.crisisDetected)}, ложных ${String(report.crisisFalse)}, пропущено ${String(report.crisisMissed)}`,
    `Разбор не удался: ${String(report.failed)}`,
  ];

  if (report.ambiguous > 0) {
    lines.push(
      '',
      `ВНИМАНИЕ: ${String(report.ambiguous)} ожиданий поймали больше одной записи — разметку надо уточнить`,
    );
  }

  return lines.join('\n');
}

/**
 * Пройден ли порог качества (задача 2.20).
 *
 * Числа взяты из §21 п.10 и из задачи 2.20: точность типа не ниже 85%,
 * ноль ложных задач из желаний и эмоций. Порог живёт в коде, а не в
 * голове: «вроде стало лучше» — не критерий приёмки.
 */
export interface Threshold {
  readonly type: number;
  readonly falseTasks: number;
}

export const STAGE2_THRESHOLD: Threshold = { type: 0.85, falseTasks: 0 };

export interface ThresholdVerdict {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export function checkThreshold(
  report: EvalReport,
  threshold: Threshold = STAGE2_THRESHOLD,
): ThresholdVerdict {
  const now = shares(report);
  const failures: string[] = [];

  if (now.type < threshold.type) {
    failures.push(`точность типа ${percent(now.type)} ниже порога ${percent(threshold.type)}`);
  }

  if (report.falseTasksFromDesires > threshold.falseTasks) {
    failures.push(`ложных задач из желаний: ${String(report.falseTasksFromDesires)}`);
  }

  if (report.falseTasksFromEmotions > threshold.falseTasks) {
    failures.push(`ложных задач из эмоций: ${String(report.falseTasksFromEmotions)}`);
  }

  if (report.failed > 0) {
    failures.push(`разбор не удался в ${String(report.failed)} случаях`);
  }

  return { passed: failures.length === 0, failures };
}
