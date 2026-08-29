import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, pendingQuestions, type Item } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { askQuestion } from './questions.repo.js';
import { settlePendingQuestion } from './pending.js';

/**
 * Судьба открытого вопроса при новой выгрузке (§7.3 ТЗ, задача 3.6).
 *
 * «Готово, когда: голосовой ответ на вопрос обрабатывается так же, как
 * нажатие кнопки.» Значит проверять надо не чтение слов — оно проверено
 * отдельно, — а последствия: изменилась ли запись, снялся ли вопрос, не
 * пропало ли сказанное.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');
const MOSCOW = 'Europe/Moscow';

let userId = '';
let batchId = '';
let item: Item;
let seq = 0;

async function ask(): Promise<void> {
  await askQuestion(testDb(), {
    userId,
    itemId: item.id,
    batchId,
    segment: 'нет, в пятницу',
    action: 'update',
    changes: { text: '', deadline: '2026-09-04', deadlineAccuracy: 'day' },
    now: NOW,
  });
}

async function settle(answerText?: string) {
  return await settlePendingQuestion(testDb(), {
    userId,
    batchId,
    timeZone: MOSCOW,
    ...(answerText === undefined ? {} : { answerText }),
    now: NOW,
  });
}

async function reread(): Promise<Item> {
  const [row] = await testDb().select().from(items).where(eq(items.id, item.id));
  if (!row) throw new Error('запись пропала');
  return row;
}

async function draftTexts(): Promise<string[]> {
  const rows = await testDb().select().from(items).where(eq(items.isDraft, true));
  return rows.filter((row) => row.userId === userId).map((row) => row.text);
}

beforeEach(async () => {
  seq++;
  userId = (await upsertUser(testDb(), { tgId: 6100 + seq, firstName: 'Аня' })).id;

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

describe('без открытого вопроса ничего не происходит', () => {
  it('обычная выгрузка проходит мимо', async () => {
    expect((await settle()).kind).toBe('none');
    expect((await settle('да')).kind).toBe('none');
  });
});

describe('ответ голосом делает то же, что кнопка', () => {
  it('«да, к прошлой» применяет отложенное изменение', async () => {
    await ask();

    const result = await settle('да, к прошлой');

    expect(result.kind).toBe('applied');
    expect(result.applied?.fields).toEqual(['deadlineAt', 'deadlineAccuracy']);
    expect((await reread()).deadlineAt?.toISOString()).toBe('2026-09-03T21:00:00.000Z');
  });

  it('изменение записывается как сделанное человеком, а не ботом', async () => {
    // Человек подтвердил его словами. Приписать это резолверу значило бы
    // соврать в истории, по которой потом разбирают жалобы.
    await ask();
    const result = await settle('да');

    const [revision] = await testDb().select().from(items).where(eq(items.id, item.id));
    expect(revision).toBeDefined();
    expect(result.applied?.revisionId).toBeDefined();
  });

  it('«это новое» возвращает сказанное в разбор этой же выгрузки', async () => {
    // Отдельного вызова модели не нужно: выгрузка всё равно сейчас
    // разбирается.
    await ask();

    const result = await settle('нет, это новое');

    expect(result.kind).toBe('separate');
    expect(result.carryOver).toBe('нет, в пятницу');
    expect((await reread()).deadlineAt).toBeNull();
  });

  it('«не знаю» ничего не меняет и не выдумывает записи', async () => {
    await ask();

    const result = await settle('да не знаю я');

    expect(result.kind).toBe('unclear');
    expect(result.carryOver).toBeUndefined();
    expect((await reread()).deadlineAt).toBeNull();
    // Сказанное при этом не пропало (§9.1).
    expect(await draftTexts()).toEqual(['нет, в пятницу']);
  });
});

describe('человек не ответил и прислал новое', () => {
  it('вопрос снимается, к нему бот не возвращается', async () => {
    // §7.3: «продукт не имеет права превращаться в допрос».
    await ask();

    const result = await settle();

    expect(result.kind).toBe('superseded');

    const [question] = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));

    expect(question?.outcome).toBe('superseded');
  });

  it('сказанное сохраняется черновиком, а не задачей', async () => {
    // «Нет, в пятницу» как задача — это задача «в пятницу». Тот же довод
    // второй этап уже применил к правкам: лучше черновик, чем бессмыслица
    // в списке дел.
    await ask();
    await settle();

    expect(await draftTexts()).toEqual(['нет, в пятницу']);
  });

  it('запись, о которой спрашивали, остаётся нетронутой', async () => {
    await ask();
    await settle();

    expect((await reread()).deadlineAt).toBeNull();
  });
});
