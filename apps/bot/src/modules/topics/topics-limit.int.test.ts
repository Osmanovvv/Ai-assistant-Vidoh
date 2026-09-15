import { beforeEach, describe, expect, it } from 'vitest';

import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import {
  appendTopics,
  DEFAULT_TOPIC_NAMES,
  ensureTopics,
  FALLBACK_TOPIC,
  listTopics,
  MAX_TOPICS,
} from './topics.repo.js';

/**
 * Предел числа тем (§6.4) — на обоих путях, которыми темы появляются.
 *
 * Путей два: сфера под запись (`ensureTopics`, с 16.09.2026 — вместо
 * базового набора на первой выгрузке) и сфера по содержанию
 * (`appendTopics` через `adopt.ts`). Тема по умолчанию — вне предела:
 * на ней §6.4 держит всё, что не попало ни в одну сферу, и без неё запись
 * потерялась бы.
 */
let userId = '';

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 777_001, firstName: 'Аня' });

  userId = user.id;
});

async function names(): Promise<readonly string[]> {
  return (await listTopics(testDb(), userId)).map((topic) => topic.name);
}

describe('предел числа тем под записи', () => {
  it('базовые имена под записи обрезаются до предела', async () => {
    await ensureTopics(testDb(), userId, ['семья', 'здоровье', 'работа', 'покупки'], 2);

    expect(await names()).toEqual(['семья', 'здоровье']);
  });

  it('умолчание из кода тоже предел', async () => {
    const nine = [
      'семья',
      'здоровье',
      'работа',
      'покупки',
      'дом',
      'дети',
      'деньги',
      'учёба',
      'спорт',
    ];
    await ensureTopics(testDb(), userId, nine);

    expect(await names()).toHaveLength(MAX_TOPICS);
  });

  it('тема по умолчанию заводится даже под самым тесным пределом', async () => {
    await ensureTopics(testDb(), userId, ['работа', FALLBACK_TOPIC], 1);

    expect(await names()).toEqual(['работа', FALLBACK_TOPIC]);
  });

  it('умолчание предела вмещает все базовые имена', async () => {
    await ensureTopics(testDb(), userId, [...DEFAULT_TOPIC_NAMES]);

    expect(await names()).toEqual([...DEFAULT_TOPIC_NAMES]);
  });
});

describe('предел один и тот же под записи и на добавлении сферы', () => {
  it('добавление сферы по содержанию упирается в тот же предел', async () => {
    await ensureTopics(testDb(), userId, ['семья', 'здоровье'], 3);

    const first = await appendTopics(testDb(), userId, ['дом'], 3);
    const second = await appendTopics(testDb(), userId, ['дети'], 3);

    expect(first).toEqual({ added: ['дом'], limited: false });
    expect(second).toEqual({ added: [], limited: true });
    expect(await names()).toHaveLength(3);
  });
});
