import { describe, expect, it } from 'vitest';

import { testDb } from '../../test/db.js';
import { findByTgId, markBlocked, recordConsent, upsertUser } from './users.repo.js';

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

describe('recordConsent', () => {
  it('фиксирует согласие на обработку данных', async () => {
    const db = testDb();
    const user = await upsertUser(db, { tgId: 100, firstName: 'Аня' });

    await recordConsent(db, user.id);

    expect((await findByTgId(db, 100))?.consentAt).toBeInstanceOf(Date);
  });
});

describe('findByTgId', () => {
  it('возвращает undefined для неизвестного пользователя', async () => {
    await expect(findByTgId(testDb(), 404)).resolves.toBeUndefined();
  });
});
