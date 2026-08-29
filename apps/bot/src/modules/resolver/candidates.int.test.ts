import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { items } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { setItemEmbedding } from '../embedder/embedder.service.js';
import { upsertUser } from '../users/users.repo.js';
import { collectCandidates, type Candidate } from './candidates.js';

/**
 * Подбор кандидатов из трёх источников (§7.2 ТЗ, задача 3.1).
 *
 * План требует проверить каждый источник отдельно и объединение с
 * дедупликацией. Здесь и то, и другое — плюс два свойства, о которых
 * молчать нельзя: чужие записи не попадают в список ни при какой ошибке
 * в условиях, а сообщение внутри ветки сужает поиск до её темы (§8.1).
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');
const MINUTE = 60_000;

let userId = '';
let strangerId = '';
let seq = 0;

/** Единичный вектор: близость к самому себе — единица, к соседнему — ноль. */
function axis(index: number): number[] {
  return Array.from({ length: 256 }, (_unused, position) => (position === index ? 1 : 0));
}

interface Sown {
  readonly text: string;
  readonly topic?: string;
  readonly minutesAgo?: number;
  readonly deadline?: Date | null;
  readonly status?: 'new' | 'done';
  readonly draft?: boolean;
  readonly vector?: number[];
  readonly owner?: string;
}

async function sow(seed: Sown): Promise<string> {
  const owner = seed.owner ?? userId;
  const updatedAt = new Date(NOW.getTime() - (seed.minutesAgo ?? 1) * MINUTE);

  const [row] = await testDb()
    .insert(items)
    .values(
      seed.draft === true
        ? { userId: owner, text: seed.text, isDraft: true, updatedAt }
        : {
            userId: owner,
            text: seed.text,
            type: 'TASK',
            priority: 'SOON',
            topic: seed.topic ?? 'личное',
            status: seed.status ?? 'new',
            deadlineAt: seed.deadline ?? null,
            // Схема требует точность рядом со сроком: срок без неё
            // напоминание поставит не туда.
            deadlineAccuracy: seed.deadline === undefined ? null : 'day',
            updatedAt,
          },
    )
    .returning({ id: items.id });

  const id = row?.id ?? '';

  if (seed.vector !== undefined) {
    // Вектор ставится до времени, а не после: `setItemEmbedding` подтягивает
    // `updated_at` к «сейчас», и заданная давность иначе теряется.
    await setItemEmbedding(testDb(), id, seed.vector);
    await testDb().update(items).set({ updatedAt }).where(eq(items.id, id));
  }

  return id;
}

function textsOf(found: readonly Candidate[]): string[] {
  return found.map((candidate) => candidate.text);
}

beforeEach(async () => {
  seq++;
  const user = await upsertUser(testDb(), { tgId: 9100 + seq, firstName: '女' });
  const stranger = await upsertUser(testDb(), { tgId: 9500 + seq, firstName: 'Чужая' });
  userId = user.id;
  strangerId = stranger.id;
});

describe('источник 1: короткая память сессии', () => {
  it('берёт тронутое недавно и не берёт старое', async () => {
    // §7.2: «именно этот источник закрывает сценарий с врачом и пятницей».
    await sow({ text: 'Записать сына к врачу в четверг', minutesAgo: 2 });
    await sow({ text: 'Купить корм коту', minutesAgo: 60 * 30 });

    const found = await collectCandidates(testDb(), { userId, now: NOW });

    expect(textsOf(found)).toEqual(['Записать сына к врачу в четверг']);
    expect(found[0]?.sources).toEqual(['session']);
    // Близость не мерили — это не ноль. Ноль значил бы «мерили и не похоже».
    expect(found[0]?.similarity).toBeNull();
  });

  it('свежие идут первыми', async () => {
    await sow({ text: 'старое', minutesAgo: 300 });
    await sow({ text: 'свежее', minutesAgo: 1 });
    await sow({ text: 'среднее', minutesAgo: 60 });

    const found = await collectCandidates(testDb(), { userId, now: NOW });

    expect(textsOf(found)).toEqual(['свежее', 'среднее', 'старое']);
  });

  it('предел числа записей соблюдается', async () => {
    for (let index = 0; index < 5; index++) {
      await sow({ text: `дело ${String(index)}`, minutesAgo: index + 1 });
    }

    const found = await collectCandidates(testDb(), {
      userId,
      now: NOW,
      limits: { session: 3 },
    });

    expect(found).toHaveLength(3);
  });

  it('черновики и закрытые записи не предлагаются', async () => {
    // Черновик сам ждёт разбора, поправлять в нём нечего. Закрытую
    // запись §7.2 к поиску не относит: искать надо среди живых.
    await sow({ text: 'черновик', draft: true, minutesAgo: 1 });
    await sow({ text: 'закрытое', status: 'done', minutesAgo: 1 });
    await sow({ text: 'живое', minutesAgo: 1 });

    const found = await collectCandidates(testDb(), { userId, now: NOW });

    expect(textsOf(found)).toEqual(['живое']);
  });
});

describe('источник 2: смысловой поиск', () => {
  it('находит близкое по вектору и возвращает близость', async () => {
    await sow({ text: 'похожее', minutesAgo: 60 * 30, vector: axis(0) });
    await sow({ text: 'непохожее', minutesAgo: 60 * 30, vector: axis(1) });

    const found = await collectCandidates(testDb(), {
      userId,
      now: NOW,
      vector: axis(0),
      limits: { semantic: 1 },
    });

    expect(textsOf(found)).toEqual(['похожее']);
    expect(found[0]?.similarity).toBeCloseTo(1, 5);
    expect(found[0]?.sources).toEqual(['semantic']);
  });

  it('без вектора источник просто молчит', async () => {
    // Вектор мог не посчитаться — это не повод ронять подбор: у сегмента
    // остаются два других источника.
    await sow({ text: 'дело', minutesAgo: 60 * 30, vector: axis(0) });

    expect(await collectCandidates(testDb(), { userId, now: NOW })).toEqual([]);
  });
});

describe('источник 3: совпадение по сроку', () => {
  const friday = new Date('2026-09-03T21:00:00.000Z');

  it('берёт записи со сроком в названном дне', async () => {
    await sow({ text: 'в пятницу', minutesAgo: 60 * 30, deadline: friday });
    await sow({
      text: 'в субботу',
      minutesAgo: 60 * 30,
      deadline: new Date('2026-09-04T21:00:00.000Z'),
    });
    await sow({ text: 'без срока', minutesAgo: 60 * 30 });

    const found = await collectCandidates(testDb(), {
      userId,
      now: NOW,
      period: { from: friday, to: new Date(friday.getTime() + 24 * 60 * MINUTE) },
    });

    expect(textsOf(found)).toEqual(['в пятницу']);
    expect(found[0]?.sources).toEqual(['deadline']);
  });

  it('без периода источник молчит', async () => {
    await sow({ text: 'в пятницу', minutesAgo: 60 * 30, deadline: friday });

    expect(await collectCandidates(testDb(), { userId, now: NOW })).toEqual([]);
  });
});

describe('объединение', () => {
  it('одна запись из трёх источников — один кандидат с тремя источниками', async () => {
    const friday = new Date('2026-09-03T21:00:00.000Z');

    await sow({ text: 'к врачу', minutesAgo: 2, deadline: friday, vector: axis(0) });

    const found = await collectCandidates(testDb(), {
      userId,
      now: NOW,
      vector: axis(0),
      period: { from: friday, to: new Date(friday.getTime() + 24 * 60 * MINUTE) },
    });

    expect(found).toHaveLength(1);
    expect(found[0]?.sources).toEqual(['session', 'semantic', 'deadline']);
    // Близость не теряется оттого, что запись нашлась ещё и по свежести.
    expect(found[0]?.similarity).toBeCloseTo(1, 5);
  });

  it('разные записи из разных источников собираются вместе', async () => {
    await sow({ text: 'свежая', minutesAgo: 2 });
    await sow({ text: 'похожая', minutesAgo: 60 * 30, vector: axis(0) });

    const found = await collectCandidates(testDb(), { userId, now: NOW, vector: axis(0) });

    expect(textsOf(found).sort()).toEqual(['похожая', 'свежая']);
  });
});

describe('границы, которые нельзя переступать', () => {
  it('чужие записи не попадают ни одним источником', async () => {
    const friday = new Date('2026-09-03T21:00:00.000Z');

    await sow({ text: 'чужая свежая', minutesAgo: 1, owner: strangerId });
    await sow({ text: 'чужая похожая', minutesAgo: 1, owner: strangerId, vector: axis(0) });
    await sow({ text: 'чужая по сроку', minutesAgo: 1, owner: strangerId, deadline: friday });

    const found = await collectCandidates(testDb(), {
      userId,
      now: NOW,
      vector: axis(0),
      period: { from: friday, to: new Date(friday.getTime() + 24 * 60 * MINUTE) },
    });

    expect(found).toEqual([]);
  });

  it('сообщение внутри ветки сужает поиск до её темы (§8.1)', async () => {
    await sow({ text: 'из здоровья', topic: 'здоровье', minutesAgo: 1, vector: axis(0) });
    await sow({ text: 'из личного', topic: 'личное', minutesAgo: 1, vector: axis(0) });

    const found = await collectCandidates(testDb(), {
      userId,
      now: NOW,
      vector: axis(0),
      topic: 'здоровье',
    });

    expect(textsOf(found)).toEqual(['из здоровья']);
  });
});
