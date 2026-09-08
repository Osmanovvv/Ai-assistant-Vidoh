import { describe, expect, it } from 'vitest';

import {
  checkResolverThreshold,
  collectResolver,
  RESOLVER_THRESHOLD,
  type ResolverCaseOutcome,
  type ResolverReport,
} from './resolver-report.js';

/**
 * Порог контрольного набора резолвера (§10.3 ТЗ).
 *
 * Порог второго этапа однажды печатал «пройден», теряя три мысли
 * человека: точность считалась от найденного, и потеря трудного случая
 * её поднимала. Здесь та же ловушка расставлена иначе, и проверять надо
 * её же — **зеленеет ли порог там, где продукт вредит человеку**.
 */

function outcome(overrides: Partial<ResolverCaseOutcome> = {}): ResolverCaseOutcome {
  return {
    id: 'case',
    expected: 'apply',
    actual: 'apply',
    targetOk: true,
    deadlineOk: true,
    modeOk: true,
    textOk: true,
    confidence: 0.9,
    failed: false,
    ...overrides,
  };
}

/** Пятнадцать верных случаев и один, заданный вызывающим. */
function runWith(one: Partial<ResolverCaseOutcome>): ReturnType<typeof collectResolver> {
  const outcomes = [...Array.from({ length: 15 }, () => outcome()), outcome(one)];
  return collectResolver(outcomes, 'resolver@1');
}

describe('самая дорогая ошибка не проходит ни при какой доле верных', () => {
  it('одно ложное применение валит порог', () => {
    // §7.3: «ошибочное изменение стоит доверия». Пятнадцать верных
    // решений его не выкупают.
    const verdict = checkResolverThreshold(runWith({ expected: 'ask', actual: 'apply' }));

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(' ')).toContain('ложных применений');
  });

  it('применение вместо создания — тоже ложное', () => {
    expect(checkResolverThreshold(runWith({ expected: 'create', actual: 'apply' })).passed).toBe(
      false,
    );
  });

  it('верное решение о не той записи не проходит', () => {
    // Спросить про чужое дело — почти то же, что поправить чужое: человек
    // ответит «да» про запись, которую не имел в виду.
    const verdict = checkResolverThreshold(runWith({ actual: 'apply', targetOk: false }));

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(' ')).toContain('не та запись');
  });
});

describe('лишняя осторожность порог не валит', () => {
  it('вопрос вместо применения — не ошибка, а выбор §7.3', () => {
    // «Ошибочный вопрос стоит пользователю одного тапа». Один такой
    // случай из шестнадцати — 93,8% верных решений, порог 85%.
    const report = runWith({ expected: 'apply', actual: 'ask' });

    expect(report.extraQuestions).toBe(1);
    expect(checkResolverThreshold(report).passed).toBe(true);
  });

  it('но лишних вопросов не может быть много', () => {
    // Три из шестнадцати — 81%, ниже порога: обещание «бот помнит»
    // перестаёт звучать, даже если вреда нет.
    const outcomes = [
      ...Array.from({ length: 13 }, () => outcome()),
      ...Array.from({ length: 3 }, () => outcome({ expected: 'apply', actual: 'ask' })),
    ];

    expect(checkResolverThreshold(collectResolver(outcomes, 'resolver@1')).passed).toBe(false);
  });
});

describe('молчание стенда не считается успехом', () => {
  it('пустой набор порог не проходит', () => {
    // Иначе удалённая папка со случаями выглядела бы как безупречный
    // прогон — и заслон перед заливкой промпта пропустил бы что угодно.
    expect(checkResolverThreshold(collectResolver([], 'resolver@1')).passed).toBe(false);
  });

  it('несостоявшийся вызов модели валит порог', () => {
    expect(checkResolverThreshold(runWith({ failed: true })).passed).toBe(false);
  });
});

describe('пороги заданы там, где их видно', () => {
  it('ложных применений и не тех записей разрешено ноль', () => {
    expect(RESOLVER_THRESHOLD.falseApplies).toBe(0);
    expect(RESOLVER_THRESHOLD.wrongTarget).toBe(0);
  });

  it('перепутанные дополнение и замена порог валят', () => {
    // §7.4: при замене переписывается заголовок дела человека. Решение
    // при этом выглядит верным — тем опаснее.
    const verdict = checkResolverThreshold(runWith({ modeOk: false }));

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(' ')).toContain('дополнение и замена');
  });

  it('доля решений оставляет запас к замеру', () => {
    // Три прогона дали 16 из 16. Порог 0,85 оставляет две ошибки из
    // шестнадцати на то, чего мы ещё не видели.
    expect(RESOLVER_THRESHOLD.decisions).toBeGreaterThanOrEqual(0.8);
    expect(RESOLVER_THRESHOLD.decisions).toBeLessThan(1);
  });
});

describe('подмена слов человека считается ошибкой', () => {
  it('переписанный без спроса заголовок виден в отчёте', () => {
    /**
     * Самая тихая ошибка разбора: запись на месте, срок верный, а слова
     * подменены пересказом модели. Заметить её можно только сверкой —
     * поэтому она и мерится отдельным числом.
     */
    const report = collectResolver([outcome({ textOk: false })], 'resolver@test');

    expect(report.rewrittenText).toBe(1);
    /**
     * Само решение при этом верное: запись найдена, вид действия тот.
     * Потому подмена слов и считается отдельно — в общем счёте она
     * растворилась бы, а вреда от неё столько же.
     */
    expect(report.decisionCorrect).toBe(1);
  });

  it('когда переписывать и просили, ошибки нет', () => {
    const report = collectResolver([outcome()], 'resolver@test');

    expect(report.rewrittenText).toBe(0);
  });
});

describe('порог смотрит на всё, что набор мерит (ревизия этапа)', () => {
  /**
   * **Набор мерил и печатал, а порог не смотрел.** Отчёт с двадцатью
   * одной подменой слов человека возвращал `passed: true` — и разрешал
   * включение промпта. Число из отчёта, на которое никто не смотрит, не
   * доказательство: ровно то же было с процентом промаха по дате
   * (задача 3.61).
   */

  function clean(): ResolverReport {
    return {
      cases: 16,
      decisionCorrect: 16,
      falseApplies: 0,
      extraQuestions: 0,
      missedPatches: 0,
      wrongTarget: 0,
      wrongDeadline: 0,
      wrongMode: 0,
      rewrittenText: 0,
      failed: 0,
      promptVersion: 'resolver@2',
    };
  }

  it('чистый отчёт порог проходит', () => {
    expect(checkResolverThreshold(clean()).passed).toBe(true);
  });

  it('подменённые слова человека порог не проходят', () => {
    const verdict = checkResolverThreshold({ ...clean(), rewrittenText: 1 });

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(' ')).toContain('подменены пересказом');
  });

  it('не тот срок порог не проходит', () => {
    const verdict = checkResolverThreshold({ ...clean(), wrongDeadline: 1 });

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(' ')).toContain('не тот срок');
  });

  it('каждое поле отчёта либо в пороге, либо названо исключением', () => {
    /**
     * **Страж от повторения находки.** Появится в отчёте новое число —
     * и эта проверка покраснеет, пока его не внесут в порог или не
     * запишут в исключения с причиной. Иначе оно опять окажется
     * измеренным и непроверяемым.
     */
    const EXCEPTIONS = new Set([
      // Не провал: §7.3 велит спрашивать чаще, чем угадывать.
      'extraQuestions',
      // Считается через долю верных решений, своего порога не имеет.
      'decisionCorrect',
      // Не провал сам по себе: новая запись вместо правки — мягкая
      // ошибка, и порог по ней сузил бы «спрашивать чаще».
      'missedPatches',
      // Не измерения: состав прогона.
      'cases',
      'promptVersion',
    ]);

    const inThreshold = new Set(Object.keys(RESOLVER_THRESHOLD));

    const unguarded = Object.keys(clean()).filter(
      (name) => !inThreshold.has(name) && !EXCEPTIONS.has(name),
    );

    expect(unguarded, `Поля отчёта без порога и без причины: ${unguarded.join(', ')}`).toEqual([]);
  });
});
