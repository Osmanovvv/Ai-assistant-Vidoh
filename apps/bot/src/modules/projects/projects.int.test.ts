import { eq } from 'drizzle-orm';
import pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';

import { itemRevisions, items, projectSteps, type Item } from '../../db/schema.js';
import { testDatabaseUrl, testDb } from '../../test/db.js';
import type { AiClientDeps } from '../ai/client.js';
import { MockLlmProvider } from '../ai/providers/mock.js';
import { PromptRegistry } from '../ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../ai/prompts/seed.js';
import { DECOMPOSER_SCHEMA_NAME, DECOMPOSER_V1_SCHEMA_NAME } from '../ai/schemas/index.js';
import { upsertUser } from '../users/users.repo.js';
import { decomposeGoal, decomposeIfNeeded } from './decomposer.service.js';
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

  it('закрытие шага — движение по проекту: запись обновляется (ревизия этапа 3, G2)', async () => {
    /**
     * «Нет движения» планировщик считает по `updatedAt` записи, а шаги
     * закрывались только в своей таблице: человек закрывал шаг за шагом,
     * а бот каждые пять дней спрашивал «как там ремонт?».
     */
    await testDb()
      .update(items)
      .set({ updatedAt: new Date('2026-08-20T09:00:00.000Z') })
      .where(eq(items.id, project.id));
    const steps = await saveSteps(testDb(), {
      itemId: project.id,
      userId,
      texts: ['выбрать дату', 'позвать гостей'],
    });

    await completeStep(testDb(), { stepId: steps[0]?.id ?? '', userId, now: NOW });

    const [after] = await testDb().select().from(items).where(eq(items.id, project.id));
    expect(after?.updatedAt.toISOString()).toBe(NOW.toISOString());
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

describe('нумерация от модели не доходит до человека', () => {
  /**
   * Найдено ручным прогоном 01.09.2026. В базе лежало
   * `[. Определить дату дня рождения]`, и человек видел «— . Решить, где
   * праздновать» в каждой строке, включая «Ближайший шаг: . …».
   *
   * Было и в выводе сквозного теста — но тот проверял, что шаг упомянут в
   * ответе, а не как он выглядит. Поэтому здесь смотрим на форму текста.
   */
  it('срезает точку, которую модель ставит перед шагом', async () => {
    const saved = await saveSteps(testDb(), {
      itemId: project.id,
      userId,
      texts: ['. Определить дату', '. Позвать гостей'],
    });

    expect(saved.map((step) => step.text)).toEqual(['Определить дату', 'Позвать гостей']);
  });

  it('срезает «1.» и «2)»', async () => {
    const saved = await saveSteps(testDb(), {
      itemId: project.id,
      userId,
      texts: ['1. Вызвать замерщика', '2) Выбрать плитку', '- Заказать доставку'],
    });

    expect(saved.map((step) => step.text)).toEqual([
      'Вызвать замерщика',
      'Выбрать плитку',
      'Заказать доставку',
    ]);
  });

  it('срезает жирную разметку вокруг номера и шага (проба decomposer@2, 30.09.2026)', async () => {
    // Ответы модели знак в знак: человек увидел бы «*1**. Решить…».
    const saved = await saveSteps(testDb(), {
      itemId: project.id,
      userId,
      texts: [
        '**1**. Решить, чем будем угощать гостей',
        '**Сделать ремонт в ванной**',
        '*Позвать гостей*',
      ],
    });

    expect(saved.map((step) => step.text)).toEqual([
      'Решить, чем будем угощать гостей',
      'Сделать ремонт в ванной',
      'Позвать гостей',
    ]);
  });

  it('цифру в начале осмысленного шага не трогает', async () => {
    // Жадное правило превратило бы «2 торта купить» в «торта купить».
    const saved = await saveSteps(testDb(), {
      itemId: project.id,
      userId,
      texts: ['2 торта купить', '10 свечей найти'],
    });

    expect(saved.map((step) => step.text)).toEqual(['2 торта купить', '10 свечей найти']);
  });

  it('шаг, от которого осталась одна нумерация, не сохраняется', async () => {
    const saved = await saveSteps(testDb(), {
      itemId: project.id,
      userId,
      texts: ['1.', '. ', 'Настоящий шаг'],
    });

    expect(saved.map((step) => step.text)).toEqual(['Настоящий шаг']);
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

describe('разложение: один раз — при записи или при первом открытии (3.12; заказчица 30.09.2026)', () => {
  /**
   * С 30.09.2026 цели раскладываются сразу при записи (правка заказчицы,
   * решение Никиты), а здесь — запасной путь: цели, записанные раньше, и
   * те, где модель тогда не ответила. Раскладывается один раз: шаги — это
   * состояние человека, второе разложение стёрло бы прогресс.
   */
  function decomposerSaying(
    steps: readonly string[],
    title?: string,
  ): {
    deps: AiClientDeps;
    provider: MockLlmProvider;
  } {
    const provider = new MockLlmProvider({
      respond: () => JSON.stringify({ title: title ?? project.text, steps }),
    });

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

  async function goalNamed(text: string): Promise<Item> {
    const [row] = await testDb()
      .update(items)
      .set({ text })
      .where(eq(items.id, project.id))
      .returning();
    if (!row) throw new Error('цель не переименовалась');
    return row;
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
    expect(first.steps).toHaveLength(2);
    expect(provider.callCount).toBe(1);

    const second = await decomposeIfNeeded({ db: testDb(), ai: deps }, { item: project, userId });
    expect(second.steps).toHaveLength(2);
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

    expect(await decomposeIfNeeded({ db: testDb(), ai: deps }, { item: plain!, userId })).toEqual({
      steps: [],
    });
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

    expect(await decomposeIfNeeded({ db: testDb(), ai: deps }, { item: project, userId })).toEqual({
      steps: [],
    });
  });

  it('модель недоступна — не ошибка: цель остаётся как была', async () => {
    const provider = new MockLlmProvider({
      respond: () => {
        throw new Error('сеть упала');
      },
    });
    const deps: AiClientDeps = {
      db: testDb(),
      provider,
      prompts: new PromptRegistry(testDb()),
      retry: { attempts: 1, sleep: () => Promise.resolve() },
    };

    await expect(
      decomposeIfNeeded({ db: testDb(), ai: deps }, { item: project, userId }),
    ).resolves.toEqual({ steps: [] });
  });

  it('короткое название — только принятое проверкой кода', async () => {
    const goal = await goalNamed('Разобраться с днём рождения ребёнка, место, гости, торт');
    const accepted = decomposerSaying(
      ['Выбрать место', 'Позвать гостей', 'Заказать торт'],
      'Разобраться с днём рождения ребёнка',
    );

    const planned = await decomposeIfNeeded(
      { db: testDb(), ai: accepted.deps },
      { item: goal, userId },
    );
    expect(planned.title).toBe('Разобраться с днём рождения ребёнка');
    expect(planned.steps.map((step) => step.text)).toEqual([
      'Выбрать место',
      'Позвать гостей',
      'Заказать торт',
    ]);
  });

  it('название переписано своими словами — шаги есть, название прежнее', async () => {
    const goal = await goalNamed('Разобраться с днём рождения ребёнка, место, гости, торт');
    const rewritten = decomposerSaying(
      ['Выбрать место', 'Позвать гостей', 'Заказать торт'],
      'Организовать праздник для ребёнка',
    );

    const planned = await decomposeIfNeeded(
      { db: testDb(), ai: rewritten.deps },
      { item: goal, userId },
    );
    expect(planned.title).toBeUndefined();
    expect(planned.steps).toHaveLength(3);
  });

  it('первая версия схемы — только шаги: откат на decomposer@1 работает', async () => {
    await seedPrompt(testDb(), {
      stage: 'decomposer',
      version: 'decomposer@test-v1',
      prompt: 'разложи цель на шаги',
      schemaName: DECOMPOSER_V1_SCHEMA_NAME,
    });
    await activatePrompt(testDb(), 'decomposer', 'decomposer@test-v1');
    const provider = new MockLlmProvider({
      respond: () => JSON.stringify({ steps: ['выбрать дату', 'позвать гостей'] }),
    });

    const planned = await decomposeIfNeeded(
      {
        db: testDb(),
        ai: {
          db: testDb(),
          provider,
          prompts: new PromptRegistry(testDb()),
          retry: { attempts: 1, sleep: () => Promise.resolve() },
        },
      },
      { item: project, userId },
    );

    expect(planned.steps).toHaveLength(2);
    expect(planned.title).toBeUndefined();
  });

  it('другая раскладка ещё пишет шаги — эта ждёт её и берёт её шаги, а не смесь', async () => {
    /**
     * Двойное нажатие в меню: две раскладки одной цели разом. «Другая» —
     * своим соединением, с тем же замком, шаги вставлены, но не закрыты.
     * Без замка эта не увидела бы их, вставила свои, и уникальность по
     * месту пропустила бы «лишние» места длинного списка — смесь двух.
     */
    const other = new pg.Client({ connectionString: testDatabaseUrl() });
    await other.connect();
    try {
      await other.query('begin');
      await other.query('select pg_advisory_xact_lock(hashtext($1))', [project.id]);
      await other.query(
        'insert into project_steps (item_id, user_id, text, position) values ($1, $2, $3, 0), ($1, $2, $4, 1)',
        [project.id, userId, 'чужой шаг один', 'чужой шаг два'],
      );

      const { deps } = decomposerSaying(['шаг один', 'шаг два', 'шаг три', 'шаг четыре']);
      const pending = decomposeIfNeeded({ db: testDb(), ai: deps }, { item: project, userId });

      // Эта упёрлась в незакрытую другую — замком или вставкой.
      for (let attempt = 0; attempt < 200; attempt++) {
        const waiting = await other.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
           where wait_event_type = 'Lock' and pid <> pg_backend_pid()
             and (query ilike '%pg_advisory_xact_lock%' or query ilike '%project_steps%')`,
        );
        if ((waiting.rows[0]?.n ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await other.query('commit');

      const result = await pending;
      expect(result.steps.map((step) => step.text)).toEqual(['чужой шаг один', 'чужой шаг два']);
      const texts = (await contextOf(testDb(), project.id)).steps.map((step) => step.text);
      expect(texts).toEqual(['чужой шаг один', 'чужой шаг два']);
    } finally {
      await other.end();
    }
  });

  it('открытая цель переименовывается правкой — с историей, как из карточки', async () => {
    const goal = await goalNamed('Разобраться с днём рождения ребёнка, место, гости, торт');
    const { deps } = decomposerSaying(
      ['Выбрать место', 'Позвать гостей', 'Заказать торт'],
      'Разобраться с днём рождения ребёнка',
    );

    const planned = await decomposeGoal(
      { db: testDb(), ai: deps, rename: { db: testDb() } },
      { item: goal, userId, timeZone: 'Europe/Moscow', textProfile: null },
    );

    expect(planned.item.text).toBe('Разобраться с днём рождения ребёнка');
    const [stored] = await testDb().select().from(items).where(eq(items.id, goal.id));
    expect(stored?.text).toBe('Разобраться с днём рождения ребёнка');
    const history = await testDb()
      .select()
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, goal.id));
    expect(history.map((one) => one.changedBy)).toEqual(['resolver']);
  });

  it('название не принято — цель не трогается и правки в истории нет', async () => {
    const goal = await goalNamed('Спланировать годовщину родителей');
    const { deps } = decomposerSaying(['выбрать дату', 'позвать гостей']);

    const planned = await decomposeGoal(
      { db: testDb(), ai: deps, rename: { db: testDb() } },
      { item: goal, userId, timeZone: 'Europe/Moscow', textProfile: null },
    );

    expect(planned.item.text).toBe('Спланировать годовщину родителей');
    const history = await testDb()
      .select()
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, goal.id));
    expect(history).toHaveLength(0);
  });
});
