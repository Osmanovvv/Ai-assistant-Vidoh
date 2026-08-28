import { describe, expect, it } from 'vitest';

import { checkThreshold, STAGE2_THRESHOLD, type EvalReport } from './report.js';

/**
 * Порог качества (§10.3, §21 п.10).
 *
 * **Порог однажды пропустил настоящую регрессию, и это его главный урок.**
 * 28.08.2026 промпт `router@4` терял три единицы из сорока трёх, а отчёт
 * печатал «порог качества пройден». Причина в устройстве метрик: точность
 * считается **от найденного**, поэтому потеря трудной единицы её даже
 * поднимает — вместе с потерянным случаем уменьшается знаменатель.
 *
 * Проверка зеленела, теряя мысли человека. Здесь она обязана краснеть.
 */

/** Отчёт с числами живого прогона; поля, не нужные проверке, нулевые. */
function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    expected: 43,
    found: 43,
    missed: 0,
    extra: 0,
    typeCorrect: 41,
    priorityCorrect: 43,
    topicCorrect: 43,
    recurrenceCorrect: 43,
    deadlineCorrect: 42,
    falseDeadlines: 0,
    falseTasksFromDesires: 0,
    falseTasksFromEmotions: 0,
    crisisExpected: 0,
    crisisDetected: 0,
    crisisFalse: 0,
    crisisMissed: 0,
    failed: 0,
    ambiguous: 0,
    cases: 3,
    ...overrides,
  } as EvalReport;
}

describe('порог ловит потерю единиц', () => {
  it('прогон router@2: сорок три из сорока трёх — проходит', () => {
    expect(checkThreshold(report()).passed).toBe(true);
  });

  it('прогон router@4: сорок из сорока трёх — не проходит', () => {
    // Настоящие числа того прогона: 40 найдено, 39 верных по типу. Точность
    // типа при этом «выросла» до 97,5% — ровно потому, что потерялись самые
    // трудные случаи.
    const verdict = checkThreshold(report({ found: 40, missed: 3, typeCorrect: 39 }));

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(' ')).toContain('найдено единиц');
  });

  it('сорок один из сорока трёх — проходит: это наблюдённый разброс', () => {
    // За 23 прогона на router@2 находилось от 41 до 43. Порог обязан
    // отличать разброс от регрессии, иначе он станет шумом и его отключат.
    expect(checkThreshold(report({ found: 41, missed: 2, typeCorrect: 39 })).passed).toBe(true);
  });

  it('порог на долю найденного вообще задан', () => {
    // Без этого поля проверка вернулась бы к тому состоянию, в котором
    // пропустила регрессию.
    expect(STAGE2_THRESHOLD.found).toBeGreaterThan(0.9);
  });

  it('ложные задачи и выдуманные сроки по-прежнему ловятся', () => {
    expect(checkThreshold(report({ falseTasksFromDesires: 1 })).passed).toBe(false);
    expect(checkThreshold(report({ falseDeadlines: 1 })).passed).toBe(false);
  });
});
