import { describe, expect, it } from 'vitest';

import {
  BadBudgetError,
  estimateLine,
  isLiveRun,
  latestReportName,
  parseBudget,
  recordingEnvFor,
  refusalWithoutBudget,
  reportNames,
} from './budget.js';

/**
 * Потолок прогона и запись ответов (20.09.2026).
 *
 * **Что случилось.** Замер живого набора обещался в «≈20–25 ₽», а стоил
 * 73 ₽ за прогон; три прогона подряд — 219 ₽, и ни один не записал
 * ответов модели, так что повторить их бесплатно нельзя. Оценка была
 * из головы, а не из журнала, и остановить прогон было нечем, кроме
 * руки. Оба свойства переносятся в код: живой прогон без названной
 * суммы не запускается, а запись ответов ведётся всегда.
 */

describe('флаг --budget', () => {
  it('без флага — суммы нет, пути на месте', () => {
    const { budgetRub, rest } = parseBudget(['../../docs/eval-live']);

    expect(budgetRub).toBeUndefined();
    expect(rest).toEqual(['../../docs/eval-live']);
  });

  it('понимает «--budget 40» и «--budget=40», не съедая путь', () => {
    expect(parseBudget(['--budget', '40', '../../docs/eval-live'])).toEqual({
      budgetRub: 40,
      rest: ['../../docs/eval-live'],
    });
    expect(parseBudget(['../../docs/eval-live', '--budget=12.5'])).toEqual({
      budgetRub: 12.5,
      rest: ['../../docs/eval-live'],
    });
  });

  it('не число, ноль и минус — отказ, а не «без потолка»', () => {
    // Опечатка в сумме не должна превращаться в прогон без ограничения:
    // это ровно тот случай, ради которого флаг и заведён.
    expect(() => parseBudget(['--budget', 'сорок'])).toThrow(BadBudgetError);
    expect(() => parseBudget(['--budget=0'])).toThrow(BadBudgetError);
    expect(() => parseBudget(['--budget', '-5'])).toThrow(BadBudgetError);
    expect(() => parseBudget(['--budget'])).toThrow(BadBudgetError);
  });
});

describe('живой ли прогон', () => {
  it('yandex и запись на кассету — платные', () => {
    expect(isLiveRun({ AI_PROVIDER: 'yandex', CASSETTE_MODE: 'replay' })).toBe(true);
    expect(isLiveRun({ AI_PROVIDER: 'cassette', CASSETTE_MODE: 'record' })).toBe(true);
  });

  it('подмена и воспроизведение — бесплатные', () => {
    expect(isLiveRun({ AI_PROVIDER: 'mock', CASSETTE_MODE: 'replay' })).toBe(false);
    expect(isLiveRun({ AI_PROVIDER: 'cassette', CASSETTE_MODE: 'replay' })).toBe(false);
  });
});

describe('запись ответов у живого прогона', () => {
  const live = {
    AI_PROVIDER: 'yandex' as const,
    CASSETTE_MODE: 'replay' as const,
    CASSETTE_PATH: undefined,
  };

  it('живой прогон превращается в запись по названному пути', () => {
    // Три прогона 20.09.2026 по 73 ₽ не оставили ни одной записи — каждый
    // следующий замер той же правки кода снова стоил бы денег.
    expect(recordingEnvFor(live, 'runs/2026.cassette.json')).toEqual({
      AI_PROVIDER: 'cassette',
      CASSETTE_MODE: 'record',
      CASSETTE_PATH: 'runs/2026.cassette.json',
    });
  });

  it('воспроизведение и подмена остаются как есть', () => {
    const replay = {
      AI_PROVIDER: 'cassette' as const,
      CASSETTE_MODE: 'replay' as const,
      CASSETTE_PATH: 'old.json',
    };
    expect(recordingEnvFor(replay, 'runs/new.json')).toBe(replay);

    const mock = { ...live, AI_PROVIDER: 'mock' as const };
    expect(recordingEnvFor(mock, 'runs/new.json')).toBe(mock);
  });
});

describe('оценка перед прогоном — из журнала, не из головы', () => {
  it('называет цену прошлого прогона и цену на случай', () => {
    expect(estimateLine({ cases: 15, cost: { runMicros: 73_040_000, calls: 43 } }, 15)).toBe(
      'Прошлый прогон: 73.04 ₽ за 15 случаев (4.87 ₽ на случай). Этот, 15 случаев: около 73.04 ₽.',
    );
  });

  it('без прошлого прогона так и говорит', () => {
    expect(estimateLine(undefined, 15)).toBe(
      'Прошлого прогона с ценой нет — оценить не по чему. Первый живой прогон — с малым потолком.',
    );
  });

  it('прошлый прогон без цены — как отсутствующий', () => {
    expect(estimateLine({ cases: 15 }, 15)).toContain('оценить не по чему');
  });
});

describe('отказ без потолка', () => {
  it('говорит, как запустить, и сколько стоил прошлый', () => {
    const text = refusalWithoutBudget(
      { cases: 15, cost: { runMicros: 73_040_000, calls: 43 } },
      15,
    );

    expect(text).toContain('--budget');
    expect(text).toContain('73.04 ₽');
  });
});

describe('прошлый отчёт среди файлов прогона', () => {
  it('берёт последний отчёт, а не след и не запись ответов', () => {
    /**
     * Рядом с отчётом лежат `<штамп>.trace.json` и `<штамп>.cassette.json`,
     * и по алфавиту они идут **после** отчёта того же прогона. «Последний
     * .json» оказывался следом — массивом, — и разница с прошлым
     * прогоном считалась от него.
     */
    expect(
      latestReportName([
        '2026-09-17T00-32-51-001Z.json',
        '2026-09-17T00-32-51-001Z.trace.json',
        '2026-09-20T14-17-55-397Z.json',
        '2026-09-20T14-17-55-397Z.trace.json',
        '2026-09-20T14-17-55-397Z.cassette.json',
      ]),
    ).toBe('2026-09-20T14-17-55-397Z.json');
  });

  it('без отчётов — ничего', () => {
    expect(latestReportName(['2026-09-20T14-17-55-397Z.trace.json'])).toBeUndefined();
    expect(latestReportName([])).toBeUndefined();
  });

  it('список отчётов — от старого к новому, без следов и записей', () => {
    expect(
      reportNames([
        '2026-09-20T14-17-55-397Z.trace.json',
        '2026-09-20T14-17-55-397Z.json',
        '2026-09-17T00-32-51-001Z.json',
        '2026-09-20T14-17-55-397Z.cassette.json',
      ]),
    ).toEqual(['2026-09-17T00-32-51-001Z.json', '2026-09-20T14-17-55-397Z.json']);
  });
});
