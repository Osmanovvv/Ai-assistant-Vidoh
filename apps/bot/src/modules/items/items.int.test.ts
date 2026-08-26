import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, type ItemTypeValue } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import type { ClassifiedItem } from '../classifier/classifier.service.js';
import { itemsForBatch, saveDraft, saveItems } from './items.repo.js';

/**
 * Сохранение записей на живой базе.
 *
 * Проверяются две вещи, которые важнее удобства: разбор пишется целиком
 * или не пишется вовсе, и база сама не пускает запись без типа. Второе —
 * не перестраховка: запись без типа не показывается в выдаче и не попадает
 * в напоминания, то есть тихо исчезает, и найти такое потом почти
 * невозможно.
 */

let userId: string;
let batchId: string;

const item = (overrides: Partial<ClassifiedItem> = {}): ClassifiedItem => ({
  text: 'записаться к врачу',
  type: 'TASK',
  priority: 'SOON',
  topic: 'здоровье',
  isProject: false,
  ...overrides,
});

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 900, firstName: 'Аня' });
  userId = user.id;

  const [batch] = await testDb()
    .insert(batches)
    .values({ userId, status: 'processing', combinedText: 'надо к врачу' })
    .returning({ id: batches.id });

  batchId = batch!.id;
});

describe('saveItems', () => {
  it('пишет записи со всеми полями', async () => {
    const deadlineAt = new Date('2026-09-09T21:00:00.000Z');

    await saveItems(testDb(), {
      userId,
      batchId,
      items: [
        item({
          text: 'день рождения сына',
          isProject: true,
          topic: 'семья',
          deadline: { at: deadlineAt, accuracy: 'day' },
        }),
      ],
    });

    const [row] = await itemsForBatch(testDb(), batchId);

    expect(row?.text).toBe('день рождения сына');
    expect(row?.type).toBe('TASK');
    expect(row?.priority).toBe('SOON');
    expect(row?.topic).toBe('семья');
    expect(row?.isProject).toBe(true);
    expect(row?.deadlineAt?.toISOString()).toBe(deadlineAt.toISOString());
    expect(row?.deadlineAccuracy).toBe('day');
    // Новая запись именно новая: статус разбирается на этапе 3.
    expect(row?.status).toBe('new');
    expect(row?.isDraft).toBe(false);
    expect(row?.sourceBatchId).toBe(batchId);
  });

  it('связывает записи с выгрузкой, а не с сообщением', async () => {
    // §5 плюс source_batch_id: запись рождается из склейки нескольких
    // сообщений, а не из одного.
    await saveItems(testDb(), { userId, batchId, items: [item(), item({ text: 'второе' })] });

    const rows = await itemsForBatch(testDb(), batchId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.sourceBatchId === batchId)).toBe(true);
  });

  it('пустой разбор не создаёт ничего и не падает', async () => {
    const saved = await saveItems(testDb(), { userId, batchId, items: [] });

    expect(saved).toEqual([]);
    expect(await itemsForBatch(testDb(), batchId)).toEqual([]);
  });

  it('частичный сбой не оставляет половину разбора', async () => {
    // Условие готовности задачи 2.8. Человек увидел бы три дела из пяти
    // и решил, что остальное потерялось. Оно бы и потерялось: выгрузка
    // уже помечена обработанной, второй раз её никто не разберёт.
    const broken = {
      ...item({ text: 'запись без типа' }),
      // Так может прийти только из-за ошибки в коде выше, и база обязана
      // это остановить.
      type: undefined as unknown as ItemTypeValue,
    };

    await expect(
      saveItems(testDb(), {
        userId,
        batchId,
        items: [item({ text: 'первое' }), broken, item({ text: 'третье' })],
      }),
    ).rejects.toThrow();

    expect(await itemsForBatch(testDb(), batchId)).toEqual([]);
  });
});

describe('saveDraft', () => {
  it('сохраняет текст без классификации', async () => {
    // §17 ТЗ: разобрать не удалось, но текст терять нельзя.
    await saveDraft(testDb(), {
      userId,
      batchId,
      text: 'надо к врачу и ещё что-то',
      reason: 'ответ модели не прошёл проверку схемы дважды',
    });

    const [row] = await itemsForBatch(testDb(), batchId);

    expect(row?.isDraft).toBe(true);
    expect(row?.text).toBe('надо к врачу и ещё что-то');
    expect(row?.draftReason).toContain('схемы');
    // У черновика классификации нет — выдумывать за модель нельзя.
    expect(row?.type).toBeNull();
    expect(row?.priority).toBeNull();
    expect(row?.topic).toBeNull();
  });
});

/**
 * Имя нарушенного ограничения лежит в причине ошибки, а не в сообщении:
 * drizzle оборачивает отказ базы в свой «Failed query». Проверять надо
 * именно имя — иначе тест зеленел бы на любой другой ошибке вставки.
 */
async function expectConstraint(promise: Promise<unknown>, name: string): Promise<void> {
  let violated: string | undefined;

  try {
    await promise;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
      const candidate = (current as { constraint?: unknown }).constraint;
      if (typeof candidate === 'string') {
        violated = candidate;
        break;
      }
      current = (current as { cause?: unknown }).cause;
    }
  }

  expect(violated).toBe(name);
}

describe('база не пускает нецелостные записи', () => {
  it('разобранная запись без типа отвергается', async () => {
    await expectConstraint(
      testDb().insert(items).values({ userId, text: 'дело', priority: 'SOON', topic: 'личное' }),
      'items_draft_or_classified',
    );
  });

  it('разобранная запись без темы отвергается', async () => {
    await expectConstraint(
      testDb().insert(items).values({ userId, text: 'дело', type: 'TASK', priority: 'SOON' }),
      'items_draft_or_classified',
    );
  });

  it('срок без точности отвергается', async () => {
    // Срок без точности и точность без срока одинаково бесполезны:
    // напоминание не будет знать, на какой день срабатывать.
    await expectConstraint(
      testDb()
        .insert(items)
        .values({
          userId,
          text: 'дело',
          type: 'TASK',
          priority: 'SOON',
          topic: 'личное',
          deadlineAt: new Date('2026-09-10T00:00:00.000Z'),
        }),
      'items_deadline_with_accuracy',
    );
  });

  it('точность без срока тоже', async () => {
    await expectConstraint(
      testDb().insert(items).values({
        userId,
        text: 'дело',
        type: 'TASK',
        priority: 'SOON',
        topic: 'личное',
        deadlineAccuracy: 'day',
      }),
      'items_deadline_with_accuracy',
    );
  });

  it('черновик без типа проходит: у него его и не должно быть', async () => {
    await expect(
      testDb().insert(items).values({ userId, text: 'неразобранное', isDraft: true }),
    ).resolves.toBeDefined();
  });
});

describe('связь с выгрузкой', () => {
  it('удаление выгрузки не удаляет запись', async () => {
    await saveItems(testDb(), { userId, batchId, items: [item()] });

    await testDb().delete(batches).where(eq(batches.id, batchId));
    // Выгрузку удалили, а запись осталась: она живёт своей жизнью.
    const afterBatch = await testDb().select().from(items);
    expect(afterBatch).toHaveLength(1);
    expect(afterBatch[0]?.sourceBatchId).toBeNull();
  });
});

describe('регулярность в базе (задача 2.18а)', () => {
  it('правило, фраза и источник сохраняются вместе', async () => {
    const saved = await saveItems(testDb(), {
      userId,
      batchId,
      items: [
        {
          text: 'возить сына на плавание',
          type: 'TASK',
          priority: 'SOON',
          topic: 'семья',
          isProject: false,
          recurrence: {
            rule: { kind: 'weekly', interval: 1, anchor: '2026-09-08' },
            text: 'каждый вторник',
            source: 'stated',
          },
        },
      ],
    });

    expect(saved[0]?.recurrenceRule).toEqual({
      kind: 'weekly',
      interval: 1,
      anchor: '2026-09-08',
    });
    expect(saved[0]?.recurrenceText).toBe('каждый вторник');
    expect(saved[0]?.recurrenceSource).toBe('stated');
  });

  it('фраза без правила — законное состояние', async () => {
    // Выдумать правило, которого мы не умеем воспроизвести, хуже, чем
    // признаться, что не разобрали.
    const saved = await saveItems(testDb(), {
      userId,
      batchId,
      items: [
        {
          text: 'танцы',
          type: 'TASK',
          priority: 'SOON',
          topic: 'семья',
          isProject: false,
          recurrence: { text: 'каждый вторник и четверг', source: 'stated' },
        },
      ],
    });

    expect(saved[0]?.recurrenceRule).toBeNull();
    expect(saved[0]?.recurrenceText).toBe('каждый вторник и четверг');
    expect(saved[0]?.recurrenceSource).toBe('stated');
  });

  it('база не пускает правило к не-задаче', async () => {
    // §5.1: регулярность — поле у TASK. Ограничение в базе превращает
    // «не должно случиться» в «не может случиться».
    await expectConstraint(
      testDb()
        .insert(items)
        .values({
          userId,
          text: 'хочу бегать',
          type: 'DESIRE',
          priority: 'NONE',
          topic: 'личное',
          recurrenceRule: { kind: 'daily', interval: 1, anchor: '2026-09-08' },
          recurrenceSource: 'stated',
        }),
      'items_recurrence_task_only',
    );
  });

  it('база не пускает регулярность без источника', async () => {
    // Иначе способы 3 и 4 из запроса на изменение нечем будет мерить.
    await expectConstraint(
      testDb().insert(items).values({
        userId,
        text: 'оплатить садик',
        type: 'TASK',
        priority: 'SOON',
        topic: 'личное',
        recurrenceText: 'раз в месяц',
      }),
      'items_recurrence_has_source',
    );
  });
});
