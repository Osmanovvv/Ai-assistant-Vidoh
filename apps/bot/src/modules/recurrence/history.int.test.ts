import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { items, recurrenceSuggestions } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { setItemEmbedding } from '../embedder/embedder.service.js';
import { upsertUser } from '../users/users.repo.js';
import { sweepHistory } from './history.service.js';
import { resolveOffer, SUGGESTION_COOLDOWN_DAYS } from './suggestions.repo.js';

/**
 * Обход накопленной истории (задача 3.17а).
 *
 * Условие готовности: засеянная история из четырёх ежемесячных оплат даёт
 * одно предложение; повторный проход на той же истории второго
 * предложения не даёт.
 *
 * Часы управляемые: `now` передаётся во все проходы, а даты записей
 * ставятся прямо в базу. Иначе проверить «раз в месяц три месяца подряд»
 * можно было бы только прожив три месяца.
 */

const DAY = 24 * 60 * 60_000;
const NOW = new Date('2026-08-30T12:00:00.000Z');

let userId = '';
let seq = 0;

/** Единичный вектор: близость к себе — единица, к другой оси — ноль. */
const axis = (index: number): number[] =>
  Array.from({ length: 256 }, (_unused, position) => (position === index ? 1 : 0));

async function sow(params: {
  readonly text: string;
  readonly at: string;
  readonly vector?: number;
  readonly status?: 'done' | 'new';
}): Promise<string> {
  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: params.text,
      type: 'TASK',
      priority: 'SOON',
      topic: 'деньги',
      status: params.status ?? 'done',
      createdAt: new Date(`${params.at}T09:00:00.000Z`),
    })
    .returning({ id: items.id });

  const id = row?.id ?? '';
  await setItemEmbedding(testDb(), id, axis(params.vector ?? 0));

  /**
   * Дата создания ставится после вектора.
   *
   * `setItemEmbedding` двигает `updated_at`, а порядок выборки в обходе
   * идёт по `created_at` — но переписать её надо в любом случае: вставка
   * с прошлой датой и последующая правка вектора уже наступали на это в
   * задаче 3.8в.
   */
  await testDb()
    .update(items)
    .set({ createdAt: new Date(`${params.at}T09:00:00.000Z`) })
    .where(eq(items.id, id));

  return id;
}

/** Четыре ежемесячные оплаты — фикстура из условия готовности. */
async function monthlyPayments(): Promise<string[]> {
  return [
    await sow({ text: 'Оплатить садик', at: '2026-05-06' }),
    await sow({ text: 'Садик оплатить', at: '2026-06-05' }),
    await sow({ text: 'Заплатить за садик', at: '2026-07-06' }),
    await sow({ text: 'Оплатить садик за август', at: '2026-08-05', status: 'new' }),
  ];
}

beforeEach(async () => {
  seq += 1;
  userId = (await upsertUser(testDb(), { tgId: 8100 + seq, firstName: 'Аня' })).id;
});

describe('находит то, что ни разу так не называлось', () => {
  it('четыре ежемесячные оплаты дают одно предложение', async () => {
    await monthlyPayments();

    const found = await sweepHistory({ db: testDb() }, { userId, now: NOW });

    expect(found?.rhythm.kind).toBe('monthly');
    expect(found?.rhythm.interval).toBe(1);
    expect(found?.dates).toHaveLength(4);
  });

  it('предложение показывает основание — все четыре даты', async () => {
    // Без перечисления дат предложение читается как гадание бота.
    await monthlyPayments();

    const found = await sweepHistory({ db: testDb() }, { userId, now: NOW });
    const days = (found?.dates ?? []).map((at) => at.getUTCDate());

    expect(days).toEqual([6, 5, 6, 5]);
  });

  it('спрашивает про самую свежую запись связки', async () => {
    const ids = await monthlyPayments();

    const found = await sweepHistory({ db: testDb() }, { userId, now: NOW });

    expect(found?.itemId).toBe(ids[3]);
    expect(found?.title).toBe('Оплатить садик за август');
  });

  it('закрытая история засчитывается наравне с открытой', async () => {
    // Три закрытых и одна открытая — это четыре повторения, а не одно.
    await monthlyPayments();
    const closed = await testDb().select().from(items).where(eq(items.userId, userId));

    expect(closed.filter((one) => one.status === 'done')).toHaveLength(3);
    expect(await sweepHistory({ db: testDb() }, { userId, now: NOW })).toBeDefined();
  });
});

describe('молчит, когда ритма нет', () => {
  it('три записи с рваными промежутками — ничего', async () => {
    await sow({ text: 'Оплатить садик', at: '2026-01-05' });
    await sow({ text: 'Садик оплатить', at: '2026-02-05' });
    await sow({ text: 'Заплатить за садик', at: '2026-02-08' });

    expect(await sweepHistory({ db: testDb() }, { userId, now: NOW })).toBeUndefined();
  });

  it('двух повторений мало, даже ровных', async () => {
    await sow({ text: 'Оплатить садик', at: '2026-07-05' });
    await sow({ text: 'Садик оплатить', at: '2026-08-05' });

    expect(await sweepHistory({ db: testDb() }, { userId, now: NOW })).toBeUndefined();
  });

  it('разные дела в одну связку не сходятся', async () => {
    // Разные оси векторов: близость нулевая, связки нет.
    await sow({ text: 'Оплатить садик', at: '2026-06-05', vector: 0 });
    await sow({ text: 'Записаться к врачу', at: '2026-07-05', vector: 1 });
    await sow({ text: 'Купить корм коту', at: '2026-08-05', vector: 2 });

    expect(await sweepHistory({ db: testDb() }, { userId, now: NOW })).toBeUndefined();
  });

  it('уже регулярному делу ничего не предлагается', async () => {
    const ids = await monthlyPayments();
    for (const id of ids) {
      await testDb()
        .update(items)
        .set({
          recurrenceRule: { kind: 'monthly', interval: 1, anchor: '2026-05-06' },
          recurrenceText: 'каждый месяц',
          recurrenceSource: 'stated',
        })
        .where(eq(items.id, id));
    }

    expect(await sweepHistory({ db: testDb() }, { userId, now: NOW })).toBeUndefined();
  });

  it('пустая история — ничего, и без единого запроса к векторам', async () => {
    expect(await sweepHistory({ db: testDb() }, { userId, now: NOW })).toBeUndefined();
  });
});

describe('повторный проход второго предложения не даёт', () => {
  it('тот же вечер — молчание', async () => {
    await monthlyPayments();

    expect(await sweepHistory({ db: testDb() }, { userId, now: NOW })).toBeDefined();
    expect(await sweepHistory({ db: testDb() }, { userId, now: NOW })).toBeUndefined();
  });

  it('каждый вечер недели — молчание', async () => {
    // Обход идёт ежевечерне; недельный предел — единственное, что стоит
    // между человеком и семью одинаковыми вопросами.
    await monthlyPayments();
    await sweepHistory({ db: testDb() }, { userId, now: NOW });

    for (let day = 1; day <= 6; day += 1) {
      const later = new Date(NOW.getTime() + day * DAY);
      expect(await sweepHistory({ db: testDb() }, { userId, now: later })).toBeUndefined();
    }

    const offers = await testDb()
      .select()
      .from(recurrenceSuggestions)
      .where(eq(recurrenceSuggestions.userId, userId));

    expect(offers).toHaveLength(1);
  });

  it('через месяц — по-прежнему молчание про ту же связку', async () => {
    /**
     * Самое важное здесь. Недельный предел снимается через семь дней, и
     * без памяти о самой связке неотвеченное предложение возвращалось бы
     * ровно каждую неделю — до конца жизни продукта.
     */
    await monthlyPayments();
    await sweepHistory({ db: testDb() }, { userId, now: NOW });

    const muchLater = new Date(NOW.getTime() + 30 * DAY);

    expect(await sweepHistory({ db: testDb() }, { userId, now: muchLater })).toBeUndefined();
  });

  it('отказ тоже помнится навсегда', async () => {
    await monthlyPayments();
    const found = await sweepHistory({ db: testDb() }, { userId, now: NOW });

    await resolveOffer(testDb(), {
      suggestionId: found?.suggestionId ?? '',
      userId,
      outcome: 'declined',
    });

    const later = new Date(NOW.getTime() + (SUGGESTION_COOLDOWN_DAYS + 1) * DAY);

    expect(await sweepHistory({ db: testDb() }, { userId, now: later })).toBeUndefined();
  });

  it('недельный предел считается от переданного времени, а не от часов базы', async () => {
    /**
     * Регрессия. `recordOffer` принимал `now` и не использовал его:
     * `created_at` брался из часов базы. Предел нельзя было проверить
     * управляемыми часами, и тест на него падал через сутки после
     * написания — в зависимости от настоящего календаря.
     */
    await monthlyPayments();
    await sweepHistory({ db: testDb() }, { userId, now: NOW });

    const [offer] = await testDb()
      .select({ createdAt: recurrenceSuggestions.createdAt })
      .from(recurrenceSuggestions)
      .where(eq(recurrenceSuggestions.userId, userId));

    expect(offer?.createdAt.toISOString()).toBe(NOW.toISOString());
  });

  it('про другое дело через неделю спросить можно', async () => {
    // Предел недельный, а не пожизненный: закрывается связка, а не человек.
    await monthlyPayments();
    await sweepHistory({ db: testDb() }, { userId, now: NOW });

    await sow({ text: 'Пропить курс витаминов', at: '2026-06-10', vector: 5 });
    await sow({ text: 'Витамины пропить', at: '2026-07-10', vector: 5 });
    await sow({ text: 'Начать курс витаминов', at: '2026-08-09', vector: 5 });

    const later = new Date(NOW.getTime() + (SUGGESTION_COOLDOWN_DAYS + 1) * DAY);
    const second = await sweepHistory({ db: testDb() }, { userId, now: later });

    expect(second?.title).toMatch(/витамин/iu);
  });
});

describe('чужое не трогает', () => {
  it('история соседа в связку не попадает', async () => {
    const stranger = await upsertUser(testDb(), { tgId: 8100 + seq + 400, firstName: 'Оля' });
    const mine = userId;

    userId = stranger.id;
    await monthlyPayments();
    userId = mine;

    expect(await sweepHistory({ db: testDb() }, { userId, now: NOW })).toBeUndefined();
  });
});
