import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { topics } from '../../db/schema.js';
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

describe('другая форма имени — та же сфера (бой 26.09.2026, 02:03)', () => {
  it('«покупка» при своей «покупки» не заводится: сфера уже есть', async () => {
    await ensureTopics(testDb(), userId, ['семья', 'покупки']);

    const result = await appendTopics(testDb(), userId, ['покупка']);

    expect(result).toEqual({ added: [], limited: false });
    expect(await names()).toEqual(['семья', 'покупки']);
  });

  it('выключенная сфера по согласию возвращается и под другой формой, а не заводится второй', async () => {
    // Путь согласия человека (задача 3.43): архивная «покупки» и просьба
    // «покупка» — вернуть её, а не завести рядом вторую.
    await ensureTopics(testDb(), userId, ['семья', 'покупки']);
    await testDb()
      .update(topics)
      .set({ isArchived: true })
      .where(and(eq(topics.userId, userId), eq(topics.name, 'покупки')));

    const result = await appendTopics(testDb(), userId, ['покупка']);

    expect(result.added).toEqual(['покупки']);
    expect(await names()).toEqual(['семья', 'покупки']);
  });

  it('две формы в одном добавлении — одна сфера', async () => {
    await ensureTopics(testDb(), userId, ['семья']);

    const result = await appendTopics(testDb(), userId, ['финансы', 'финансов']);

    expect(result.added).toEqual(['финансы']);
    expect(await names()).toEqual(['семья', 'финансы']);
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
