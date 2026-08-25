import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { promptVersions } from '../../../db/schema.js';
import { testDb } from '../../../test/db.js';
import { EXTRACTOR_SCHEMA_NAME } from '../schemas/index.js';
import {
  PromptNotFoundError,
  PromptRegistry,
  SchemaMismatchError,
  loadActivePrompt,
} from './registry.js';
import { PromptVersionConflictError, activatePrompt, seedPrompt } from './seed.js';

/**
 * Хранение и версионирование промптов на живой базе.
 *
 * Проверяется не «функция вернула объект», а поведение, от которого
 * зависит разбор: активная версия одна, откат промпта без схемы не
 * проходит, опубликованная версия не подменяется молча.
 */

const definition = {
  stage: 'extractor' as const,
  version: 'extractor@1',
  prompt: 'Разбери поток мыслей на отдельные дела.',
  schemaName: EXTRACTOR_SCHEMA_NAME,
  note: 'первая версия',
};

beforeEach(async () => {
  await testDb().delete(promptVersions);
});

describe('seedPrompt', () => {
  it('заливает версию и выводит JSON Schema из кода', async () => {
    const result = await seedPrompt(testDb(), definition);

    expect(result.created).toBe(true);

    const [row] = await testDb().select().from(promptVersions);
    expect(row?.version).toBe('extractor@1');
    expect(row?.schemaName).toBe(EXTRACTOR_SCHEMA_NAME);
    // Схема не придумана руками, а порождена из Zod-описания.
    expect(row?.schemaJson).toMatchObject({ type: 'object' });
    // Залитая версия не активна сама по себе: включают её отдельно.
    expect(row?.isActive).toBe(false);
  });

  it('повторная заливка того же не создаёт дубля', async () => {
    await seedPrompt(testDb(), definition);
    const second = await seedPrompt(testDb(), definition);

    expect(second.created).toBe(false);
    expect(await testDb().select().from(promptVersions)).toHaveLength(1);
  });

  it('не подменяет опубликованную версию молча', async () => {
    // Иначе жалоба «неделю назад бот отвечал лучше» становится
    // непроверяемой: той версии больше не существует.
    await seedPrompt(testDb(), definition);

    await expect(
      seedPrompt(testDb(), { ...definition, prompt: 'другой текст' }),
    ).rejects.toBeInstanceOf(PromptVersionConflictError);
  });

  it('отказывается заливать версию с неизвестной схемой', async () => {
    // Такая версия не поднимется при загрузке, и узнать об этом лучше
    // при заливке.
    await expect(
      seedPrompt(testDb(), { ...definition, schemaName: 'нет-такой-схемы' }),
    ).rejects.toThrow(/не найдена/u);
  });
});

describe('activatePrompt', () => {
  it('делает версию активной', async () => {
    await seedPrompt(testDb(), definition);
    await activatePrompt(testDb(), 'extractor', 'extractor@1');

    const [row] = await testDb().select().from(promptVersions);
    expect(row?.isActive).toBe(true);
  });

  it('снимает признак с прежней активной', async () => {
    // Две активные версии одного этапа — это разбор, который ведёт себя
    // по-разному от вызова к вызову.
    await seedPrompt(testDb(), definition);
    await seedPrompt(testDb(), { ...definition, version: 'extractor@2', prompt: 'вторая' });

    await activatePrompt(testDb(), 'extractor', 'extractor@1');
    await activatePrompt(testDb(), 'extractor', 'extractor@2');

    const active = await testDb()
      .select({ version: promptVersions.version })
      .from(promptVersions)
      .where(eq(promptVersions.isActive, true));

    expect(active).toEqual([{ version: 'extractor@2' }]);
  });

  it('не включает версию, которой нет', async () => {
    await expect(activatePrompt(testDb(), 'extractor', 'extractor@99')).rejects.toThrow(
      /нет в базе/u,
    );
  });
});

describe('loadActivePrompt', () => {
  it('отдаёт промпт вместе со схемой и валидатором', async () => {
    await seedPrompt(testDb(), definition);
    await activatePrompt(testDb(), 'extractor', 'extractor@1');

    const active = await loadActivePrompt(testDb(), 'extractor');

    expect(active.version).toBe('extractor@1');
    expect(active.prompt).toBe(definition.prompt);
    expect(active.jsonSchema).toMatchObject({ type: 'object' });
    // Валидатор пришёл из кода и работает.
    expect(active.schema.safeParse({ units: [] }).success).toBe(true);
    expect(active.schema.safeParse({ units: 'не массив' }).success).toBe(false);
  });

  it('без активной версии падает внятно, а не отдаёт пустоту', async () => {
    await seedPrompt(testDb(), definition);

    await expect(loadActivePrompt(testDb(), 'extractor')).rejects.toBeInstanceOf(
      PromptNotFoundError,
    );
  });

  it('ловит откат промпта без откката схемы', async () => {
    // Тот самый случай из задачи 2.2: разбор ответа сломался бы не сразу
    // и невнятно. Лучше не подняться вовсе.
    await seedPrompt(testDb(), definition);
    await activatePrompt(testDb(), 'extractor', 'extractor@1');

    await testDb()
      .update(promptVersions)
      .set({ schemaJson: { type: 'object', properties: { другое: { type: 'string' } } } })
      .where(eq(promptVersions.version, 'extractor@1'));

    await expect(loadActivePrompt(testDb(), 'extractor')).rejects.toBeInstanceOf(
      SchemaMismatchError,
    );
  });

  it('порядок ключей в схеме не считается расхождением', async () => {
    // Библиотека может переставить ключи при обновлении, а смысл схемы
    // при этом не меняется. Иначе обновление зависимости валило бы старт.
    await seedPrompt(testDb(), definition);
    await activatePrompt(testDb(), 'extractor', 'extractor@1');

    const [row] = await testDb().select().from(promptVersions);
    const shuffled = Object.fromEntries(
      Object.entries(row?.schemaJson as Record<string, unknown>).reverse(),
    );

    await testDb()
      .update(promptVersions)
      .set({ schemaJson: shuffled })
      .where(eq(promptVersions.version, 'extractor@1'));

    await expect(loadActivePrompt(testDb(), 'extractor')).resolves.toMatchObject({
      version: 'extractor@1',
    });
  });
});

describe('PromptRegistry', () => {
  it('не ходит в базу на каждый вызов', async () => {
    await seedPrompt(testDb(), definition);
    await activatePrompt(testDb(), 'extractor', 'extractor@1');

    const registry = new PromptRegistry(testDb(), 60_000);
    await registry.get('extractor', 1_000);

    // Активную версию подменили в базе, но кэш ещё свежий.
    await seedPrompt(testDb(), { ...definition, version: 'extractor@2', prompt: 'вторая' });
    await activatePrompt(testDb(), 'extractor', 'extractor@2');

    const cached = await registry.get('extractor', 1_500);
    expect(cached.version).toBe('extractor@1');
  });

  it('подхватывает правку, когда кэш устарел', async () => {
    // §15 ТЗ требует правки без выкладки. С бессрочным кэшем это
    // превратилось бы в «после перезапуска».
    await seedPrompt(testDb(), definition);
    await activatePrompt(testDb(), 'extractor', 'extractor@1');

    const registry = new PromptRegistry(testDb(), 60_000);
    await registry.get('extractor', 1_000);

    await seedPrompt(testDb(), { ...definition, version: 'extractor@2', prompt: 'вторая' });
    await activatePrompt(testDb(), 'extractor', 'extractor@2');

    const fresh = await registry.get('extractor', 100_000);
    expect(fresh.version).toBe('extractor@2');
  });

  it('сброс кэша действует немедленно: админка правит промпт сейчас', async () => {
    await seedPrompt(testDb(), definition);
    await activatePrompt(testDb(), 'extractor', 'extractor@1');

    const registry = new PromptRegistry(testDb(), 60_000);
    await registry.get('extractor', 1_000);

    await seedPrompt(testDb(), { ...definition, version: 'extractor@2', prompt: 'вторая' });
    await activatePrompt(testDb(), 'extractor', 'extractor@2');
    registry.forget('extractor');

    const fresh = await registry.get('extractor', 1_500);
    expect(fresh.version).toBe('extractor@2');
  });
});
