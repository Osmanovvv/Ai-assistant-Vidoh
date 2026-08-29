import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { itemRevisions, items, type Item } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { applyDecision, PATCHABLE_FIELDS } from './patch.js';
import { lastRevisionOf, RESTORABLE_FIELDS, revertRevision } from './revisions.repo.js';

/**
 * Применение изменения и откат (инвариант 7, §7.3 ТЗ, задачи 3.3 и 3.4).
 *
 * «Каждое применение пишет ревизию со снимком до. Кнопка отмены
 * откатывает последнюю ревизию. Пользовательница должна иметь
 * возможность откатить любое автоматическое решение за один тап.»
 *
 * Здесь проверяется обещание целиком: не «ревизия появилась», а то, что
 * по ней запись возвращается ровно в прежнее состояние — включая срок и
 * тему, как требует «готово, когда» задачи 3.4.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');
const MOSCOW = 'Europe/Moscow';
const THURSDAY = new Date('2026-09-02T21:00:00.000Z');

let userId = '';
let strangerId = '';
let seq = 0;

const NO_CHANGES = { text: '', deadline: '', deadlineAccuracy: 'none' } as const;

async function sow(overrides: Partial<Item> = {}): Promise<Item> {
  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: 'Записать сына к врачу в четверг',
      type: 'TASK',
      priority: 'SOON',
      topic: 'здоровье',
      deadlineAt: THURSDAY,
      deadlineAccuracy: 'day',
      ...overrides,
    })
    .returning();

  if (!row) throw new Error('запись не создалась');
  return row;
}

async function reread(id: string): Promise<Item> {
  const [row] = await testDb().select().from(items).where(eq(items.id, id));
  if (!row) throw new Error('запись пропала');
  return row;
}

beforeEach(async () => {
  seq++;
  userId = (await upsertUser(testDb(), { tgId: 9700 + seq, firstName: 'Оля' })).id;
  strangerId = (await upsertUser(testDb(), { tgId: 9800 + seq, firstName: 'Чужая' })).id;
});

describe('применение оставляет ревизию', () => {
  it('перенос срока: запись изменилась, снимок «до» сохранён', async () => {
    const item = await sow();

    const applied = await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'update',
      changes: { text: '', deadline: '2026-09-04', deadlineAccuracy: 'day' },
      timeZone: MOSCOW,
      now: NOW,
      reason: 'подтверждено свежестью',
    });

    expect(applied?.fields).toEqual(['deadlineAt', 'deadlineAccuracy']);

    const after = await reread(item.id);
    // Полночь 4 сентября по Москве — это 3 сентября 21:00 по Гринвичу.
    expect(after.deadlineAt?.toISOString()).toBe('2026-09-03T21:00:00.000Z');

    const revision = await lastRevisionOf(testDb(), item.id);
    expect(revision?.changedBy).toBe('resolver');
    expect(revision?.reason).toBe('подтверждено свежестью');
    expect((revision?.before as { deadlineAt: string }).deadlineAt).toBe(THURSDAY.toISOString());
    expect((revision?.after as { deadlineAt: string }).deadlineAt).toBe('2026-09-03T21:00:00.000Z');
  });

  it('новая формулировка', async () => {
    const item = await sow();

    const applied = await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'update',
      changes: { text: 'Записать сына к стоматологу', deadline: '', deadlineAccuracy: 'none' },
      timeZone: MOSCOW,
      now: NOW,
    });

    expect(applied?.fields).toEqual(['text']);
    expect((await reread(item.id)).text).toBe('Записать сына к стоматологу');
  });

  it('дело сделано', async () => {
    const item = await sow();

    const applied = await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'complete',
      changes: NO_CHANGES,
      timeZone: MOSCOW,
      now: NOW,
    });

    expect(applied?.fields).toEqual(['status', 'completedAt']);

    const after = await reread(item.id);
    expect(after.status).toBe('done');
    expect(after.completedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('дело отменено, а не удалено (§13.5)', async () => {
    const item = await sow();

    await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'cancel',
      changes: NO_CHANGES,
      timeZone: MOSCOW,
      now: NOW,
    });

    expect((await reread(item.id)).status).toBe('cancelled');
  });
});

describe('чего применение делать не должно', () => {
  it('изменение, которое ничего не меняет, ревизии не оставляет', async () => {
    // Иначе человек получит кнопку отмены, которая ничего не отменяет,
    // и сообщение о том, чего не было.
    const item = await sow();

    const applied = await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'update',
      changes: { text: 'Записать сына к врачу в четверг', deadline: '', deadlineAccuracy: 'none' },
      timeZone: MOSCOW,
      now: NOW,
    });

    expect(applied).toBeUndefined();
    expect(await lastRevisionOf(testDb(), item.id)).toBeUndefined();
  });

  it('повторное «сделано» ничего не пишет', async () => {
    const item = await sow({ status: 'done', completedAt: NOW });

    expect(
      await applyDecision(testDb(), {
        userId,
        itemId: item.id,
        action: 'complete',
        changes: NO_CHANGES,
        timeZone: MOSCOW,
        now: NOW,
      }),
    ).toBeUndefined();
  });

  it('чужую запись не трогает', async () => {
    const item = await sow();

    const applied = await applyDecision(testDb(), {
      userId: strangerId,
      itemId: item.id,
      action: 'complete',
      changes: NO_CHANGES,
      timeZone: MOSCOW,
      now: NOW,
    });

    expect(applied).toBeUndefined();
    expect((await reread(item.id)).status).toBe('new');
  });

  it('срок в прошлом не применяется', async () => {
    // Та же проверка, что и при разборе выгрузки: неверный срок хуже
    // отсутствующего, потому что напоминание придёт не вовремя.
    const item = await sow();

    const applied = await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'update',
      changes: { text: '', deadline: '2020-01-01', deadlineAccuracy: 'day' },
      timeZone: MOSCOW,
      now: NOW,
    });

    expect(applied).toBeUndefined();
    expect((await reread(item.id)).deadlineAt?.toISOString()).toBe(THURSDAY.toISOString());
  });
});

describe('откат в один тап (3.4)', () => {
  it('возвращает запись ровно в прежнее состояние', async () => {
    const item = await sow();

    const applied = await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'update',
      changes: { text: 'Другое дело', deadline: '2026-09-04', deadlineAccuracy: 'day' },
      timeZone: MOSCOW,
      now: NOW,
    });

    const outcome = await revertRevision(testDb(), {
      revisionId: applied?.revisionId ?? '',
      userId,
    });

    expect(outcome.kind).toBe('reverted');

    const after = await reread(item.id);
    expect(after.text).toBe('Записать сына к врачу в четверг');
    expect(after.deadlineAt?.toISOString()).toBe(THURSDAY.toISOString());
    expect(after.deadlineAccuracy).toBe('day');
    expect(after.topic).toBe('здоровье');
  });

  it('откат закрытия возвращает и статус, и дату закрытия', async () => {
    const item = await sow();

    const applied = await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'complete',
      changes: NO_CHANGES,
      timeZone: MOSCOW,
      now: NOW,
    });

    await revertRevision(testDb(), { revisionId: applied?.revisionId ?? '', userId });

    const after = await reread(item.id);
    expect(after.status).toBe('new');
    expect(after.completedAt).toBeNull();
  });

  it('второе нажатие отвечает «уже отменено», а не откатывает снова', async () => {
    // Кнопка остаётся в чате навсегда, и человек нажмёт её ещё раз.
    const item = await sow();

    const applied = await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'complete',
      changes: NO_CHANGES,
      timeZone: MOSCOW,
      now: NOW,
    });

    const first = await revertRevision(testDb(), {
      revisionId: applied?.revisionId ?? '',
      userId,
    });
    const second = await revertRevision(testDb(), {
      revisionId: applied?.revisionId ?? '',
      userId,
    });

    expect(first.kind).toBe('reverted');
    expect(second.kind).toBe('already');
    expect((await reread(item.id)).status).toBe('new');
  });

  it('чужую ревизию откатить нельзя', async () => {
    const item = await sow();

    const applied = await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'complete',
      changes: NO_CHANGES,
      timeZone: MOSCOW,
      now: NOW,
    });

    const outcome = await revertRevision(testDb(), {
      revisionId: applied?.revisionId ?? '',
      userId: strangerId,
    });

    expect(outcome.kind).toBe('gone');
    expect((await reread(item.id)).status).toBe('done');
  });

  it('откаченная ревизия перестаёт быть последней', async () => {
    const item = await sow();

    const applied = await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'complete',
      changes: NO_CHANGES,
      timeZone: MOSCOW,
      now: NOW,
    });

    await revertRevision(testDb(), { revisionId: applied?.revisionId ?? '', userId });

    expect(await lastRevisionOf(testDb(), item.id)).toBeUndefined();
  });
});

describe('обещание отката держится по построению', () => {
  it('всё, что резолвер меняет, он умеет вернуть', () => {
    // Добавили полю право меняться — обязаны добавить и право
    // возвращаться. Иначе откат тихо оставит часть изменения на месте.
    for (const field of PATCHABLE_FIELDS) {
      expect(RESTORABLE_FIELDS as readonly string[]).toContain(field);
    }
  });

  it('удаление человека уносит его ревизии (§16)', async () => {
    const item = await sow();

    await applyDecision(testDb(), {
      userId,
      itemId: item.id,
      action: 'complete',
      changes: NO_CHANGES,
      timeZone: MOSCOW,
      now: NOW,
    });

    await testDb().delete(items).where(eq(items.id, item.id));

    const left = await testDb()
      .select({ id: itemRevisions.id })
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, item.id));

    expect(left).toEqual([]);
  });
});
