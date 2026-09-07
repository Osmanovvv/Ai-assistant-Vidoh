import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { promptVersions } from '../../db/schema.js';
import type { EvalReport } from '../../eval/report.js';
import type { ResolverReport } from '../../eval/resolver-report.js';
import { testDb } from '../../test/db.js';
import {
  CLASSIFIER_SCHEMA_NAME,
  PRESENTER_SCHEMA_NAME,
  RESOLVER_SCHEMA_NAME,
  ROUTER_SCHEMA_NAME,
} from '../ai/schemas/index.js';
import { PromptRegistry } from '../ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../ai/prompts/seed.js';
import { activateVersion, createHotfix, promptText, promptsView } from './prompts.js';

/**
 * Промпты в панели (§15 ТЗ, задача 4.8).
 *
 * Главное здесь не «экран со списком», а заслон: §15 разрешает менять
 * промпт без выкладки, §10.3 требует прогонять на любом изменении
 * контрольный набор. Панель — единственная дверь, через которую
 * регрессия может дойти до людей, минуя все остальные заслоны.
 *
 * 28.08.2026 такое уже случилось: выложили `router@3`, потом `router@4`
 * без прогона, и промпт терял три единицы из сорока трёх. Половина
 * проверок здесь — про то, чтобы это не повторилось через панель.
 */

let evalDir = '';

/**
 * Отчёт прогона: то, что читает проверка свежести.
 *
 * Пишется целиком, со всеми полями `EvalReport`. Урезанный отчёт прошёл бы
 * порог просто потому, что пропущенного поля нет, а сравнение с ничем
 * ложно: проверка мерила бы не то, что мы думаем.
 */
async function writeRun(params: {
  readonly name: string;
  readonly versions: Record<string, string>;
  readonly good?: boolean;
}): Promise<void> {
  const passing = params.good !== false;

  const report: EvalReport = {
    expected: 40,
    found: passing ? 40 : 20,
    missed: passing ? 0 : 20,
    extra: 0,
    typeCorrect: passing ? 40 : 10,
    priorityCorrect: 40,
    topicCorrect: 40,
    recurrenceCorrect: 40,
    projectCorrect: 40,
    projectChecked: 40,
    deadlineCorrect: 40,
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
    cases: 10,
    promptVersions: params.versions,
  };

  await writeFile(join(evalDir, 'runs', params.name), JSON.stringify(report), 'utf8');
}

/** Отчёт прогона резолвера: у него свой набор и свой порог. */
async function writeResolverRun(params: {
  readonly name: string;
  readonly version: string;
  readonly good?: boolean;
}): Promise<void> {
  const passing = params.good !== false;

  const report: ResolverReport = {
    cases: 20,
    decisionCorrect: passing ? 20 : 5,
    falseApplies: 0,
    extraQuestions: 0,
    missedPatches: 0,
    wrongTarget: 0,
    wrongDeadline: 0,
    wrongMode: 0,
    rewrittenText: 0,
    failed: 0,
    promptVersion: params.version,
  };

  await writeFile(
    join(evalDir, 'resolver', 'runs', params.name),
    JSON.stringify(report),
    'utf8',
  );
}

beforeAll(async () => {
  evalDir = await mkdtemp(join(tmpdir(), 'vydoh-eval-'));
  await mkdir(join(evalDir, 'runs'), { recursive: true });
  await mkdir(join(evalDir, 'resolver', 'runs'), { recursive: true });
});

afterAll(async () => {
  await rm(evalDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await testDb().delete(promptVersions);
  await rm(join(evalDir, 'runs'), { recursive: true, force: true });
  await rm(join(evalDir, 'resolver'), { recursive: true, force: true });
  await mkdir(join(evalDir, 'runs'), { recursive: true });
  await mkdir(join(evalDir, 'resolver', 'runs'), { recursive: true });

  await seedPrompt(testDb(), {
    stage: 'classifier',
    version: 'classifier@1',
    prompt: 'Разбери мысли на записи.',
    schemaName: CLASSIFIER_SCHEMA_NAME,
  });

  await seedPrompt(testDb(), {
    stage: 'classifier',
    version: 'classifier@2',
    prompt: 'Разбери мысли на записи, аккуратнее со сроками.',
    schemaName: CLASSIFIER_SCHEMA_NAME,
  });

  await activatePrompt(testDb(), 'classifier', 'classifier@1');
});

describe('просмотр версий', () => {
  it('показывает версии и какая включена, но не сам текст', async () => {
    /**
     * Тексты промптов — основное ноу-хау продукта, и возить их целиком
     * на каждое открытие страницы незачем. Текст отдаётся отдельным
     * запросом, на конкретную версию.
     */
    const view = await promptsView(testDb(), evalDir);
    const rows = view.versions.filter((one) => one.stage === 'classifier');

    expect(rows).toHaveLength(2);
    expect(rows.find((one) => one.version === 'classifier@1')?.isActive).toBe(true);
    expect(rows.find((one) => one.version === 'classifier@2')?.isActive).toBe(false);

    // В списке есть длина, но нет текста.
    expect(rows[0]).not.toHaveProperty('prompt');
    expect(rows.find((one) => one.version === 'classifier@1')?.length).toBeGreaterThan(0);
  });

  it('текст версии отдаётся отдельным запросом', async () => {
    const found = await promptText(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
    });

    expect(found?.prompt).toBe('Разбери мысли на записи, аккуратнее со сроками.');
    expect(found?.schemaName).toBe(CLASSIFIER_SCHEMA_NAME);
  });

  it('несуществующая версия — пусто, а не выдуманный текст', async () => {
    expect(
      await promptText(testDb(), { stage: 'classifier', version: 'нет такой' }),
    ).toBeUndefined();
  });
});

describe('горячая правка (§15, правило 2.1)', () => {
  it('создаёт новую версию, а не переписывает старую', async () => {
    /**
     * Опубликованная версия неизменна. Иначе жалоба «неделю назад бот
     * отвечал лучше» становится непроверяемой: той версии больше нет, а
     * в учёте вызовов на неё ссылаются тысячи строк.
     */
    const made = await createHotfix(testDb(), {
      stage: 'classifier',
      basedOn: 'classifier@1',
      prompt: 'Правленый текст.',
      by: 'аня',
    });

    const base = await promptText(testDb(), { stage: 'classifier', version: 'classifier@1' });

    expect(base?.prompt).toBe('Разбери мысли на записи.');
    expect(
      (await promptText(testDb(), { stage: 'classifier', version: made.version }))?.prompt,
    ).toBe('Правленый текст.');
  });

  it('имя версии говорит, что это правка из панели', async () => {
    /**
     * Имя едет в `ai_calls.prompt_version` при каждом вызове модели.
     * Через месяц в отчёте по расходу и в карточке человека будет
     * видно, что эти разборы сделаны правкой из панели.
     */
    const made = await createHotfix(testDb(), {
      stage: 'classifier',
      basedOn: 'classifier@1',
      prompt: 'Правленый текст.',
      by: 'аня',
    });

    expect(made.version).toContain('classifier@1');
    expect(made.version).toContain('hotfix');
  });

  it('пометка hotfix и автор попадают в примечание — правило 2.1', async () => {
    const made = await createHotfix(testDb(), {
      stage: 'classifier',
      basedOn: 'classifier@1',
      prompt: 'Правленый текст.',
      by: 'аня',
    });

    const [row] = await testDb()
      .select({ note: promptVersions.note })
      .from(promptVersions)
      .where(eq(promptVersions.version, made.version));

    expect(row?.note).toContain('hotfix');
    expect(row?.note).toContain('classifier@1');
    expect(row?.note).toContain('аня');
  });

  it('правка не включается сама — включение отдельным действием', async () => {
    // Иначе «сохранил и ушёл» означало бы непрогнанный промпт в бою.
    const made = await createHotfix(testDb(), {
      stage: 'classifier',
      basedOn: 'classifier@1',
      prompt: 'Правленый текст.',
      by: 'аня',
    });

    const [row] = await testDb()
      .select({ isActive: promptVersions.isActive })
      .from(promptVersions)
      .where(eq(promptVersions.version, made.version));

    expect(row?.isActive).toBe(false);
  });

  it('схема наследуется от основы и пересчитывается из кода', async () => {
    /**
     * Горячая правка меняет текст, а не формат ответа. Версия со
     * схемой, которой нет в коде, не поднялась бы вовсе — реестр
     * отказывается работать при расхождении.
     */
    const made = await createHotfix(testDb(), {
      stage: 'classifier',
      basedOn: 'classifier@1',
      prompt: 'Правленый текст.',
      by: 'аня',
    });

    await writeRun({ name: 'a.json', versions: { classifier: made.version } });
    await activateVersion(testDb(), {
      stage: 'classifier',
      version: made.version,
      evalDir,
      by: 'аня',
    });

    // Реестр поднимает версию без жалоб — значит схема сошлась с кодом.
    const active = await new PromptRegistry(testDb(), 0).get('classifier');

    expect(active.version).toBe(made.version);
    expect(active.prompt).toBe('Правленый текст.');
  });

  it('пустой промпт не принимается', async () => {
    // Это не «версия без текста», это сломанный разбор.
    await expect(
      createHotfix(testDb(), {
        stage: 'classifier',
        basedOn: 'classifier@1',
        prompt: '   ',
        by: 'аня',
      }),
    ).rejects.toThrow('Пустой промпт');
  });

  it('правка от несуществующей основы отвергается', async () => {
    await expect(
      createHotfix(testDb(), {
        stage: 'classifier',
        basedOn: 'нет такой',
        prompt: 'Текст.',
        by: 'аня',
      }),
    ).rejects.toThrow('нет в базе');
  });
});

describe('заслон §10.3: непрогнанное не включается', () => {
  it('без единого прогона включить нельзя', async () => {
    const outcome = await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok ? outcome.refused.reasons.join(' ') : '').toContain('нет ни одного');

    // И версия действительно не включена: отказ, а не отказ на словах.
    const [row] = await testDb()
      .select({ isActive: promptVersions.isActive })
      .from(promptVersions)
      .where(eq(promptVersions.version, 'classifier@2'));

    expect(row?.isActive).toBe(false);
  });

  it('прогон на другой версии не считается', async () => {
    /**
     * Ровно тот случай 28.08.2026: набор прогоняли, но на прошлом
     * промпте, а включали новый. Отчёт был, порог был пройден — и это
     * ничего не значило.
     */
    await writeRun({ name: 'a.json', versions: { classifier: 'classifier@1' } });

    const outcome = await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok ? outcome.refused.reasons.join(' ') : '').toContain('classifier@2');
  });

  it('прогон не прошёл порог — тоже нельзя', async () => {
    await writeRun({ name: 'a.json', versions: { classifier: 'classifier@2' }, good: false });

    const outcome = await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok ? outcome.refused.reasons.join(' ') : '').toContain('порог');
  });

  it('прогнанная версия включается', async () => {
    await writeRun({ name: 'a.json', versions: { classifier: 'classifier@2' } });

    const outcome = await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
    });

    expect(outcome.ok).toBe(true);

    const [row] = await testDb()
      .select({ isActive: promptVersions.isActive })
      .from(promptVersions)
      .where(eq(promptVersions.version, 'classifier@2'));

    expect(row?.isActive).toBe(true);
  });

  it('прогон этого сочетания засчитывается, даже если потом мерили другое', async () => {
    /**
     * Ради откатов. Включили новую версию, измерили, стало хуже — и по
     * правилу «сверять только с последним прогоном» вернуться назад было
     * бы нельзя, хотя прежнее сочетание мерили и оно прошло. Заслон,
     * мешающий откатиться, опаснее отсутствующего: откатываются в аварию.
     */
    await writeRun({ name: '2026-09-01.json', versions: { classifier: 'classifier@2' } });
    await writeRun({ name: '2026-09-05.json', versions: { classifier: 'classifier@1' } });

    const outcome = await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
    });

    expect(outcome.ok).toBe(true);
  });

  it('а если самый свежий прогон этого сочетания провалился — нельзя', async () => {
    /**
     * Оборотная сторона того же правила. Из двух прогонов одной версии
     * верить надо позднему: он мерил ту же версию на более свежем
     * наборе и на нынешнем поколении модели.
     */
    await writeRun({ name: '2026-09-01.json', versions: { classifier: 'classifier@2' } });
    await writeRun({
      name: '2026-09-05.json',
      versions: { classifier: 'classifier@2' },
      good: false,
    });

    const outcome = await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
    });

    expect(outcome.ok).toBe(false);
  });

  it('сочетание, а не отдельная версия: соседняя стадия тоже сверяется', async () => {
    /**
     * 28.08.2026 подвело именно сочетание: стадии мерили порознь, а
     * включали вместе. Прогон, где эта версия классификации стояла рядом
     * с другим маршрутизатором, ничего не говорит о том, что получится
     * сейчас.
     */
    await seedPrompt(testDb(), {
      stage: 'router',
      version: 'router@2',
      prompt: 'Раздели на отрезки.',
      schemaName: ROUTER_SCHEMA_NAME,
    });
    await activatePrompt(testDb(), 'router', 'router@2');

    await writeRun({
      name: 'a.json',
      versions: { classifier: 'classifier@2', router: 'router@9' },
    });

    const outcome = await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok ? outcome.refused.reasons.join(' ') : '').toContain('router');
  });
});

describe('признание вместо предупреждения', () => {
  it('с явным признанием включить можно', async () => {
    /**
     * Заслон, который нельзя обойти вовсе, однажды снимут целиком —
     * вместе с защитой. Обойти можно, но только назвав вещи своими
     * именами.
     */
    const outcome = await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
      acknowledged: true,
    });

    expect(outcome.ok).toBe(true);

    const [row] = await testDb()
      .select({ isActive: promptVersions.isActive })
      .from(promptVersions)
      .where(eq(promptVersions.version, 'classifier@2'));

    expect(row?.isActive).toBe(true);
  });

  it('и признание записывается в версию навсегда', async () => {
    /**
     * Через месяц при разборе «почему стало хуже» будет видно, что
     * версию включили, зная, что набор не прогнан. Без этой записи
     * признание — пустой клик.
     */
    await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
      acknowledged: true,
      now: new Date('2026-09-07T10:00:00.000Z'),
    });

    const [row] = await testDb()
      .select({ note: promptVersions.note })
      .from(promptVersions)
      .where(eq(promptVersions.version, 'classifier@2'));

    expect(row?.note).toContain('без прогона');
    expect(row?.note).toContain('аня');
    expect(row?.note).toContain('2026-09-07');
  });

  it("повторное включение не множит пометку", async () => {
    /**
     * Откатились и вернулись обратно тем же днём — пометка та же.
     * Примечание, в которое одно и то же дописывается десять раз,
     * перестают читать, а вместе с ним перестают читать и остальное.
     */
    const twice = {
      stage: "classifier" as const,
      version: "classifier@2",
      evalDir,
      by: "аня",
      acknowledged: true,
      now: new Date("2026-09-07T10:00:00.000Z"),
    };

    await activateVersion(testDb(), twice);
    await activatePrompt(testDb(), "classifier", "classifier@1");
    await activateVersion(testDb(), twice);

    const [row] = await testDb()
      .select({ note: promptVersions.note })
      .from(promptVersions)
      .where(eq(promptVersions.version, "classifier@2"));

    expect(row?.note?.match(/без прогона/gu)).toHaveLength(1);
  });

  it('у прогнанной версии такой записи не появляется', async () => {
    // Иначе пометка обесценится: она должна означать ровно одно.
    await writeRun({ name: 'a.json', versions: { classifier: 'classifier@2' } });

    await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
      acknowledged: true,
    });

    const [row] = await testDb()
      .select({ note: promptVersions.note })
      .from(promptVersions)
      .where(eq(promptVersions.version, 'classifier@2'));

    expect(row?.note ?? '').not.toContain('без прогона');
  });
});

describe('откат возвращает и промпт, и схему — условие готовности 4.8', () => {
  it('после отката реестр отдаёт прежний текст и прежнюю схему', async () => {
    /**
     * **Условие готовности задачи дословно.** Схема хранится вместе с
     * версией не для красоты: реестр сверяет её с кодом и отказывается
     * работать при расхождении. Откат, вернувший текст, но не схему,
     * уронил бы разбор ответа — и не сразу, а на первом же вызове.
     */
    await writeRun({ name: 'a.json', versions: { classifier: 'classifier@2' } });
    await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
    });

    const after = await new PromptRegistry(testDb(), 0).get('classifier');
    expect(after.version).toBe('classifier@2');

    // Откат на прежнюю: прогон на неё есть — пишем свежий отчёт.
    await writeRun({ name: 'b.json', versions: { classifier: 'classifier@1' } });

    const back = await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@1',
      evalDir,
      by: 'аня',
    });

    expect(back.ok).toBe(true);

    const rolled = await new PromptRegistry(testDb(), 0).get('classifier');

    expect(rolled.version).toBe('classifier@1');
    expect(rolled.prompt).toBe('Разбери мысли на записи.');
    // И схема — та, что записана с версией: реестр поднял её без жалоб.
    expect(rolled.schemaName).toBe(CLASSIFIER_SCHEMA_NAME);
    expect(rolled.jsonSchema).toBeDefined();
  });

  it('двух включённых версий одного этапа не бывает', async () => {
    // Две активные — это разбор, который ведёт себя по-разному от
    // вызова к вызову, и найти такое потом почти невозможно.
    await writeRun({ name: 'a.json', versions: { classifier: 'classifier@2' } });
    await activateVersion(testDb(), {
      stage: 'classifier',
      version: 'classifier@2',
      evalDir,
      by: 'аня',
    });

    const active = await testDb()
      .select({ version: promptVersions.version })
      .from(promptVersions)
      .where(and(eq(promptVersions.stage, 'classifier'), eq(promptVersions.isActive, true)));

    expect(active).toHaveLength(1);
    expect(active[0]?.version).toBe('classifier@2');
  });
});

describe('стадии, которые набор не мерит', () => {
  it('представление включается без прогона — измерителя для него нет', async () => {
    /**
     * Набор мерит **разбор**, а не ответ. Требовать прогона там, где
     * мерить нечем, значило бы сделать заслон невыполнимым — а
     * невыполнимый заслон снимают целиком.
     *
     * Это послабление, и оно записано: промпт представления меняется
     * без измерения, и об этом надо помнить.
     */
    await seedPrompt(testDb(), {
      stage: 'presenter',
      version: 'presenter@1',
      prompt: 'Ответь коротко.',
      schemaName: PRESENTER_SCHEMA_NAME,
    });

    const outcome = await activateVersion(testDb(), {
      stage: 'presenter',
      version: 'presenter@1',
      evalDir,
      by: 'аня',
    });

    expect(outcome.ok).toBe(true);
  });

  it('а маршрутизатор — не включается', async () => {
    await seedPrompt(testDb(), {
      stage: 'router',
      version: 'router@9',
      prompt: 'Раздели на отрезки.',
      schemaName: ROUTER_SCHEMA_NAME,
    });

    const outcome = await activateVersion(testDb(), {
      stage: 'router',
      version: 'router@9',
      evalDir,
      by: 'аня',
    });

    expect(outcome.ok).toBe(false);
  });
});

describe("у резолвера свой набор — и панель его спрашивает", () => {
  /**
   * Дыра, найденная проверкой на представлении: набор разбора резолвера
   * не мерит, но у резолвера **есть** свой набор — со своим отчётом и
   * своим порогом «ноль ложных применений». Пока эта проверка жила
   * только в скрипте заливки, панель включала промпт резолвера вообще
   * без измерения. §7.3 называет цену такой ошибки прямо: бот молча
   * правит не ту запись человека.
   */

  beforeEach(async () => {
    await seedPrompt(testDb(), {
      stage: "resolver",
      version: "resolver@7",
      prompt: "Реши, что делать с репликой.",
      schemaName: RESOLVER_SCHEMA_NAME,
    });
  });

  it("без прогона своего набора не включается", async () => {
    // Прогон разбора есть и он про resolver@7 — не помогает: его мерил
    // не тот набор.
    await writeRun({ name: "a.json", versions: { resolver: "resolver@7" } });

    const outcome = await activateVersion(testDb(), {
      stage: "resolver",
      version: "resolver@7",
      evalDir,
      by: "аня",
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok ? outcome.refused.reasons.join(" ") : "").toContain(
      "резолвера",
    );
  });

  it("прогон своего набора на другой версии не считается", async () => {
    await writeResolverRun({ name: "a.json", version: "resolver@6" });

    const outcome = await activateVersion(testDb(), {
      stage: "resolver",
      version: "resolver@7",
      evalDir,
      by: "аня",
    });

    expect(outcome.ok).toBe(false);
  });

  it("прогон не прошёл порог — тоже нельзя", async () => {
    await writeResolverRun({
      name: "a.json",
      version: "resolver@7",
      good: false,
    });

    const outcome = await activateVersion(testDb(), {
      stage: "resolver",
      version: "resolver@7",
      evalDir,
      by: "аня",
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok ? outcome.refused.reasons.join(" ") : "").toContain(
      "порог",
    );
  });

  it("прогнанная своим набором версия включается", async () => {
    await writeResolverRun({ name: "a.json", version: "resolver@7" });

    const outcome = await activateVersion(testDb(), {
      stage: "resolver",
      version: "resolver@7",
      evalDir,
      by: "аня",
    });

    expect(outcome.ok).toBe(true);
  });
});
