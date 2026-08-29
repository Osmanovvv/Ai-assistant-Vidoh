import type { DecisionKind } from '../modules/resolver/decision.js';

/**
 * Отчёт по контрольному набору резолвера (§10.3 ТЗ).
 *
 * **Ошибки здесь стоят разного, и мерить их одним числом нельзя.** §7.3
 * говорит прямо: «ошибочный вопрос стоит пользователю одного тапа,
 * ошибочное изменение стоит доверия». Поэтому доля верных решений — не
 * главная цифра отчёта, а вторая.
 *
 * Главная — **ложные применения**: случаи, где надо было спросить или
 * завести новое, а бот молча поправил запись человека. Одно такое на
 * приёмке дороже десяти лишних вопросов.
 */

export interface ResolverCaseOutcome {
  readonly id: string;
  readonly expected: DecisionKind;
  readonly actual: DecisionKind;
  /** Совпала ли выбранная запись. Для `create` не проверяется. */
  readonly targetOk: boolean;
  /** Совпал ли срок, если случай его задавал. */
  readonly deadlineOk: boolean;
  /** Совпал ли режим §7.4, если случай его задавал. */
  readonly modeOk: boolean;
  /** Уверенность, как её назвала модель. Для разбора расхождений. */
  readonly confidence: number | undefined;
  readonly failed: boolean;
}

export interface ResolverReport {
  readonly cases: number;
  /** Решение совпало с размеченным. */
  readonly decisionCorrect: number;
  /**
   * Применил там, где ждали вопроса или новой записи.
   *
   * Самая дорогая ошибка набора: бот поменял запись человека, не спросив
   * и не имея на то оснований.
   */
  readonly falseApplies: number;
  /**
   * Спросил там, где ждали применения.
   *
   * Не ошибка в строгом смысле — §7.3 велит спрашивать чаще, чем
   * угадывать, — но если таких много, обещание «бот помнит» не звучит.
   */
  readonly extraQuestions: number;
  /** Завёл новую запись там, где надо было поправить существующую. */
  readonly missedPatches: number;
  /** Решение верное, а запись выбрана не та. */
  readonly wrongTarget: number;
  readonly wrongDeadline: number;
  /**
   * Подробность записана заменой или замена дополнением (§7.4).
   *
   * Первое переписывает заголовок дела человека — по цене это ложное
   * применение, только заметить его труднее: решение выглядит верным.
   */
  readonly wrongMode: number;
  /** Модель не ответила или ответила не по схеме. */
  readonly failed: number;
  readonly promptVersion: string;
}

export function collectResolver(
  outcomes: readonly ResolverCaseOutcome[],
  promptVersion: string,
): ResolverReport {
  const count = (predicate: (outcome: ResolverCaseOutcome) => boolean): number =>
    outcomes.filter(predicate).length;

  return {
    cases: outcomes.length,
    decisionCorrect: count((outcome) => outcome.expected === outcome.actual),
    falseApplies: count((outcome) => outcome.actual === 'apply' && outcome.expected !== 'apply'),
    extraQuestions: count((outcome) => outcome.actual === 'ask' && outcome.expected === 'apply'),
    missedPatches: count((outcome) => outcome.actual === 'create' && outcome.expected !== 'create'),
    wrongTarget: count((outcome) => outcome.expected === outcome.actual && !outcome.targetOk),
    wrongDeadline: count((outcome) => !outcome.deadlineOk),
    wrongMode: count((outcome) => !outcome.modeOk),
    failed: count((outcome) => outcome.failed),
    promptVersion,
  };
}

export interface ResolverThresholdSpec {
  /** Доля верных решений. */
  readonly decisions: number;
  readonly falseApplies: number;
  readonly wrongTarget: number;
  readonly wrongMode: number;
  readonly failed: number;
}

/**
 * Порог.
 *
 * **Ложных применений — ноль, и это не перестраховка.** §7.3 объявляет
 * цену прямо: ошибочное изменение стоит доверия. Порог, допускающий
 * одно такое на двадцать случаев, разрешает боту раз в неделю молча
 * поправить не ту запись.
 *
 * Доля решений 0,85 — с запасом к замеру. Три прогона 29.08.2026 на
 * `resolver@1` дали 16 из 16 каждый: ни одного ложного применения, ни
 * одной не той записи. Разброса пока не видно вовсе, но три наблюдения —
 * это не разброс, а три наблюдения. Запас в две ошибки из шестнадцати
 * оставлен на то, чего мы ещё не видели; сужать его можно будет, когда
 * прогонов наберётся десяток.
 */
export const RESOLVER_THRESHOLD: ResolverThresholdSpec = {
  decisions: 0.85,
  falseApplies: 0,
  wrongTarget: 0,
  wrongMode: 0,
  failed: 0,
};

export interface ResolverVerdict {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export function checkResolverThreshold(
  report: ResolverReport,
  spec: ResolverThresholdSpec = RESOLVER_THRESHOLD,
): ResolverVerdict {
  const failures: string[] = [];

  if (report.falseApplies > spec.falseApplies) {
    failures.push(
      `ложных применений ${String(report.falseApplies)} при пороге ${String(spec.falseApplies)} — бот поправил запись, не имея на то оснований`,
    );
  }

  if (report.wrongTarget > spec.wrongTarget) {
    failures.push(`не та запись выбрана в ${String(report.wrongTarget)} случаях`);
  }

  if (report.wrongMode > spec.wrongMode) {
    failures.push(
      `перепутано дополнение и замена в ${String(report.wrongMode)} случаях — при замене переписывается заголовок дела`,
    );
  }

  if (report.failed > spec.failed) {
    failures.push(`модель не ответила в ${String(report.failed)} случаях`);
  }

  const share = report.cases === 0 ? 0 : report.decisionCorrect / report.cases;

  if (share < spec.decisions) {
    failures.push(
      `верных решений ${(share * 100).toFixed(1)}% при пороге ${(spec.decisions * 100).toFixed(0)}%`,
    );
  }

  return { passed: failures.length === 0, failures };
}

export function formatResolver(report: ResolverReport): string {
  const share = report.cases === 0 ? 0 : (report.decisionCorrect / report.cases) * 100;

  return [
    '',
    `Резолвер, ${String(report.cases)} случаев, промпт ${report.promptVersion}`,
    '',
    `  верных решений:        ${String(report.decisionCorrect)} из ${String(report.cases)} (${share.toFixed(1)}%)`,
    `  ложных применений:     ${String(report.falseApplies)}   ← самая дорогая ошибка`,
    `  лишних вопросов:       ${String(report.extraQuestions)}`,
    `  пропущенных правок:    ${String(report.missedPatches)}`,
    `  не та запись:          ${String(report.wrongTarget)}`,
    `  не тот срок:           ${String(report.wrongDeadline)}`,
    `  замена вместо допол.:  ${String(report.wrongMode)}`,
    `  модель не ответила:    ${String(report.failed)}`,
    '',
  ].join('\n');
}
