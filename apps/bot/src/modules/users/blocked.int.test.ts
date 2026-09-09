import { describe, expect, it } from 'vitest';

import { testDb } from '../../test/db.js';
import { recipientsOf } from '../broadcast/broadcast.repo.js';
import { findByTgId, markBlocked, upsertUser } from './users.repo.js';

/**
 * Пометка блокировки: кому писать нельзя (§15 ТЗ).
 *
 * **Спрашиваем ту функцию, которой пользуется бой** (ревизия панели).
 * Прежде здесь звалась `activeUserIds` — экспорт, у которого не было ни
 * одного вызывающего, кроме этой проверки. Она была зелёной, а
 * проверяла запрос, который никто не выполняет: рассылка набирает
 * адресатов `recipientsOf`, планировщик — своим запросом. Про сегменты
 * `activeUserIds` уже не знала, и «правило кому можно писать» жило в
 * двух местах, из которых одно устаревало молча.
 */

/** Кому уйдёт рассылка «всем» — тем же вызовом, каким её составляют. */
async function canWrite(): Promise<readonly string[]> {
  const people = await recipientsOf(testDb(), { segment: 'all', trialLimit: 10 });

  return people.map((one) => one.userId);
}

describe('пометка блокировки', () => {
  it('заблокированный пользователь исключается из рассылки', async () => {
    const db = testDb();
    const active = await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    await upsertUser(db, { tgId: 200, firstName: 'Оля' });
    await markBlocked(db, 200);

    await expect(canWrite()).resolves.toEqual([active.id]);
  });

  it('разблокировка возвращает пользователя в рассылку', async () => {
    const db = testDb();
    const user = await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    await markBlocked(db, 100);
    expect(await canWrite()).toEqual([]);

    // Любое сообщение или апдейт о разблокировке снимает пометку.
    await upsertUser(db, { tgId: 100, firstName: 'Аня' });

    await expect(canWrite()).resolves.toEqual([user.id]);
  });

  /**
   * Дата блокировки — про начало периода, а не про последнее наблюдение.
   *
   * **Что не видел прежний страж.** Он назывался так же, а сверял
   * `second >= first` — условие, верное и при перетирании: `markBlocked`
   * писал `now()` безусловно, вторая блокировка сдвигала дату, а
   * проверка оставалась зелёной. Замерено 09.09.2026 зондом в этом же
   * файле: `second > first` строго — то есть охраняемое свойство было
   * сломано всё время, пока страж стоял.
   *
   * Сверять надо равенство: 403 приходит на каждую попытку отправки, и
   * «когда человек заблокировал бота» иначе означает «когда мы в
   * последний раз попробовали» — ответ, из которого не сделать ни
   * чистки по давности, ни отчёта о потерянных людях.
   */
  it('повторная блокировка не меняет дату первой', async () => {
    const db = testDb();
    await upsertUser(db, { tgId: 100, firstName: 'Аня' });

    await markBlocked(db, 100);
    const first = (await findByTgId(db, 100))?.blockedAt;
    // Ждём заметно больше разрешения `now()`, иначе равенство дат
    // получилось бы само собой и страж снова ничего не проверял бы.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await markBlocked(db, 100);
    const second = (await findByTgId(db, 100))?.blockedAt;

    // Дата обязана быть: страж, довольный двумя `null`, тоже мнимый.
    expect(first).toBeInstanceOf(Date);
    expect(second?.getTime(), 'вторая блокировка перетёрла дату первой').toBe(first?.getTime());
  });

  /**
   * Обратная сторона той же правки (урок «страж должен отличать
   * починенное от сломанного»): COALESCE не должен заморозить дату
   * навсегда. Разблокировка — конец периода, и следующая блокировка
   * начинает новый, со своей датой. Без этой проверки «починкой»
   * сошёл бы и `markBlocked`, который не трогает `blocked_at` вовсе.
   */
  it('после разблокировки новая блокировка получает новую дату', async () => {
    const db = testDb();
    await upsertUser(db, { tgId: 100, firstName: 'Аня' });

    await markBlocked(db, 100);
    const first = (await findByTgId(db, 100))?.blockedAt;

    // Человек снова написал — пометка снята вместе с датой.
    await upsertUser(db, { tgId: 100, firstName: 'Аня' });
    expect((await findByTgId(db, 100))?.blockedAt).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 50));
    await markBlocked(db, 100);
    const second = (await findByTgId(db, 100))?.blockedAt;

    expect(
      second!.getTime(),
      'дата блокировки застыла на прошлом периоде: новый период недоступности выглядит старым',
    ).toBeGreaterThan(first!.getTime());
  });

  it('пустая база даёт пустой список активных', async () => {
    await expect(canWrite()).resolves.toEqual([]);
  });
});
