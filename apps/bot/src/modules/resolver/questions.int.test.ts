import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, pendingQuestions, type Item } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import {
  answerQuestion,
  askQuestion,
  closeOpenQuestion,
  expireQuestions,
  openQuestionOf,
  QUESTION_TTL_HOURS,
} from './questions.repo.js';

/**
 * Открытый уточняющий вопрос (§7.3 ТЗ, задача 3.5).
 *
 * План требует проверить три пути — ответ кнопкой, снятие новой
 * выгрузкой, таймаут — и нажатие устаревшей кнопки. Все четыре здесь.
 *
 * Общее у них одно: **сегмент не теряется ни в одном исходе**. §9.1 —
 * сказанное человеком не пропадает, и именно на этом стоит доверие к
 * продукту.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');
const HOUR = 60 * 60_000;

let userId = '';
let strangerId = '';
let item: Item;
let batchId = '';
let seq = 0;

const CHANGES = {
  note: '',
  text: '',
  deadline: '2026-09-04',
  deadlineAccuracy: 'day',
  recurrenceKind: 'none',
  recurrenceInterval: 0,
  recurrenceText: '',
} as const;

async function ask(now = NOW): Promise<string> {
  const question = await askQuestion(testDb(), {
    userId,
    itemId: item.id,
    batchId,
    segment: 'нет, в пятницу',
    action: 'update',
    changes: CHANGES,
    now,
  });

  return question.id;
}

beforeEach(async () => {
  seq++;
  userId = (await upsertUser(testDb(), { tgId: 9900 + seq, firstName: 'Оля' })).id;
  strangerId = (await upsertUser(testDb(), { tgId: 9950 + seq, firstName: 'Чужая' })).id;

  const [batch] = await testDb()
    .insert(batches)
    .values({ userId, status: 'processing' })
    .returning({ id: batches.id });

  batchId = batch?.id ?? '';

  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: 'Записать сына к врачу в четверг',
      type: 'TASK',
      priority: 'SOON',
      topic: 'здоровье',
    })
    .returning();

  if (!row) throw new Error('запись не создалась');
  item = row;
});

describe('вопрос заводится и хранит сказанное', () => {
  it('сегмент и изменения лежат рядом с вопросом', async () => {
    await ask();

    const open = await openQuestionOf(testDb(), userId, NOW);

    expect(open?.segment).toBe('нет, в пятницу');
    expect(open?.action).toBe('update');
    expect(open?.changes).toEqual(CHANGES);
    expect(open?.itemId).toBe(item.id);
  });

  it('срок жизни — шесть часов', async () => {
    await ask();

    const open = await openQuestionOf(testDb(), userId, NOW);

    expect(open?.expiresAt.getTime()).toBe(NOW.getTime() + QUESTION_TTL_HOURS * HOUR);
  });

  it('чужой вопрос не виден', async () => {
    await ask();

    expect(await openQuestionOf(testDb(), strangerId, NOW)).toBeUndefined();
  });
});

describe('одновременно висит не более одного', () => {
  it('новый вопрос снимает прежний', async () => {
    // Иначе это допрос, которого §7.3 не допускает.
    const first = await ask();
    const second = await ask(new Date(NOW.getTime() + 60_000));

    const rows = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first)?.outcome).toBe('superseded');
    expect(rows.find((row) => row.id === second)?.resolvedAt).toBeNull();
  });
});

describe('три пути, которыми вопрос кончается', () => {
  it('ответ кнопкой', async () => {
    const id = await ask();

    const outcome = await answerQuestion(testDb(), {
      questionId: id,
      userId,
      outcome: 'attached',
      now: NOW,
    });

    expect(outcome.kind).toBe('answered');
    expect(await openQuestionOf(testDb(), userId, NOW)).toBeUndefined();
  });

  it('снятие новой выгрузкой: сегмент останется новой записью', async () => {
    await ask();

    const closed = await closeOpenQuestion(testDb(), userId, 'superseded', NOW);

    // Сегмент никуда не делся — по нему заведут запись.
    expect(closed?.segment).toBe('нет, в пятницу');
    expect(await openQuestionOf(testDb(), userId, NOW)).toBeUndefined();
  });

  it('таймаут: через шесть часов вопрос сам перестаёт быть открытым', async () => {
    await ask();

    const later = new Date(NOW.getTime() + (QUESTION_TTL_HOURS + 1) * HOUR);

    expect(await openQuestionOf(testDb(), userId, later)).toBeUndefined();

    const [row] = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));

    expect(row?.outcome).toBe('timeout');
  });

  it('уборка протухших не ждёт, пока человек придёт', async () => {
    await ask();

    const later = new Date(NOW.getTime() + (QUESTION_TTL_HOURS + 1) * HOUR);

    expect(await expireQuestions(testDb(), later)).toBe(1);
    expect(await expireQuestions(testDb(), later)).toBe(0);
  });
});

describe('нажатие устаревшей кнопки', () => {
  it('второе нажатие отвечает «неактуально», а не падает', async () => {
    const id = await ask();

    await answerQuestion(testDb(), { questionId: id, userId, outcome: 'attached', now: NOW });
    const again = await answerQuestion(testDb(), {
      questionId: id,
      userId,
      outcome: 'attached',
      now: NOW,
    });

    expect(again.kind).toBe('stale');
  });

  it('кнопка вопроса, снятого новой выгрузкой, неактуальна', async () => {
    const id = await ask();
    await ask(new Date(NOW.getTime() + 60_000));

    const outcome = await answerQuestion(testDb(), {
      questionId: id,
      userId,
      outcome: 'attached',
      now: new Date(NOW.getTime() + 120_000),
    });

    expect(outcome.kind).toBe('stale');
  });

  it('кнопка протухшего вопроса неактуальна, даже если строка ещё открыта', async () => {
    const id = await ask();

    const outcome = await answerQuestion(testDb(), {
      questionId: id,
      userId,
      outcome: 'attached',
      now: new Date(NOW.getTime() + (QUESTION_TTL_HOURS + 1) * HOUR),
    });

    expect(outcome.kind).toBe('stale');
  });

  it('чужую кнопку нажать нельзя', async () => {
    const id = await ask();

    const outcome = await answerQuestion(testDb(), {
      questionId: id,
      userId: strangerId,
      outcome: 'attached',
      now: NOW,
    });

    expect(outcome.kind).toBe('stale');
    expect(await openQuestionOf(testDb(), userId, NOW)).toBeDefined();
  });
});

describe('вопрос не переживает свою запись', () => {
  it('удалили запись — вопрос про неё исчез', async () => {
    // Спрашивать «это про неё?» про то, чего нет, бессмысленно.
    await ask();
    await testDb().delete(items).where(eq(items.id, item.id));

    const rows = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));

    expect(rows).toEqual([]);
  });
});
