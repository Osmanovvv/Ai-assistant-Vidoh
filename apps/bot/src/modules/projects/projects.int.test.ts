import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, projectSteps, type Item } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import type { AiClientDeps } from '../ai/client.js';
import { MockLlmProvider } from '../ai/providers/mock.js';
import { PromptRegistry } from '../ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../ai/prompts/seed.js';
import { DECOMPOSER_SCHEMA_NAME } from '../ai/schemas/index.js';
import { upsertUser } from '../users/users.repo.js';
import { decomposeIfNeeded } from './decomposer.service.js';
import { defaultTexts } from '../../texts/index.js';
import { describeProject } from './project-text.js';
import { completeStep, contextOf, nextStepOf, saveSteps } from './projects.service.js';

/**
 * Проекты и ближайший шаг (задачи 3.12 и 3.13).
 *
 * «Готово, когда: проект из десяти шагов даёт в выдаче ровно один;
 * закрытие шага двигает ближайший.» Второе здесь выполняется по
 * построению — ближайший вычисляется, а не хранится, — и проверять надо
 * именно это: что двигать нечего и сломать нечем.
 */

const NOW = new Date('2026-09-01T09:00:00.000Z');

let userId = '';
let project: Item;
let seq = 0;

beforeEach(async () => {
  seq++;
  userId = (await upsertUser(testDb(), { tgId: 6600 + seq, firstName: 'Аня' })).id;

  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: 'Спланировать годовщину родителей',
      type: 'TASK',
      priority: 'LATER',
      topic: 'семья',
      isProject: true,
    })
    .returning();

  if (!row) throw new Error('проект не создался');
  project = row;
});

describe('ближайший шаг', () => {
  it('проект из десяти шагов даёт наружу ровно один', async () => {
    await saveSteps(testDb(), {
      itemId: project.id,
      userId,
      texts: Array.from({ length: 10 }, (_unused, index) => `шаг ${String(index + 1)}`),
    });

    const next = await nextStepOf(testDb(), project.id);

    expect(next?.text).toBe('шаг 1');
  });

  it('закрытие шага двигает ближайший — по построению', async () => {
    // Признак вычисляется, а не хранится: колонка и настоящее состояние
    // разъехались бы молча, стоит одному закрытию пройти мимо кода.
    const steps = await saveSteps(testDb(), {
      itemId: project.id,
      userId,
      texts: ['выбрать дату', 'решить, где отмечаем', 'позвать гостей'],
    });

    const outcome = await completeStep(testDb(), {
      stepId: steps[0]?.id ?? '',
      userId,
      now: NOW,
    });

    expect(outcome.kind).toBe('done');
    expect((await nextStepOf(testDb(), project.id))?.text).toBe('решить, где отмечаем');
  });

  it('последний шаг закрыт — ближайшего нет', async () => {
    const steps = await saveSteps(testDb(), { itemId: project.id, userId, texts: ['один шаг'] });
    await completeStep(testDb(), { stepId: steps[0]?.id ?? '', userId, now: NOW });

    expect(await nextStepOf(testDb(), project.id)).toBeUndefined();
  });

  it('повторное закрытие ничего не меняет', async () => {
    const steps = await saveSteps(testDb(), { itemId: project.id, userId, texts: ['раз', 'два'] });
    const id = steps[0]?.id ?? '';

    await completeStep(testDb(), { stepId: id, userId, now: NOW });
    const again = await completeStep(testDb(), { stepId: id, userId, now: NOW });

    expect(again.kind).toBe('already');
    expect((await nextStepOf(testDb(), project.id))?.text).toBe('два');
  });

  it('чужой шаг закрыть нельзя', async () => {
    const stranger = await upsertUser(testDb(), { tgId: 6700 + seq, firstName: 'Чужая' });
    const steps = await saveSteps(testDb(), { itemId: project.id, userId, texts: ['раз'] });

    const outcome = await completeStep(testDb(), {
      stepId: steps[0]?.id ?? '',
      userId: stranger.id,
      now: NOW,
    });

    expect(outcome.kind).toBe('gone');
  });

  it('шаги уходят вместе с проектом', async () => {
    await saveSteps(testDb(), { itemId: project.id, userId, texts: ['раз', 'два'] });
    await testDb().delete(items).where(eq(items.id, project.id));

    const left = await testDb()
      .select()
      .from(projectSteps)
      .where(eq(projectSteps.itemId, project.id));

    expect(left).toEqual([]);
  });
});

describe('возврат к проекту (§21 п.6, задача 3.13)', () => {
  it('показывает сделанное, остаток и один шаг — без единого вопроса', async () => {
    const steps = await saveSteps(testDb(), {
      itemId: project.id,
      userId,
      texts: ['выбрать дату', 'решить, где отмечаем', 'позвать гостей'],
    });

    await completeStep(testDb(), { stepId: steps[0]?.id ?? '', userId, now: NOW });

    const text = describeProject(project, await contextOf(testDb(), project.id), defaultTexts);

    expect(text).toContain('выбрать дату');
    expect(text).toContain('позвать гостей');
    expect(text).toContain('Ближайший шаг: решить, где отмечаем');

    // Ни одного вопроса: переспросить — значит показать, что бот не
    // помнит, а весь третий этап про то, что помнит.
    expect(text).not.toContain('?');
  });

  it('ближайший шаг не повторяется в списке остатка', async () => {
    // Иначе он назван дважды, и человек гадает, разные ли это дела.
    await saveSteps(testDb(), { itemId: project.id, userId, texts: ['раз', 'два'] });

    const text = describeProject(project, await contextOf(testDb(), project.id), defaultTexts);
    const occurrences = text.split('раз').length - 1;

    expect(occurrences).toBe(1);
  });

  it('неразложенный проект честно говорит, что шагов нет', async () => {
    const text = describeProject(project, await contextOf(testDb(), project.id), defaultTexts);

    expect(text).toContain(defaultTexts.project.noSteps);
  });

  it('законченный проект так и говорит', async () => {
    const steps = await saveSteps(testDb(), {
      itemId: project.id,
      userId,
      texts: ['единственный'],
    });
    await completeStep(testDb(), { stepId: steps[0]?.id ?? '', userId, now: NOW });

    const text = describeProject(project, await contextOf(testDb(), project.id), defaultTexts);

    expect(text).toContain(defaultTexts.project.finished);
  });
});

describe('разложение ленивое (задача 3.12)', () => {
  /**
   * Момент вызова в ТЗ не определён, и решение стоит денег. Раскладывать
   * при создании значило бы платить за каждый проект, к которому человек
   * никогда не вернётся, — а таких большинство.
   *
   * План просит на это интеграционный тест. Он здесь и считает вызовы.
   */
  function decomposerSaying(steps: readonly string[]): {
    deps: AiClientDeps;
    provider: MockLlmProvider;
  } {
    const provider = new MockLlmProvider({ respond: () => JSON.stringify({ steps }) });

    return {
      provider,
      deps: {
        db: testDb(),
        provider,
        prompts: new PromptRegistry(testDb()),
        retry: { attempts: 1, sleep: () => Promise.resolve() },
      },
    };
  }

  beforeEach(async () => {
    await seedPrompt(testDb(), {
      stage: 'decomposer',
      version: 'decomposer@test',
      prompt: 'разложи цель на шаги',
      schemaName: DECOMPOSER_SCHEMA_NAME,
    });
    await activatePrompt(testDb(), 'decomposer', 'decomposer@test');
  });

  it('первое обращение раскладывает, второе — нет', async () => {
    const { deps, provider } = decomposerSaying(['выбрать дату', 'позвать гостей']);

    const first = await decomposeIfNeeded({ db: testDb(), ai: deps }, { item: project, userId });
    expect(first).toHaveLength(2);
    expect(provider.callCount).toBe(1);

    const second = await decomposeIfNeeded({ db: testDb(), ai: deps }, { item: project, userId });
    expect(second).toHaveLength(2);
    // Второе разложение стёрло бы прогресс и подсунуло другой список:
    // модель нестабильна, а закрытые шаги — состояние человека.
    expect(provider.callCount).toBe(1);
  });

  it('обычное дело не раскладывается и модель не зовёт', async () => {
    const [plain] = await testDb()
      .insert(items)
      .values({
        userId,
        text: 'Купить хлеб',
        type: 'TASK',
        priority: 'SOON',
        topic: 'покупки',
      })
      .returning();

    const { deps, provider } = decomposerSaying(['шаг']);

    expect(await decomposeIfNeeded({ db: testDb(), ai: deps }, { item: plain!, userId })).toEqual(
      [],
    );
    expect(provider.callCount).toBe(0);
  });

  it('модель не ответила — проект остаётся обычной записью', async () => {
    const provider = new MockLlmProvider({ respond: () => 'не json' });
    const deps: AiClientDeps = {
      db: testDb(),
      provider,
      prompts: new PromptRegistry(testDb()),
      retry: { attempts: 1, sleep: () => Promise.resolve() },
    };

    expect(await decomposeIfNeeded({ db: testDb(), ai: deps }, { item: project, userId })).toEqual(
      [],
    );
  });
});
