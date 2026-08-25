import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, items, promptVersions } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { embedText, findSimilarItems, setItemEmbedding } from './embedder.service.js';
import { MockEmbeddingProvider } from './providers/mock.js';
import { TransientEmbeddingError } from './providers/types.js';

/**
 * Смысловой поиск на живом pgvector.
 *
 * Условие готовности задачи 2.9: осмысленный результат за разумное время
 * на десяти тысячах записей.
 *
 * План разработки предупреждал не доверять индексу по умолчанию — и был
 * прав сильнее, чем предполагалось. Проверка показала, что HNSW при
 * фильтре по пользователю возвращает пустоту вместо существующей записи.
 * Последний тест в этом файле — тот самый случай, и он же охраняет
 * решение искать точно.
 */

const logger = createLogger({ level: 'silent' });
const DIMENSIONS = 256;

let userId: string;
let otherUserId: string;

/** Вектор, у которого заданы первые значения, остальное нули. */
function vector(...head: number[]): number[] {
  const full = new Array<number>(DIMENSIONS).fill(0);
  head.forEach((value, index) => {
    full[index] = value;
  });
  return full;
}

async function addItem(owner: string, text: string, embedding: number[] | null): Promise<string> {
  const [row] = await testDb()
    .insert(items)
    .values({
      userId: owner,
      text,
      type: 'TASK',
      priority: 'SOON',
      topic: 'личное',
      embedding,
    })
    .returning({ id: items.id });

  return row!.id;
}

beforeEach(async () => {
  await testDb().delete(promptVersions);
  await testDb().delete(aiCalls);

  const user = await upsertUser(testDb(), { tgId: 950, firstName: 'Аня' });
  userId = user.id;
  const other = await upsertUser(testDb(), { tgId: 951, firstName: 'Не Аня' });
  otherUserId = other.id;
});

describe('embedText', () => {
  it('считает вектор и записывает расход', async () => {
    // §10.5 ТЗ: без этой строки учёт неполон, а себестоимость выгрузки
    // на задаче 2.21 окажется занижена.
    const provider = new MockEmbeddingProvider();

    const result = await embedText(
      { db: testDb(), provider, logger },
      { text: 'записаться к врачу', purpose: 'document', userId },
    );

    expect(result).toHaveLength(DIMENSIONS);

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.stage).toBe('embedder');
    expect(call?.model).toBe('mock-embedding');
    expect(call?.tokensIn).toBeGreaterThan(0);
    expect(call?.ok).toBe(true);
  });

  it('временный сбой повторяется', async () => {
    const provider = new MockEmbeddingProvider({
      failFirst: { times: 1, error: new TransientEmbeddingError('сеть моргнула') },
    });

    const result = await embedText(
      {
        db: testDb(),
        provider,
        logger,
        retry: { attempts: 2, sleep: () => Promise.resolve() },
      },
      { text: 'дело', purpose: 'document' },
    );

    expect(result).toHaveLength(DIMENSIONS);
    expect(provider.callCount).toBe(2);
  });

  it('полный отказ записывается в учёт', async () => {
    const provider = new MockEmbeddingProvider({
      failFirst: { times: 10, error: new TransientEmbeddingError('недоступно') },
    });

    await expect(
      embedText(
        { db: testDb(), provider, logger, retry: { attempts: 1, sleep: () => Promise.resolve() } },
        { text: 'дело', purpose: 'document' },
      ),
    ).rejects.toBeInstanceOf(TransientEmbeddingError);

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.ok).toBe(false);
  });
});

describe('findSimilarItems', () => {
  it('находит близкое по смыслу и сортирует по близости', async () => {
    const near = await addItem(userId, 'записаться к врачу', vector(1, 0, 0));
    const middle = await addItem(userId, 'купить продукты', vector(0.7, 0.7, 0));
    const far = await addItem(userId, 'сверить кассу', vector(0, 0, 1));

    const found = await findSimilarItems(testDb(), { userId, vector: vector(1, 0, 0) });

    expect(found.map((row) => row.id)).toEqual([near, middle, far]);
    // Совпадение по смыслу — единица.
    expect(found[0]?.similarity).toBeCloseTo(1, 5);
    expect(found[2]?.similarity).toBeCloseTo(0, 5);
  });

  it('чужие записи не находит ни при каких условиях', async () => {
    // Фильтр по пользователю стоит первым: чужая запись не должна попасть
    // в поиск даже при ошибке в остальных условиях.
    await addItem(otherUserId, 'чужое дело', vector(1, 0, 0));
    const mine = await addItem(userId, 'моё дело', vector(1, 0, 0));

    const found = await findSimilarItems(testDb(), { userId, vector: vector(1, 0, 0) });

    expect(found.map((row) => row.id)).toEqual([mine]);
  });

  it('записи без вектора пропускает', async () => {
    await addItem(userId, 'без вектора', null);
    const withVector = await addItem(userId, 'с вектором', vector(1, 0, 0));

    const found = await findSimilarItems(testDb(), { userId, vector: vector(1, 0, 0) });

    expect(found.map((row) => row.id)).toEqual([withVector]);
  });

  it('черновики и закрытые записи в поиск не идут', async () => {
    // §7.2 говорит об активных записях: предлагать правку к выполненному
    // делу или к неразобранному черновику незачем.
    const active = await addItem(userId, 'активное', vector(1, 0, 0));

    await testDb()
      .insert(items)
      .values({
        userId,
        text: 'черновик',
        isDraft: true,
        embedding: vector(1, 0, 0),
      });
    await testDb()
      .insert(items)
      .values({
        userId,
        text: 'выполненное',
        type: 'TASK',
        priority: 'SOON',
        topic: 'личное',
        status: 'done',
        embedding: vector(1, 0, 0),
      });

    const found = await findSimilarItems(testDb(), { userId, vector: vector(1, 0, 0) });

    expect(found.map((row) => row.id)).toEqual([active]);
  });

  it('сужает поиск до темы, если сообщение пришло в ветку (§8.1 ТЗ)', async () => {
    const health = await addItem(userId, 'к врачу', vector(1, 0, 0));
    await testDb()
      .update(items)
      .set({ topic: 'здоровье' })
      .where(sql`${items.id} = ${health}`);
    await addItem(userId, 'кассу сверить', vector(1, 0, 0));

    const found = await findSimilarItems(testDb(), {
      userId,
      vector: vector(1, 0, 0),
      topic: 'здоровье',
    });

    expect(found.map((row) => row.id)).toEqual([health]);
  });

  it('соблюдает предел количества', async () => {
    for (let index = 0; index < 5; index++) {
      await addItem(userId, `дело ${String(index)}`, vector(1, index / 10, 0));
    }

    expect(
      await findSimilarItems(testDb(), { userId, vector: vector(1, 0, 0), limit: 2 }),
    ).toHaveLength(2);
  });

  it('на пустой базе возвращает пусто, а не падает', async () => {
    expect(await findSimilarItems(testDb(), { userId, vector: vector(1, 0, 0) })).toEqual([]);
  });
});

describe('setItemEmbedding', () => {
  it('дописывает вектор к существующей записи', async () => {
    // Нужно досчёту: если записи появились до задачи 2.9, векторов у них нет.
    const id = await addItem(userId, 'без вектора', null);

    await setItemEmbedding(testDb(), id, vector(1, 0, 0));

    const found = await findSimilarItems(testDb(), { userId, vector: vector(1, 0, 0) });
    expect(found.map((row) => row.id)).toEqual([id]);
  });
});

describe('десять тысяч записей', () => {
  it('поиск отдаёт нужное за разумное время', async () => {
    // Условие готовности задачи 2.9. Векторы синтетические: здесь
    // проверяется время и корректность, а осмысленность близости — на
    // живой модели в контрольном наборе (задача 2.19).
    await testDb().execute(sql`
      insert into items (user_id, text, type, priority, topic, embedding)
      select ${userId}, 'дело ' || i, 'TASK', 'SOON', 'личное',
        ('[' || (i % 100)::text || ',' || (i % 97)::text || ',' || (i % 89)::text
          || ',' || repeat('0,', 252) || '0]')::vector(256)
      from generate_series(1, 10000) i
    `);

    const target = await addItem(userId, 'нужная запись', vector(0, 0, 0, 1));

    // Без свежей статистики планировщик выбирает план по устаревшей
    // оценке числа строк. В бою за этим следит автоочистка, в тесте —
    // мы сами, иначе измеряли бы не то.
    await testDb().execute(sql`analyze items`);

    const startedAt = Date.now();
    const found = await findSimilarItems(testDb(), {
      userId,
      vector: vector(0, 0, 0, 1),
      limit: 5,
    });
    const elapsed = Date.now() - startedAt;

    expect(found[0]?.id).toBe(target);
    expect(found[0]?.similarity).toBeCloseTo(1, 5);
    // «Разумное время» на десяти тысячах — десятки миллисекунд.
    expect(elapsed).toBeLessThan(1_000);
  }, 60_000);

  it('чужие записи не вытесняют свои из выборки', async () => {
    // Ровно то, на чём сломался HNSW: он искал ближайших по всей таблице,
    // а фильтр по пользователю применялся после — и человек получал
    // пустой ответ при том, что подходящая запись у него была.
    //
    // Худший случай построен намеренно: десять тысяч чужих записей стоят
    // ровно на векторе запроса, а единственная своя — чуть в стороне.
    await testDb().execute(sql`
      insert into items (user_id, text, type, priority, topic, embedding)
      select ${otherUserId}, 'чужое ' || i, 'TASK', 'SOON', 'личное',
        ('[1,' || repeat('0,', 254) || '0]')::vector(256)
      from generate_series(1, 10000) i
    `);

    const mine = await addItem(userId, 'моё единственное', vector(0.9, 0.44));
    await testDb().execute(sql`analyze items`);

    const found = await findSimilarItems(testDb(), {
      userId,
      vector: vector(1),
      limit: 5,
    });

    expect(found.map((row) => row.id)).toEqual([mine]);
  }, 60_000);
});
