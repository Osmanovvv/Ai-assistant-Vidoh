import { beforeEach, describe, expect, it } from 'vitest';

import { testDb } from '../../test/db.js';
import { MockLlmProvider } from '../ai/providers/mock.js';
import { PromptRegistry } from '../ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../ai/prompts/seed.js';
import { RESOLVER_SCHEMA_NAME, type ResolverAnswer } from '../ai/schemas/index.js';
import type { AiClientDeps } from '../ai/client.js';
import type { Candidate } from './candidates.js';
import { resolveSegment } from './resolver.service.js';

/**
 * Резолвер целиком: от списка кандидатов до решения (задача 3.2).
 *
 * Пороговая таблица проверена отдельно и на чистой функции. Здесь —
 * то, что живёт только в связке: как кандидаты попадают в запрос, как
 * номер из ответа превращается обратно в запись и что происходит, когда
 * модель отвечает не то.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');

let deps: AiLike;
let provider: MockLlmProvider;

interface AiLike extends AiClientDeps {
  readonly provider: MockLlmProvider;
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    text: 'Записать сына к врачу в четверг',
    topic: 'здоровье',
    deadlineAt: new Date('2026-09-02T21:00:00.000Z'),
    status: 'new',
    updatedAt: new Date(NOW.getTime() - 2 * 60_000),
    similarity: null,
    sources: ['session'],
    ...overrides,
  };
}

function answer(overrides: Partial<ResolverAnswer> = {}): string {
  return JSON.stringify({
    action: 'update',
    mode: 'replace',
    itemId: '1',
    confidence: 0.9,
    changes: { note: '', text: '', deadline: '2026-09-04', deadlineAccuracy: 'day' },
    reason: 'человек переносит срок',
    ...overrides,
  });
}

function withAnswer(raw: string): AiLike {
  provider = new MockLlmProvider({ respond: () => raw });

  return {
    db: testDb(),
    provider,
    prompts: new PromptRegistry(testDb()),
    retry: { attempts: 1, sleep: () => Promise.resolve() },
  };
}

beforeEach(async () => {
  await seedPrompt(testDb(), {
    stage: 'resolver',
    version: 'resolver@test',
    prompt: 'реши, о какой записи речь',
    schemaName: RESOLVER_SCHEMA_NAME,
  });
  await activatePrompt(testDb(), 'resolver', 'resolver@test');

  deps = withAnswer(answer());
});

describe('запрос к модели', () => {
  it('кандидаты уходят номерами, а не идентификаторами', async () => {
    // §7.2: список компактный. Сорок UUID — это полторы тысячи знаков
    // ни о чём, а выдуманный номер видно сразу.
    await resolveSegment(deps, {
      segment: 'нет, в пятницу',
      candidates: [candidate()],
      timeZone: 'Europe/Moscow',
      now: NOW,
    });

    const sent = provider.requests[0]?.input ?? '';

    expect(sent).toContain('1. Записать сына к врачу в четверг');
    expect(sent).not.toContain('11111111-1111');
    expect(sent).toContain('нет, в пятницу');
  });

  it('карточка кандидата — только то, что разрешает §7.2', async () => {
    await resolveSegment(deps, {
      segment: 'нет, в пятницу',
      candidates: [candidate()],
      timeZone: 'Europe/Moscow',
      now: NOW,
    });

    const sent = provider.requests[0]?.input ?? '';

    expect(sent).toContain('тема: здоровье');
    expect(sent).toContain('срок 03.09');
    expect(sent).toContain('статус: new');
    // Время — словами: «2 мин назад» модель читает как близость по
    // времени, а отметку времени ей пришлось бы вычитать.
    expect(sent).toContain('изменено: 2 мин назад');
  });

  it('без кандидатов модель не вызывается вовсе', async () => {
    // Решать не из чего, а вызов стоил бы денег и не менял исхода.
    const result = await resolveSegment(deps, {
      segment: 'нет, в пятницу',
      candidates: [],
      timeZone: 'Europe/Moscow',
      now: NOW,
    });

    expect(provider.callCount).toBe(0);
    expect(result.decision.kind).toBe('create');
  });
});

describe('ответ модели', () => {
  it('номер превращается обратно в запись', async () => {
    const target = candidate({ id: '22222222-2222-4222-8222-222222222222', text: 'Сверить кассу' });

    const result = await resolveSegment(withAnswer(answer({ itemId: '2' })), {
      segment: 'кассу сверила',
      candidates: [candidate(), target],
      timeZone: 'Europe/Moscow',
      now: NOW,
    });

    expect(result.decision.candidate?.id).toBe(target.id);
  });

  it('номер за пределами списка даёт новую запись', async () => {
    const result = await resolveSegment(withAnswer(answer({ itemId: '7', confidence: 1 })), {
      segment: 'нет, в пятницу',
      candidates: [candidate()],
      timeZone: 'Europe/Moscow',
      now: NOW,
    });

    expect(result.decision.kind).toBe('create');
  });

  it('нечисловой номер даёт новую запись, а не падение', async () => {
    const result = await resolveSegment(withAnswer(answer({ itemId: 'первая' })), {
      segment: 'нет, в пятницу',
      candidates: [candidate()],
      timeZone: 'Europe/Moscow',
      now: NOW,
    });

    expect(result.decision.kind).toBe('create');
  });

  it('уверенность возвращается вместе с решением', async () => {
    const result = await resolveSegment(withAnswer(answer({ confidence: 0.91 })), {
      segment: 'нет, в пятницу',
      candidates: [candidate()],
      timeZone: 'Europe/Moscow',
      now: NOW,
    });

    expect(result.confidence).toBe(0.91);
    expect(result.decision.kind).toBe('apply');
  });
});

describe('когда модель не отвечает', () => {
  it('сегмент становится новой записью, а не теряется', async () => {
    // §7.3: дубли лучше потери данных. Безопасный исход встроен сюда, а
    // не оставлен на совесть вызывающего.
    const result = await resolveSegment(withAnswer('не json вовсе'), {
      segment: 'нет, в пятницу',
      candidates: [candidate()],
      timeZone: 'Europe/Moscow',
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.decision.kind).toBe('create');
    expect(result.problem).toBeDefined();
  });

  it('ответ не по схеме тоже не роняет разбор', async () => {
    const result = await resolveSegment(withAnswer(JSON.stringify({ action: 'выдумка' })), {
      segment: 'нет, в пятницу',
      candidates: [candidate()],
      timeZone: 'Europe/Moscow',
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.decision.kind).toBe('create');
  });
});
