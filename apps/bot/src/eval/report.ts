import { localDateParts } from '../modules/classifier/dates.js';
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
  /** Точность срока: совпала ли точность, а где задана — и сама дата. */
  readonly deadlineCorrect: number;
  /**
   * Сроки, которых человек не называл (задача 2.7).
   *
   * Считается отдельным числом, а не долей, по той же причине, что ложные
   * задачи: порог жёсткий. Выдуманный срок хуже отсутствующего — фильтр
   * выдачи ставит дела «на сегодня» впереди всех, и мелочь с придуманной
   * датой вытесняет важное без срока. Ровно это случилось на живой
   * выгрузке 27.08.2026.
   */
  readonly falseDeadlines: number;

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
  /**
   * Какими моделями сделан прогон.
   *
   * Без этого два прогона в истории неразличимы, а разница между ними
   * может быть не в промпте, а в модели: ветки `latest` и `rc` — это
   * разные поколения с разной ценой и разным качеством. Отчёт, по
   * которому нельзя сказать, что именно сравнивали, сравнивать нельзя.
   */
  readonly models?: Readonly<Record<string, string>> | undefined;
}

export interface Shares {
  readonly recall: number;
  readonly type: number;
  readonly priority: number;
  readonly topic: number;
  readonly recurrence: number;
  readonly deadline: number;
  /**
   * Доля лишних записей от ожидаемых (задача 3.52).
   *
   * Долей, а не числом: набор пополняется, и абсолютное число поедет при
   * каждой новой выгрузке. Историю это подтверждает — на двух выгрузках
   * лишних было 2–4, после третьей стало 10–14, и сравнивать одно с
   * другим бессмысленно.
   */
  readonly extra: number;
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
  let deadlineCorrect = 0;
  let falseDeadlines = 0;

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

      /**
       * Срок: сначала точность, потом дата.
       *
       * Дата сверяется только там, где разметка её задала: у «на 5 7
       * сентября» она однозначна, у «на следующей неделе» — нет, и
       * требовать конкретный день значило бы мерить нашу решительность.
       */
      const actualAccuracy = actual.deadline?.accuracy ?? 'none';
      const accuracyFits = unit.deadline === ANY || actualAccuracy === unit.deadline;
      const dateFits =
        unit.deadlineDate === undefined ||
        (actual.deadline !== undefined &&
          isoDateIn(actual.deadline.at, outcome.timeZone) === unit.deadlineDate);

      if (accuracyFits && dateFits) deadlineCorrect++;

      // Срок, которого человек не называл. Отдельным числом: порог ноль.
      if (unit.deadline === 'none' && actualAccuracy !== 'none') falseDeadlines++;

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
    deadlineCorrect,
    falseDeadlines,
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

/** Дата срока в поясе человека: сравнивать в UTC значило бы ошибаться на день. */
function isoDateIn(at: Date, timeZone: string): string {
  const parts = localDateParts(at, timeZone);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(parts.year)}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Доли считаются от найденного: тип у потерянной единицы не определён. */
export function shares(report: EvalReport): Shares {
  const of = (part: number): number => (report.found === 0 ? 0 : part / report.found);

  return {
    recall: report.expected === 0 ? 0 : report.found / report.expected,
    extra: report.expected === 0 ? 0 : report.extra / report.expected,
    type: of(report.typeCorrect),
    priority: of(report.priorityCorrect),
    topic: of(report.topicCorrect),
    recurrence: of(report.recurrenceCorrect),
    deadline: of(report.deadlineCorrect),
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
    ...(report.models === undefined
      ? []
      : [
          `Модели: ${Object.entries(report.models)
            .map(([kind, model]) => `${kind}=${model}`)
            .join(', ')}`,
        ]),
    '',
    `Найдено единиц:      ${percent(now.recall)}${delta(now.recall, was?.recall)}   (${String(report.found)} из ${String(report.expected)})`,
    `Потеряно:            ${String(report.missed)}${deltaCount(report.missed, previous?.missed)}`,
    `Лишних:              ${String(report.extra)}, это ${percent(now.extra)} от ожидаемых${deltaCount(report.extra, previous?.extra)}`,
    '',
    `Точность типа:       ${percent(now.type)}${delta(now.type, was?.type)}`,
    `Точность важности:   ${percent(now.priority)}${delta(now.priority, was?.priority)}`,
    `Точность темы:       ${percent(now.topic)}${delta(now.topic, was?.topic)}`,
    `Точность повторения: ${percent(now.recurrence)}${delta(now.recurrence, was?.recurrence)}`,
    `Точность срока:      ${percent(now.deadline)}${delta(now.deadline, was?.deadline)}`,
    '',
    `Ложных задач из желаний: ${String(report.falseTasksFromDesires)}${deltaCount(report.falseTasksFromDesires, previous?.falseTasksFromDesires)}`,
    `Ложных задач из эмоций:  ${String(report.falseTasksFromEmotions)}${deltaCount(report.falseTasksFromEmotions, previous?.falseTasksFromEmotions)}`,
    `Выдуманных сроков:       ${String(report.falseDeadlines)}${deltaCount(report.falseDeadlines, previous?.falseDeadlines)}`,
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
  /**
   * Сколько выдуманных сроков допустимо (задача 2.7).
   *
   * Ноль, как и у ложных задач, и по той же логике: фильтр выдачи ставит
   * дела «на сегодня» впереди всех, поэтому одна придуманная дата
   * вытесняет из выдачи важное дело без срока. Человек видит мелочь и
   * решает, что бот не понял главного.
   */
  readonly falseDeadlines: number;
  /**
   * Какую долю ожидаемых единиц обязан находить разбор.
   *
   * **Порога на это не было, и он пропустил настоящую регрессию.**
   * 28.08.2026 промпт `router@4` терял три единицы из сорока трёх, а
   * отчёт печатал «порог качества пройден»: точность-то считается **от
   * найденного**, и потеря трудной единицы её даже поднимает. Проверка
   * зеленела, теряя мысли человека.
   *
   * Число 0,95 взято из наблюдённого разброса, а не выдумано: за 23
   * прогона на `router@2` находилось от 41 до 43 единиц из 43, то есть
   * не ниже 95,3%. Сорок — это 93%, и такого не было ни разу.
   */
  readonly found: number;
  /**
   * Сколько лишних записей допустимо, долей от ожидаемых (задача 3.52).
   *
   * **Порога на это не было, и он был нужен.** Разбор дробит одно дело на
   * несколько: «сегодня надо сходить в магазин, купить продукты — молоко,
   * хлеб, яйца, сыр и воду» превращается то в одну запись, то в семь. Для
   * человека это второй список из двадцати пунктов — ровно то, чего §13.2
   * велит не делать: «бот не вываливает список».
   *
   * Отчёт лишние записи печатал, но страж на них не смотрел, поэтому
   * дробление годами оставалось «известной мелочью». Мерить его начали
   * тогда же, когда взялись править: сперва число, потом промпт.
   *
   * Число 0,25 взято из наблюдённого разброса, а не выдумано: за двадцать
   * чистых прогонов на нынешнем наборе лишних было от 10 до 14 из 58, то
   * есть от 17,2% до 24,1%. Порог стоит чуть выше худшего — он ловит
   * ухудшение, а не сегодняшний шум. По мере правки его надо опускать.
   */
  readonly extra: number;
}

export const STAGE2_THRESHOLD: Threshold = {
  type: 0.85,
  falseTasks: 0,
  falseDeadlines: 0,
  found: 0.95,
  extra: 0.25,
};

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

  // Первым делом — сколько нашли. Проценты без этой строки не значат
  // ничего: они считаются от найденного.
  if (now.recall < threshold.found) {
    failures.push(
      `найдено единиц ${percent(now.recall)} ниже порога ${percent(threshold.found)}` +
        ` (${String(report.found)} из ${String(report.expected)})`,
    );
  }

  if (now.extra > threshold.extra) {
    failures.push(
      `лишних записей ${percent(now.extra)} выше порога ${percent(threshold.extra)}` +
        ` (${String(report.extra)} при ожидаемых ${String(report.expected)})`,
    );
  }

  if (now.type < threshold.type) {
    failures.push(`точность типа ${percent(now.type)} ниже порога ${percent(threshold.type)}`);
  }

  if (report.falseTasksFromDesires > threshold.falseTasks) {
    failures.push(`ложных задач из желаний: ${String(report.falseTasksFromDesires)}`);
  }

  if (report.falseTasksFromEmotions > threshold.falseTasks) {
    failures.push(`ложных задач из эмоций: ${String(report.falseTasksFromEmotions)}`);
  }

  if (report.falseDeadlines > threshold.falseDeadlines) {
    failures.push(`выдуманных сроков: ${String(report.falseDeadlines)}`);
  }

  if (report.failed > 0) {
    failures.push(`разбор не удался в ${String(report.failed)} случаях`);
  }

  return { passed: failures.length === 0, failures };
}
