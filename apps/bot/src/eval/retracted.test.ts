import { describe, expect, it } from 'vitest';

import type { ClassifiedItem } from '../modules/classifier/classifier.service.js';
import type { ExpectedUnit, RetractedPlan } from './dataset.js';
import { match } from './matcher.js';
import { checkThreshold, collect, STAGE2_THRESHOLD, type EvalReport } from './report.js';
import type { CaseOutcome } from './runner.js';

/**
 * Отменённое человеком (задача 3.56).
 *
 * **Поймано живым прогоном 04.09.2026, а не набором.** Проджект сказал:
 * «Ещё в четверг хотел заехать я на мойку. Хотя нет, давай мойку лучше в
 * пятницу». Бот завёл «Заехать на мойку в четверг» — дело, от которого
 * человек отказался вслух через полсекунды.
 *
 * Набор этого не поймал и поймать не мог: в нём лежала расшифровка от
 * 02.09.2026, короче боевой на 546 знаков, и самопоправки в ней не было
 * вовсе. Три зелёных прогона `extractor@6` мерили не тот текст.
 *
 * **Почему отдельным числом, а не через долю лишних.** У лишних порог
 * 25%: там же считается законное дробление, и одна лишняя запись порог не
 * валит. Отменённое — не шум дробления, а прямое противоречие сказанному.
 */

function unit(keywords: readonly string[], overrides: Partial<ExpectedUnit> = {}): ExpectedUnit {
  return {
    keywords: [...keywords],
    type: 'TASK',
    priority: '*',
    topic: '*',
    recurrence: 'none',
    isProject: '*' as const,
    deadline: 'none',
    optional: false,
    why: '',
    ...overrides,
  };
}

function item(text: string): ClassifiedItem {
  return {
    text,
    type: 'TASK',
    priority: 'SOON',
    topic: 'личное',
    isProject: false,
  };
}

const carWash: RetractedPlan = {
  keywords: ['мойк'],
  why: '«Хотя нет, давай мойку лучше в пятницу»',
};

describe('отменённое человеком', () => {
  it('добавочная запись с отменённым замыслом — нарушение', () => {
    const result = match(
      [unit(['машин'])],
      [item('Помыть машину в пятницу'), item('Заехать на мойку в четверг')],
      [carWash],
    );

    expect(result.matched).toHaveLength(1);
    expect(result.retracted).toHaveLength(1);
    expect(result.retracted[0]?.text).toContain('мойку');
  });

  it('разбор услышал поправку — нарушений нет', () => {
    const result = match([unit(['машин'])], [item('Помыть машину в пятницу')], [carWash]);

    expect(result.matched).toHaveLength(1);
    expect(result.retracted).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('законная запись со словом «мойка» нарушением не считается', () => {
    /**
     * Проверка идёт только по незанятым записям. «Помыть машину на мойке
     * в пятницу» — верное дело: разметка его ждала, и слово «мойка» в нём
     * законно. Иначе счётчик с порогом ноль краснел бы на пересказе.
     */
    const result = match([unit(['машин'])], [item('Помыть машину на мойке в пятницу')], [carWash]);

    expect(result.matched).toHaveLength(1);
    expect(result.retracted).toEqual([]);
  });

  it('без списка отменённого счётчик молчит', () => {
    const result = match([unit(['машин'])], [item('Заехать на мойку в четверг')]);

    expect(result.retracted).toEqual([]);
  });

  it('отменённое считается и в лишних тоже', () => {
    // Запись действительно лишняя. Отдельное число нужно из-за порога, а
    // не потому, что она перестаёт быть лишней.
    const result = match([], [item('Заехать на мойку в четверг')], [carWash]);

    expect(result.extra).toHaveLength(1);
    expect(result.retracted).toHaveLength(1);
  });
});

function outcome(result: CaseOutcome['result']): CaseOutcome {
  return {
    id: 'случай',
    note: '',
    timeZone: 'Europe/Moscow',
    result,
    crisis: { detected: false, expected: false },
    promptVersions: {},
  };
}

describe('отчёт и порог', () => {
  it('отчёт считает отменённое отдельным числом', () => {
    const result = match(
      [unit(['машин'])],
      [item('Помыть машину в пятницу'), item('Заехать на мойку в четверг')],
      [carWash],
    );

    const report = collect([outcome(result)]);

    expect(report.retractedKept).toBe(1);
    expect(report.extra).toBe(1);
  });

  it('порог по отменённому — ноль', () => {
    expect(STAGE2_THRESHOLD.retractedKept).toBe(0);
  });

  it('одно отменённое валит порог, хотя доля лишних его проходит', () => {
    /**
     * Главное здесь. Одна лишняя запись при пятидесяти восьми ожидаемых —
     * это 1,7%, порог лишних 25%, и он проходит. Именно так дефект и
     * прожил бы дальше, если бы считался только долей.
     */
    const base: EvalReport = {
      expected: 58,
      found: 58,
      missed: 0,
      extra: 1,
      typeCorrect: 58,
      priorityCorrect: 58,
      topicCorrect: 58,
      recurrenceCorrect: 58,
      // Проекты в этом случае не размечены: доля не считается.
      projectCorrect: 0,
      projectChecked: 0,
      deadlineCorrect: 58,
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
      cases: 3,
      promptVersions: {},
    };

    expect(checkThreshold(base).passed).toBe(true);
    expect(checkThreshold({ ...base, retractedKept: 1 }).passed).toBe(false);
    expect(checkThreshold({ ...base, retractedKept: 1 }).failures.join(' ')).toContain(
      'отменённого человеком',
    );
  });
});
