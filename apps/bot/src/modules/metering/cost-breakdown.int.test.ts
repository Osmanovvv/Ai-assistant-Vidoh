import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, batches, users } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { costBreakdown, type Money } from './cost-breakdown.js';

/**
 * Расход в разрезах (§15 ТЗ, §21 п.14; задача 4.7).
 *
 * План просит «интеграционный на корректность агрегатов», и это здесь
 * главное слово: агрегат, посчитанный неправильно, выглядит ровно как
 * правильный. Ошибку в нём замечают не по красному тесту, а по вопросу
 * заказчицы «почему тут столько», через месяц.
 *
 * Поэтому числа в проверках заданы так, что ответ известен заранее и
 * считается в уме: 1 ₽ = 1 000 000 микро.
 */

const RUB = 1_000_000;
const NOW = new Date('2026-09-06T12:00:00.000Z');
const SINCE = new Date('2026-09-01T00:00:00.000Z');

let anya = '';
let boris = '';

/** Строка учёта. Всё, что не задано, к делу не относится. */
async function call(params: {
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
  readonly stage?: 'router' | 'classifier' | 'speech' | 'embedder';
  readonly model?: string;
  readonly rubles?: number | undefined;
  readonly usd?: number | undefined;
  readonly ok?: boolean;
  readonly at?: Date;
}): Promise<void> {
  const priced = params.rubles !== undefined || params.usd !== undefined;

  await testDb()
    .insert(aiCalls)
    .values({
      ...(params.userId === undefined ? {} : { userId: params.userId }),
      ...(params.batchId === undefined ? {} : { batchId: params.batchId }),
      stage: params.stage ?? 'classifier',
      model: params.model ?? 'yandex:yandexgpt/latest',
      costMicros: priced ? Math.round((params.rubles ?? params.usd ?? 0) * RUB) : null,
      costCurrency: priced ? (params.rubles === undefined ? 'usd' : 'rub') : null,
      latencyMs: 100,
      ok: params.ok ?? true,
      createdAt: params.at ?? NOW,
    });
}

/** Сумма в рублях из списка по валютам. */
function rublesOf(money: readonly Money[]): number {
  return (money.find((one) => one.currency === 'rub')?.micros ?? 0) / RUB;
}

function dollarsOf(money: readonly Money[]): number {
  return (money.find((one) => one.currency === 'usd')?.micros ?? 0) / RUB;
}

beforeEach(async () => {
  await testDb().delete(aiCalls);
  await testDb().delete(users);

  anya = (await upsertUser(testDb(), { tgId: 4001, firstName: 'Аня' })).id;
  boris = (await upsertUser(testDb(), { tgId: 4002, firstName: 'Борис' })).id;
});

describe('разрез по этапам — §21 п.14', () => {
  it('складывает вызовы одного этапа и разделяет разные', async () => {
    await call({ stage: 'router', rubles: 1 });
    await call({ stage: 'router', rubles: 2 });
    await call({ stage: 'classifier', rubles: 10 });

    const report = await costBreakdown(testDb(), { since: SINCE });

    const router = report.byStage.find((row) => row.key === 'router');
    const classifier = report.byStage.find((row) => row.key === 'classifier');

    expect(rublesOf(router?.money ?? [])).toBe(3);
    expect(router?.calls).toBe(2);
    expect(rublesOf(classifier?.money ?? [])).toBe(10);
  });

  it('считает сорвавшиеся вызовы отдельно от общего числа', async () => {
    // Сбой тоже мог стоить денег, и он обязан быть виден: иначе «почему
    // расход есть, а разбора нет» не объяснить.
    await call({ stage: 'router', rubles: 1 });
    await call({ stage: 'router', ok: false, rubles: 1 });

    const report = await costBreakdown(testDb(), { since: SINCE });
    const router = report.byStage.find((row) => row.key === 'router');

    expect(router?.calls).toBe(2);
    expect(router?.failed).toBe(1);
  });
});

describe('валюты не складываются', () => {
  it('рубли и доллары остаются двумя величинами', async () => {
    /**
     * Сумма «рубли плюс доллары» не означает ничего. Пусть в панели их
     * будет две строки, чем одно неправильное число.
     */
    await call({ stage: 'router', rubles: 3 });
    await call({ stage: 'router', usd: 5 });

    const report = await costBreakdown(testDb(), { since: SINCE });
    const router = report.byStage.find((row) => row.key === 'router');

    expect(router?.money).toHaveLength(2);
    expect(rublesOf(router?.money ?? [])).toBe(3);
    expect(dollarsOf(router?.money ?? [])).toBe(5);
  });
});

describe('вызов без цены', () => {
  it('считается отдельно, а не нулём рублей', async () => {
    /**
     * Ноль в этом месте — самая опасная ложь отчёта: он выглядит как
     * «бесплатно», хотя деньги потрачены, а сколько — неизвестно.
     */
    await call({ stage: 'router', rubles: 2 });
    await call({ stage: 'router', model: 'модель-без-цены' });

    const report = await costBreakdown(testDb(), { since: SINCE });
    const router = report.byStage.find((row) => row.key === 'router');

    expect(rublesOf(router?.money ?? [])).toBe(2);
    expect(router?.unknownPrices).toBe(1);
  });

  it('и делает весь отчёт неполным — сумма становится нижней границей', async () => {
    await call({ rubles: 2 });
    expect((await costBreakdown(testDb(), { since: SINCE })).complete).toBe(true);

    await call({ model: 'модель-без-цены' });
    expect((await costBreakdown(testDb(), { since: SINCE })).complete).toBe(false);
  });
});

describe('разрез по людям — §21 п.14 «по каждому пользователю»', () => {
  it('расход каждого назван его именем', async () => {
    await call({ userId: anya, rubles: 7 });
    await call({ userId: boris, rubles: 3 });

    const report = await costBreakdown(testDb(), { since: SINCE });

    const first = report.byUser.find((row) => row.title === 'Аня');
    const second = report.byUser.find((row) => row.title === 'Борис');

    expect(rublesOf(first?.money ?? [])).toBe(7);
    expect(rublesOf(second?.money ?? [])).toBe(3);

    /**
     * Телеграмного номера в строке нет, и это проверяется нарочно.
     *
     * Прежде он уезжал в браузер в каждой строке и не рисовался ни в
     * одной колонке — то есть личный идентификатор ходил туда, где он
     * никому не нужен. Проверка стоит, чтобы он не вернулся молча.
     */
    expect(JSON.stringify(report.byUser)).not.toContain('4001');
  });

  it('обезличенный расход показан отдельно, а не потерян', async () => {
    /**
     * §16 обнуляет `user_id` при удалении данных, иначе история
     * себестоимости рассыпалась бы. Значит сумма по людям **меньше**
     * общей, и разница не ошибка — это расход тех, кто ушёл. Отчёт,
     * который об этом молчит, не сходится сам с собой.
     */
    await call({ userId: anya, rubles: 4 });
    await call({ rubles: 6 });

    const report = await costBreakdown(testDb(), { since: SINCE });

    expect(rublesOf(report.byUser.find((row) => row.title === 'Аня')?.money ?? [])).toBe(4);
    expect(rublesOf(report.unattributed)).toBe(6);

    // Общая сумма по этапам — все десять: обезличенное из неё не выпало.
    expect(rublesOf(report.byStage.flatMap((row) => row.money))).toBe(10);
  });

  it('человек без имени назван кодом, а не пустой строкой', async () => {
    // Пустая ячейка в отчёте читается как «нет данных», а человек-то есть.
    const nameless = (await upsertUser(testDb(), { tgId: 4003, firstName: 'X' })).id;
    await testDb().update(users).set({ firstName: null }).where(eq(users.id, nameless));

    await call({ userId: nameless, rubles: 1 });

    const report = await costBreakdown(testDb(), { since: SINCE });

    expect(report.byUser).toHaveLength(1);
    expect(report.byUser[0]?.title).toContain('без имени');
    expect(report.byUser[0]?.title).not.toBe('');
  });

  it('страницы: отдаётся столько, сколько попросили, и общее число', async () => {
    // §15 просит список людей, а их может быть тысяча: панель ходит
    // страницами, и ей нужно знать, сколько всего.
    await call({ userId: anya, rubles: 5 });
    await call({ userId: boris, rubles: 4 });

    const page = await costBreakdown(testDb(), { since: SINCE, userLimit: 1 });

    expect(page.byUser).toHaveLength(1);
    expect(page.userCount).toBe(2);
    // Первым — кто больше звал модель: у обоих по одному, порядок
    // устойчив, а вот число всего должно быть верным при любом порядке.
    expect(page.byUser[0]?.title).not.toBe('');
  });
});

describe('средние', () => {
  it('расход на выгрузку — сумма, делённая на число выгрузок', async () => {
    /**
     * Числитель и знаменатель берутся из одного источника — строк учёта.
     * Иначе отношение не сходилось бы: выгрузка могла закрыться без
     * единого обращения к модели, а обращение — случиться вне выгрузки.
     */
    const sown = await testDb()
      .insert(batches)
      .values([
        { userId: anya, status: 'done' as const },
        { userId: anya, status: 'done' as const },
      ])
      .returning({ id: batches.id });

    await call({ userId: anya, batchId: sown[0]?.id, rubles: 6 });
    await call({ userId: anya, batchId: sown[1]?.id, rubles: 4 });

    const report = await costBreakdown(testDb(), { since: SINCE });

    expect(report.dumps).toBe(2);
    expect(rublesOf(report.perDump)).toBe(5);
  });

  it('расход на человека — сумма, делённая на число людей', async () => {
    await call({ userId: anya, rubles: 8 });
    await call({ userId: boris, rubles: 2 });

    const report = await costBreakdown(testDb(), { since: SINCE });

    expect(rublesOf(report.perUser)).toBe(5);
  });

  it('без выгрузок и людей средних нет — вместо деления на ноль', async () => {
    // Ноль в знаменателе дал бы `Infinity` в отчёте: число, которое
    // человек прочитает как настоящее.
    await call({ rubles: 3 });

    const report = await costBreakdown(testDb(), { since: SINCE });

    expect(report.perDump).toEqual([]);
    expect(report.perUser).toEqual([]);
  });
});

describe('период', () => {
  it('строки старше начала периода не считаются', async () => {
    await call({ rubles: 100, at: new Date('2026-08-20T10:00:00.000Z') });
    await call({ rubles: 5, at: NOW });

    const report = await costBreakdown(testDb(), { since: SINCE });

    expect(rublesOf(report.byStage.flatMap((row) => row.money))).toBe(5);
    expect(report.calls).toBe(1);
  });
});

describe('разрез по моделям', () => {
  it('разные модели не смешиваются: у general и deluxe разная цена', async () => {
    await call({ model: 'yandex:general', rubles: 1 });
    await call({ model: 'yandex:deluxe', rubles: 9 });

    const report = await costBreakdown(testDb(), { since: SINCE });

    expect(rublesOf(report.byModel.find((row) => row.key === 'yandex:general')?.money ?? [])).toBe(
      1,
    );
    expect(rublesOf(report.byModel.find((row) => row.key === 'yandex:deluxe')?.money ?? [])).toBe(
      9,
    );
  });
});

describe('средние считаются от своих множеств (ревизия четвёртого этапа)', () => {
  /**
   * **Найдено ревизией, и это не косметика: по среднему на человека
   * назначают цену подписки.**
   *
   * Прежде оба средних делили **общую** сумму — вместе с обезличенной и
   * вместе с расходом вне выгрузок — на число только уцелевших людей и
   * выгрузок. Отчёт противоречил себе на одном экране: ниже стояло «ещё
   * 500 ₽ на тех, кто удалил данные», а в итогах «на человека 300 ₽» при
   * настоящей себестоимости 50 ₽.
   */

  /** Выгрузка, к которой можно привязать вызов. */
  async function batch(userId: string): Promise<string> {
    const [row] = await testDb()
      .insert(batches)
      .values({ userId, status: 'done' })
      .returning({ id: batches.id });

    return row?.id ?? '';
  }

  it('«на человека» не включает расход тех, кто удалил данные', async () => {
    /**
     * Двое живых по 50 ₽ и 500 ₽ обезличенных. Правильное среднее — 50,
     * а не 300: обезличенные строки в разрез по людям не попадают, и в
     * знаменателе их нет.
     */
    await call({ userId: anya, rubles: 50 });
    await call({ userId: boris, rubles: 50 });
    await call({ rubles: 500 });

    const report = await costBreakdown(testDb(), { since: SINCE });

    expect(rublesOf(report.perUser)).toBe(50);

    // И обезличенное по-прежнему видно отдельно — вместе с числом вызовов.
    expect(rublesOf(report.unattributed)).toBe(500);
    expect(report.unattributedCalls).toBe(1);
  });

  it('«на выгрузку» не включает расход вне выгрузок', async () => {
    /**
     * Выгрузка уходит каскадом вместе с человеком, а строка учёта
     * остаётся. Прежде эти деньги молча попадали в числитель, и
     * себестоимость разбора росла от **чужого** удаления.
     */
    const first = await batch(anya);
    const second = await batch(anya);

    await call({ userId: anya, batchId: first, rubles: 10 });
    await call({ userId: anya, batchId: second, rubles: 10 });
    // Вызов без выгрузки: её удалили вместе с данными человека.
    await call({ rubles: 200 });

    const report = await costBreakdown(testDb(), { since: SINCE });

    expect(report.dumps).toBe(2);
    expect(rublesOf(report.perDump)).toBe(10);

    expect(rublesOf(report.unlinked)).toBe(200);
    expect(report.unlinkedCalls).toBe(1);
  });

  it('отчёт сходится сам с собой: сумма разрезов плюс отдельные величины', async () => {
    /**
     * Отчёт, не сходящийся сам с собой, разбирающий сочтёт поломкой — и
     * будет прав.
     */
    const own = await batch(anya);

    await call({ userId: anya, batchId: own, rubles: 30 });
    await call({ rubles: 70 });

    const report = await costBreakdown(testDb(), { since: SINCE });

    const byUser = report.byUser.reduce((sum, row) => sum + rublesOf(row.money), 0);
    const total = report.byStage.reduce((sum, row) => sum + rublesOf(row.money), 0);

    expect(total).toBe(100);
    expect(byUser + rublesOf(report.unattributed)).toBe(total);
  });

  it('порядок разреза по людям устойчив при равном числе вызовов', async () => {
    /**
     * У запроса по людям нет `order by`, значит порядок страницы
     * наследует порядок строк Postgres. Тот же дефект уже чинили в
     * списке людей (4.6): один человек попадал на две страницы, другой —
     * ни на одну.
     */
    await call({ userId: anya, rubles: 1 });
    await call({ userId: boris, rubles: 1 });

    const first = await costBreakdown(testDb(), { since: SINCE, userLimit: 1, userOffset: 0 });
    const second = await costBreakdown(testDb(), { since: SINCE, userLimit: 1, userOffset: 1 });

    expect(first.byUser).toHaveLength(1);
    expect(second.byUser).toHaveLength(1);

    // Страницы не пересекаются и вместе дают обоих.
    expect(first.byUser[0]?.key).not.toBe(second.byUser[0]?.key);
    expect(new Set([first.byUser[0]?.key, second.byUser[0]?.key]).size).toBe(2);
  });
});
