import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { topics } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { settleTopics } from './ensure.js';
import {
  DEFAULT_TOPIC_NAMES,
  ensureTopics,
  FALLBACK_TOPIC,
  listTopics,
  topicsFor,
} from './topics.repo.js';

/**
 * Сферы заводятся только под содержимое (заказчица, 16.09.2026).
 *
 * Её слова по видео: «про здоровье ничего не говорила, про личное тоже,
 * а он сразу насоздавал много тем… кто не в теме — зачем это?». Базовый
 * набор из пяти сфер на первой выгрузке убран: сфера появляется вместе с
 * первой записью в неё. Список базовых имён остаётся подсказкой модели.
 */
let userId = '';

beforeEach(async () => {
  userId = (await upsertUser(testDb(), { tgId: 777_101, firstName: 'Аня' })).id;
});

async function names(): Promise<readonly string[]> {
  return (await listTopics(testDb(), userId)).map((topic) => topic.name);
}

describe('ensureTopics', () => {
  it('заводит только названные сферы, существующие не трогает', async () => {
    await ensureTopics(testDb(), userId, ['работа'], 8);

    const round = await ensureTopics(testDb(), userId, ['работа', 'покупки'], 8);

    expect(round.created).toEqual(['покупки']);
    expect([...round.present].sort()).toEqual(['покупки', 'работа']);
    expect(await names()).toEqual(['работа', 'покупки']);
  });

  it('«личное», заведённое под запись, становится темой по умолчанию', async () => {
    await ensureTopics(testDb(), userId, [FALLBACK_TOPIC], 8);

    const [row] = await testDb().select().from(topics).where(eq(topics.userId, userId));
    expect(row?.name).toBe(FALLBACK_TOPIC);
    expect(row?.isDefault).toBe(true);
  });

  it('предел держится, а тема по умолчанию заводится и сверх него', async () => {
    const round = await ensureTopics(testDb(), userId, ['здоровье', 'покупки', FALLBACK_TOPIC], 1);

    expect(round.created).toEqual(['здоровье', FALLBACK_TOPIC]);
    expect(round.present.has('покупки')).toBe(false);
    expect(await names()).toEqual(['здоровье', FALLBACK_TOPIC]);
  });
});

describe('settleTopics', () => {
  it('записи получают свои сферы, а не поместившиеся под предел — в тему по умолчанию', async () => {
    const settled = await settleTopics(testDb(), {
      userId,
      units: [
        { text: 'сдать анализы', topic: 'здоровье' },
        { text: 'купить кофе', topic: 'покупки' },
      ],
      defaultTopic: FALLBACK_TOPIC,
      maxTopics: 1,
    });

    expect(settled.units.map((unit) => unit.topic)).toEqual(['здоровье', FALLBACK_TOPIC]);
    expect(await names()).toEqual(['здоровье', FALLBACK_TOPIC]);
  });

  it('без записей ничего не заводит', async () => {
    const settled = await settleTopics(testDb(), {
      userId,
      units: [],
      defaultTopic: FALLBACK_TOPIC,
      maxTopics: 8,
    });

    expect(settled.units).toEqual([]);
    expect(await names()).toEqual([]);
  });
});

describe('topicsFor — подсказка модели', () => {
  it('базовые имена остаются в списке рядом со своими, пока сфер мало', async () => {
    /**
     * Сферы больше не заводятся заранее, но модели по-прежнему нужен
     * ориентир: без базовых имён вторая выгрузка выбирала бы из одной
     * «здоровье», и «купить продукты» ложилось бы туда или в общую.
     */
    await ensureTopics(testDb(), userId, ['здоровье'], 8);

    const list = await topicsFor(testDb(), userId);

    expect(list.own).toBe(true);
    expect(list.names).toEqual([
      'здоровье',
      ...DEFAULT_TOPIC_NAMES.filter((name) => name !== 'здоровье'),
    ]);
    // Тема по умолчанию — «личное», даже пока её ещё нет.
    expect(list.defaultName).toBe(FALLBACK_TOPIC);
  });

  it('своя тема по умолчанию сильнее «личного»', async () => {
    await ensureTopics(testDb(), userId, [FALLBACK_TOPIC], 8);
    await ensureTopics(testDb(), userId, ['дом'], 8);

    const list = await topicsFor(testDb(), userId);

    expect(list.defaultName).toBe(FALLBACK_TOPIC);
    expect(list.names.slice(0, 2)).toEqual([FALLBACK_TOPIC, 'дом']);
  });
});
