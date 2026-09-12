import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { users } from '../../db/schema.js';

import { testDb } from '../../test/db.js';
import {
  confirmConsent,
  consentConfirmedOf,
  findByTgId,
  markBlocked,
  upsertUser,
} from './users.repo.js';

describe('upsertUser', () => {
  it('создаёт пользователя и настройки по умолчанию', async () => {
    const db = testDb();

    const user = await upsertUser(db, { tgId: 100, firstName: 'Аня', username: 'anya' });

    expect(user.tgId).toBe(100);
    expect(user.timezone).toBe('Europe/Moscow');
    expect(user.timezoneConfirmed).toBe(false);
    expect(user.isBlocked).toBe(false);
    expect(user.consentAt).toBeNull();

    const settings = await db.query.userSettings.findFirst();
    expect(settings?.userId).toBe(user.id);
  });

  it('повторный вызов не создаёт второго пользователя', async () => {
    const db = testDb();

    const first = await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    const second = await upsertUser(db, { tgId: 100, firstName: 'Анна' });

    expect(second.id).toBe(first.id);
    expect(second.firstName).toBe('Анна');
  });

  it('обновляет время последней активности', async () => {
    const db = testDb();

    const first = await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await upsertUser(db, { tgId: 100, firstName: 'Аня' });

    expect(second.lastActiveAt.getTime()).toBeGreaterThan(first.lastActiveAt.getTime());
  });

  it('сохраняет реферальный источник при первом запуске', async () => {
    const db = testDb();

    const user = await upsertUser(db, { tgId: 100, firstName: 'Аня', referralSource: 'blog' });

    expect(user.referralSource).toBe('blog');
  });

  it('не перетирает реферальный источник при повторном запуске', async () => {
    const db = testDb();

    await upsertUser(db, { tgId: 100, firstName: 'Аня', referralSource: 'blog' });
    const again = await upsertUser(db, { tgId: 100, firstName: 'Аня', referralSource: 'другой' });

    expect(again.referralSource).toBe('blog');
  });

  it('не затирает источник обычным сообщением без источника', async () => {
    const db = testDb();

    await upsertUser(db, { tgId: 100, firstName: 'Аня', referralSource: 'blog' });
    const again = await upsertUser(db, { tgId: 100, firstName: 'Аня' });

    expect(again.referralSource).toBe('blog');
  });

  it('снимает пометку блокировки, когда пользователь снова пишет', async () => {
    const db = testDb();

    await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    await markBlocked(db, 100);
    expect((await findByTgId(db, 100))?.isBlocked).toBe(true);

    const again = await upsertUser(db, { tgId: 100, firstName: 'Аня' });

    expect(again.isBlocked).toBe(false);
    expect(again.blockedAt).toBeNull();
  });
});

describe('markBlocked', () => {
  it('помечает пользователя заблокировавшим бота', async () => {
    const db = testDb();
    await upsertUser(db, { tgId: 100, firstName: 'Аня' });

    await markBlocked(db, 100);

    const user = await findByTgId(db, 100);
    expect(user?.isBlocked).toBe(true);
    expect(user?.blockedAt).toBeInstanceOf(Date);
  });

  it('не падает на неизвестном пользователе', async () => {
    await expect(markBlocked(testDb(), 999)).resolves.toBeUndefined();
  });
});

describe('confirmConsent — кнопка «Согласна» (решение заказчицы 12.09.2026)', () => {
  const PRESSED = new Date('2026-09-12T18:00:00.000Z');

  it('записывает момент нажатия, редакцию и сам факт согласия', async () => {
    const db = testDb();
    const user = await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    expect(await consentConfirmedOf(db, user.id)).toBe(false);

    expect(await confirmConsent(db, user.id, { edition: '2026-10-01', now: PRESSED })).toBe(true);

    const after = await findByTgId(db, 100);
    expect(after?.consentConfirmedAt?.getTime()).toBe(PRESSED.getTime());
    expect(after?.consentEdition).toBe('2026-10-01');
    // Факт согласия (§16) — тоже с нажатия: до него согласия не было.
    expect(after?.consentAt?.getTime()).toBe(PRESSED.getTime());
    expect(await consentConfirmedOf(db, user.id)).toBe(true);
  });

  it('второе нажатие ничего не сдвигает: помним первое согласие', async () => {
    const db = testDb();
    const user = await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    await confirmConsent(db, user.id, { edition: '2026-10-01', now: PRESSED });

    const later = new Date(PRESSED.getTime() + 60_000);
    expect(await confirmConsent(db, user.id, { edition: '2026-11-01', now: later })).toBe(false);

    const after = await findByTgId(db, 100);
    expect(after?.consentConfirmedAt?.getTime()).toBe(PRESSED.getTime());
    expect(after?.consentEdition).toBe('2026-10-01');
  });

  it('у зарегистрированного раньше прежнее согласие сообщением остаётся историей', async () => {
    /**
     * До кнопки согласием считалось первое сообщение; такие люди есть на
     * бою. Их `consent_at` — не подтверждение, а история: кнопка им
     * показывается, и подтверждение записывается отдельно, не переписывая
     * прежнюю дату.
     */
    const db = testDb();
    const user = await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    const legacy = new Date('2026-09-01T10:00:00.000Z');
    await db.update(users).set({ consentAt: legacy }).where(eq(users.id, user.id));
    expect(await consentConfirmedOf(db, user.id)).toBe(false);

    await confirmConsent(db, user.id, { edition: undefined, now: PRESSED });

    const after = await findByTgId(db, 100);
    expect(after?.consentAt?.getTime()).toBe(legacy.getTime());
    expect(after?.consentConfirmedAt?.getTime()).toBe(PRESSED.getTime());
    expect(after?.consentEdition).toBeNull();
  });
});

describe('findByTgId', () => {
  it('возвращает undefined для неизвестного пользователя', async () => {
    await expect(findByTgId(testDb(), 404)).resolves.toBeUndefined();
  });
});
