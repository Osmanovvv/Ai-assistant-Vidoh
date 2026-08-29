import { describe, expect, it } from 'vitest';

import type { ResolverAnswer } from '../ai/schemas/index.js';
import type { Candidate, CandidateSource } from './candidates.js';
import { decide, DEFAULT_THRESHOLDS } from './decision.js';

/**
 * Пороговая логика резолвера (§7.3 ТЗ, задача 3.2).
 *
 * План требует таблицу случаев. Она здесь — и проверяет не только три
 * строки из ТЗ, но и то, ради чего второй сигнал вводился: уверенная
 * модель без подтверждения запись человека не меняет.
 *
 * Цена ошибки несимметрична, и таблица это отражает: лишний вопрос стоит
 * одного тапа, лишнее изменение — доверия.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'i-1',
    text: 'Записать сына к врачу в четверг',
    topic: 'здоровье',
    deadlineAt: null,
    status: 'new',
    updatedAt: new Date(NOW.getTime() - 2 * 60_000),
    similarity: null,
    sources: ['session'] as readonly CandidateSource[],
    ...overrides,
  };
}

function answer(overrides: Partial<ResolverAnswer> = {}): ResolverAnswer {
  return {
    action: 'update',
    mode: 'replace',
    itemId: 'i-1',
    confidence: 0.9,
    changes: { note: '', text: '', deadline: '2026-09-04', deadlineAccuracy: 'day' },
    reason: 'поправка срока',
    ...overrides,
  };
}

describe('три строки §7.3', () => {
  it('высокая уверенность с подтверждением — применить', () => {
    const verdict = decide(answer(), [candidate()], { now: NOW });

    expect(verdict.kind).toBe('apply');
    expect(verdict.candidate?.id).toBe('i-1');
  });

  it('средняя уверенность — спросить', () => {
    for (const confidence of [0.45, 0.6, 0.79]) {
      expect(decide(answer({ confidence }), [candidate()], { now: NOW }).kind).toBe('ask');
    }
  });

  it('низкая уверенность — создать новую: дубли лучше потери данных', () => {
    for (const confidence of [0, 0.2, 0.44]) {
      const verdict = decide(answer({ confidence }), [candidate()], { now: NOW });
      expect(verdict.kind).toBe('create');
      expect(verdict.action).toBe('new');
    }
  });

  it('границы порогов включающие', () => {
    // Ровно 0.80 — уже верхняя полоса, ровно 0.45 — уже средняя.
    expect(decide(answer({ confidence: 0.8 }), [candidate()], { now: NOW }).kind).toBe('apply');
    expect(decide(answer({ confidence: 0.45 }), [candidate()], { now: NOW }).kind).toBe('ask');
  });
});

describe('второй сигнал: без подтверждения не меняем', () => {
  it('уверенность высокая, запись несвежая и непохожая — спросить', () => {
    // Это и есть смысл второго сигнала. Самооценка модели завышена;
    // одного её числа мало, чтобы трогать запись человека.
    const stale = candidate({
      updatedAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
      sources: ['session'],
    });

    const verdict = decide(answer({ confidence: 0.99 }), [stale], { now: NOW });

    expect(verdict.kind).toBe('ask');
    expect(verdict.why).toContain('второго сигнала нет');
  });

  it('свежесть подтверждает, только когда свежая запись одна', () => {
    // Человек наговорил три дела и поправил одно вскользь — свежесть
    // не указывает ни на одно из них.
    const many = [
      candidate({ id: 'i-1' }),
      candidate({ id: 'i-2', text: 'Купить корм' }),
      candidate({ id: 'i-3', text: 'Сверить кассу' }),
    ];

    expect(decide(answer(), many, { now: NOW }).kind).toBe('ask');
    expect(decide(answer(), [many[0]!], { now: NOW }).kind).toBe('apply');
  });

  it('свежесть кончается вместе с окном', () => {
    const inside = candidate({ updatedAt: new Date(NOW.getTime() - 14 * 60_000) });
    const outside = candidate({ updatedAt: new Date(NOW.getTime() - 16 * 60_000) });

    expect(decide(answer(), [inside], { now: NOW }).kind).toBe('apply');
    expect(decide(answer(), [outside], { now: NOW }).kind).toBe('ask');
  });

  it('свежесть засчитывается только короткой памяти', () => {
    // Запись могла попасть в список смысловым поиском и оказаться
    // недавно тронутой по совпадению — это не тот сигнал.
    const found = candidate({ sources: ['semantic'], similarity: 0.3 });

    expect(decide(answer(), [found], { now: NOW }).kind).toBe('ask');
  });

  it('близость подтверждает при отрыве от второго кандидата', () => {
    const chosen = candidate({ id: 'i-1', sources: ['semantic'], similarity: 0.62 });
    const rival = candidate({ id: 'i-2', sources: ['semantic'], similarity: 0.4 });

    const verdict = decide(answer(), [chosen, rival], { now: NOW });

    expect(verdict.kind).toBe('apply');
    expect(verdict.why).toContain('близостью');
  });

  it('близость без отрыва не подтверждает: два похожих — это неясность', () => {
    const chosen = candidate({ id: 'i-1', sources: ['semantic'], similarity: 0.62 });
    const rival = candidate({ id: 'i-2', sources: ['semantic'], similarity: 0.58 });

    expect(decide(answer(), [chosen, rival], { now: NOW }).kind).toBe('ask');
  });

  it('близость ниже порога не подтверждает', () => {
    // Замеренная близость настоящей поправки — около 0,3. Сама по себе
    // она сигналом не является.
    const chosen = candidate({ sources: ['semantic'], similarity: 0.31 });

    expect(decide(answer(), [chosen], { now: NOW }).kind).toBe('ask');
  });

  it('совпадение по сроку подтверждает', () => {
    const dated = candidate({
      sources: ['deadline'],
      updatedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
      deadlineAt: new Date('2026-09-03T21:00:00.000Z'),
    });

    const verdict = decide(answer(), [dated], { now: NOW });

    expect(verdict.kind).toBe('apply');
    expect(verdict.why).toContain('сроком');
  });
});

describe('защита от выдуманного ответа', () => {
  it('запись не из списка не применяется ни при какой уверенности', () => {
    // Модель может назвать идентификатор, которого мы ей не давали.
    // Что это за запись и чья она — неизвестно.
    const verdict = decide(answer({ itemId: 'i-999', confidence: 1 }), [candidate()], { now: NOW });

    expect(verdict.kind).toBe('create');
    expect(verdict.why).toContain('не было среди кандидатов');
  });

  it('пустой список кандидатов даёт новую запись', () => {
    expect(decide(answer({ confidence: 1 }), [], { now: NOW }).kind).toBe('create');
  });

  it('ответ «новая мысль» уважается даже при высокой уверенности', () => {
    const verdict = decide(answer({ action: 'new', itemId: '', confidence: 0.95 }), [candidate()], {
      now: NOW,
    });

    expect(verdict.kind).toBe('create');
  });
});

describe('действие сохраняется', () => {
  it('закрыть и отменить проходят те же пороги, что и правка', () => {
    // Закрыть чужое дело — такая же потеря доверия, как поправить его.
    for (const action of ['complete', 'cancel'] as const) {
      const applied = decide(answer({ action }), [candidate()], { now: NOW });
      expect(applied.kind).toBe('apply');
      expect(applied.action).toBe(action);

      const asked = decide(answer({ action, confidence: 0.5 }), [candidate()], { now: NOW });
      expect(asked.kind).toBe('ask');
      expect(asked.action).toBe(action);
    }
  });
});

describe('пороги настраиваются', () => {
  it('переданные значения перекрывают значения по умолчанию', () => {
    // §3.2: пороги должны настраиваться из админки. Её ещё нет, но
    // настраиваемость обязана быть заложена, иначе четвёртый этап
    // упрётся в константы, разбросанные по коду.
    const strict = decide(answer({ confidence: 0.85 }), [candidate()], {
      now: NOW,
      thresholds: { apply: 0.95 },
    });

    expect(strict.kind).toBe('ask');
  });

  it('значения по умолчанию — те, что измерены', () => {
    expect(DEFAULT_THRESHOLDS.apply).toBe(0.8);
    expect(DEFAULT_THRESHOLDS.create).toBe(0.45);
    // Порог близости 0,75 из плана недостижим для поправок: замер дал
    // 0,31–0,52. Если кто-то вернёт его обратно, тест скажет об этом.
    expect(DEFAULT_THRESHOLDS.similarity).toBeLessThan(0.6);
  });
});

describe('отметка выполнения не переспрашивает (§21 п.8, задача 3.8)', () => {
  /**
   * Два пункта §21 спорят: п.8 требует отметки «без уточняющих вопросов»,
   * п.5 — вопроса на неоднозначной реплике. Спор решён замером: отметка
   * повторяет слова дела, и близость у неё выше, чем у поправки.
   *
   * Значит порог у неё свой — и проверять надо обе стороны: что ясная
   * отметка проходит молча, а неясная всё равно спрашивает.
   */
  const found = (similarity: number): Candidate =>
    candidate({
      sources: ['semantic'],
      similarity,
      updatedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
    });

  it('«кассу сверила» закрывает дело без вопроса', () => {
    // Замер этой пары — 0,512. Правке такой близости не хватило бы, и это
    // верно: правка не повторяет слов дела, а отметка повторяет.
    const verdict = decide(answer({ action: 'complete' }), [found(0.512)], { now: NOW });

    expect(verdict.kind).toBe('apply');
    expect(verdict.action).toBe('complete');
  });

  it('самая слабая из замеренных верных пар тоже проходит', () => {
    // «Продукты купила» → «Проверить список продуктов», 0,391.
    expect(decide(answer({ action: 'complete' }), [found(0.391)], { now: NOW }).kind).toBe('apply');
  });

  it('самая сильная из чужих пар не проходит', () => {
    // «Записалась к врачу» → «Сверить кассу», 0,256. Закрыть чужое дело
    // дороже, чем переспросить.
    expect(decide(answer({ action: 'complete' }), [found(0.256)], { now: NOW }).kind).toBe('ask');
  });

  it('двум похожим делам отметка всё равно задаёт вопрос (§21 п.5)', () => {
    // «Купила» при двух покупках сразу: отрыва нет, и низкий порог тут не
    // помогает — он и не должен.
    const first = candidate({ id: 'i-1', sources: ['semantic'], similarity: 0.45 });
    const second = candidate({ id: 'i-2', sources: ['semantic'], similarity: 0.42 });

    expect(decide(answer({ action: 'complete' }), [first, second], { now: NOW }).kind).toBe('ask');
  });

  it('правке этот порог не достаётся', () => {
    // 0,391 для отметки — достаточно, для правки — нет. Иначе смягчение
    // ради §21 п.8 тихо распространилось бы на переписывание заголовков.
    expect(decide(answer({ action: 'update' }), [found(0.391)], { now: NOW }).kind).toBe('ask');
  });

  it('отмена идёт по тому же порогу, что и выполнение', () => {
    // §13.5: «убрать» — тоже не переписывание, а перевод в отменённые, и
    // откатывается одним тапом.
    expect(decide(answer({ action: 'cancel' }), [found(0.42)], { now: NOW }).kind).toBe('apply');
  });
});
