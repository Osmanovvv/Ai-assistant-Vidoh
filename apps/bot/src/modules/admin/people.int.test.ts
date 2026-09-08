import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  aiCalls,
  appSettings,
  batches,
  billingEvents,
  billingInvoices,
  billingSubscriptions,
  itemRevisions,
  items,
  messagesRaw,
  pendingQuestions,
  users,
} from '../../db/schema.js';
import {
  createInvoice,
  invoiceByRef,
  markInvoicePaid,
  nextInvId,
} from '../billing/billing.repo.js';
import { markTrialSpent, trialSpent } from '../billing/subscription.service.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { overview, people, personCard } from './people.js';

/**
 * Обзор, список и карточка (§15 ТЗ, задача 4.6).
 *
 * **Условие готовности задачи — не «экран есть», а «по жалобе „бот
 * неправильно понял“ можно за минуту найти выгрузку, версию промпта и
 * результат».** Поэтому главная проверка здесь именно такая: сеется
 * жалоба, и из карточки достаётся всё, что нужно для разбора.
 *
 * Этот путь в проекте уже проходили руками — жалоба проджекта
 * 31.08.2026 разбиралась через ssh и SQL. Карточка существует, чтобы
 * такого больше не было, и проверка написана про это, а не про наличие
 * полей.
 */

let anya = '';
let boris = '';

beforeEach(async () => {
  await testDb().delete(itemRevisions);
  await testDb().delete(pendingQuestions);
  await testDb().delete(aiCalls);
  await testDb().delete(items);
  await testDb().delete(messagesRaw);
  await testDb().delete(billingEvents);
  await testDb().delete(billingSubscriptions);
  await testDb().delete(billingInvoices);
  await testDb().delete(appSettings);
  await testDb().delete(batches);
  await testDb().delete(users);

  anya = (await upsertUser(testDb(), { tgId: 8_001, firstName: 'Аня', username: 'anya' })).id;
  boris = (await upsertUser(testDb(), { tgId: 8_002, firstName: 'Борис' })).id;
});

/** Разобранная выгрузка с текстом и записями. */
async function sowDump(params: {
  readonly userId: string;
  readonly said: string;
  readonly results: readonly string[];
  readonly promptVersion?: string | undefined;
  readonly trial?: boolean;
}): Promise<string> {
  const [batch] = await testDb()
    .insert(batches)
    .values({
      userId: params.userId,
      status: 'done',
      combinedText: params.said,
      processedAt: new Date(),
      ...(params.trial === false ? {} : { trialCountedAt: new Date() }),
    })
    .returning({ id: batches.id });

  if (batch === undefined) throw new Error('выгрузка не создалась');

  if (params.results.length > 0) {
    await testDb()
      .insert(items)
      .values(
        params.results.map((text) => ({
          userId: params.userId,
          sourceBatchId: batch.id,
          text,
          type: 'TASK' as const,
          priority: 'SOON' as const,
          topic: 'семья',
        })),
      );
  }

  await testDb()
    .insert(aiCalls)
    .values({
      userId: params.userId,
      batchId: batch.id,
      stage: 'classifier',
      model: 'yandex:yandexgpt/latest',
      promptVersion: params.promptVersion ?? 'classifier@7',
      costMicros: 3_000_000,
      costCurrency: 'rub',
      latencyMs: 100,
      ok: true,
    });

  return batch.id;
}

describe('обзор (§15)', () => {
  it('считает людей, новых, активных и выгрузки за период', async () => {
    await sowDump({ userId: anya, said: 'надо продукты', results: ['Купить продукты'] });

    await testDb().insert(messagesRaw).values({
      userId: anya,
      updateId: 1,
      tgChatId: 8_001,
      tgMessageId: 1,
      kind: 'text',
      text: 'надо продукты',
    });

    const report = await overview(testDb(), 30);

    expect(report.totalUsers).toBe(2);
    expect(report.newUsers).toBe(2);
    expect(report.activeUsers).toBe(1);
    expect(report.dumps).toBe(1);
    expect(report.spend[0]?.micros).toBe(3_000_000);
  });

  it('без записанных моментов третий шаг не выдумывается, а объясняется', async () => {
    /**
     * Моменты конца пробного периода пишутся с выкладки 4.4 и задним
     * числом не досыпаются. Ноль без объяснения читался бы как факт
     * «никто не дошёл» — а это «записей ещё нет».
     */
    const report = await overview(testDb(), 30);

    expect(report.funnel.total.trialOver).toBe(0);
    expect(report.funnel.momentsSince).toBeNull();
    expect(report.missing.some((note) => note.includes('задним числом не досыпаются'))).toBe(true);
  });

  it('выручка считается по оплаченным счетам, а не по выставленным', async () => {
    /**
     * Выставленных счетов всегда больше: человек нажимает кнопку и
     * уходит думать. Считать их выручкой значило бы показать заказчице
     * деньги, которых нет.
     */
    await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId: anya,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 39_900,
      currency: 'RUB',
      ref: 'оплачен',
      invId: await nextInvId(testDb()),
    });

    await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId: boris,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 39_900,
      currency: 'RUB',
      ref: 'брошен',
      invId: await nextInvId(testDb()),
    });

    await markInvoicePaid(testDb(), {
      id: (await invoiceByRef(testDb(), { provider: 'robokassa:smz', ref: 'оплачен' }))?.id ?? '',
      now: new Date(),
    });

    const report = await overview(testDb(), 30);

    expect(report.revenue).toEqual([{ currency: 'RUB', minor: 39_900, payments: 1 }]);
  });

  it('рубли и звёзды не складываются в одно число', async () => {
    /**
     * Курс звезды задаёт Telegram, он меняется, и «итого» пришлось бы
     * придумать. Придуманный курс в отчёте о выручке — худший вид
     * округления.
     */
    for (const [ref, currency, amount] of [
      ['рубли', 'RUB', 39_900],
      ['звёзды', 'XTR', 150],
    ] as const) {
      await createInvoice(testDb(), {
        provider: currency === 'XTR' ? 'telegram:stars' : 'robokassa:smz',
        userId: anya,
        plan: 'monthly',
        kind: 'initial',
        amountMinor: amount,
        currency,
        ref,
      });

      await markInvoicePaid(testDb(), {
        id:
          (
            await invoiceByRef(testDb(), {
              provider: currency === 'XTR' ? 'telegram:stars' : 'robokassa:smz',
              ref,
            })
          )?.id ?? '',
        now: new Date(),
      });
    }

    const report = await overview(testDb(), 30);

    expect([...report.revenue].sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([
      { currency: 'RUB', minor: 39_900, payments: 1 },
      { currency: 'XTR', minor: 150, payments: 1 },
    ]);
  });

  it('переход считается только по дошедшим до конца пробного', async () => {
    /**
     * **Знаменатель — не «все люди».** Иначе доля падала бы от каждого
     * новичка, который ещё и не выбирал: он не «не купил», он не дошёл
     * до вопроса.
     *
     * Пробный период здесь — две выгрузки. У Ани две зачтённых и
     * оплаченный счёт, у Бориса одна: он в знаменатель не попадает.
     */
    await sowDump({ userId: anya, said: 'раз', results: ['Дело'] });
    // Вторая выгрузка без отметки: отметку поставит `markTrialSpent`, и
    // вместе с ней запишется момент — так же, как в бою.
    const last = await sowDump({ userId: anya, said: 'два', results: ['Дело'], trial: false });
    await sowDump({ userId: boris, said: 'раз', results: ['Дело'] });

    await createInvoice(testDb(), {
      provider: 'robokassa:smz',
      userId: anya,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 39_900,
      currency: 'RUB',
      ref: 'анин',
    });

    await markInvoicePaid(testDb(), {
      id: (await invoiceByRef(testDb(), { provider: 'robokassa:smz', ref: 'анин' }))?.id ?? '',
      now: new Date(),
    });

    /**
     * Момент конца пробного ставится настоящим путём — отметкой, которую
     * ставит конвейер. Записать его в базу руками значило бы проверить
     * не то: воронка читает то, что пишет `markTrialSpent`.
     */
    await markTrialSpent(testDb(), { batchId: last, trialLimit: 2 });

    const report = await overview(testDb(), 30);

    expect(report.funnel.total.trialOver).toBe(1);
    expect(report.funnel.total.paidAfterTrial).toBe(1);
    expect(report.funnel.trialLimits).toEqual([2]);
  });

  it('платящих считает по живому периоду, а не по числу счетов', async () => {
    await testDb()
      .insert(billingSubscriptions)
      .values([
        {
          provider: 'robokassa:smz',
          userId: anya,
          plan: 'monthly',
          currentPeriodEnd: new Date(Date.now() + 5 * 24 * 3_600_000),
        },
        {
          provider: 'robokassa:smz',
          userId: boris,
          plan: 'monthly',
          currentPeriodEnd: new Date(Date.now() - 5 * 24 * 3_600_000),
        },
      ]);

    expect((await overview(testDb(), 30)).payers).toBe(1);
  });
});

describe('подписка в списке людей (§15, задача 4.2)', () => {
  it('«не платил» и «кончилась» — разные состояния, а не одно', async () => {
    /**
     * Разбирающий жалобу обязан их различать: у второго доступ был, и
     * жалоба «бот перестал разбирать» у них означает разное. Прочерк на
     * оба случая отправил бы искать причину не там.
     */
    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'robokassa:smz',
        userId: anya,
        plan: 'monthly',
        currentPeriodEnd: new Date(Date.now() - 24 * 3_600_000),
      });

    const page = await people(testDb(), { limit: 20, offset: 0 });
    const byId = new Map(page.rows.map((row) => [row.id, row]));

    expect(byId.get(anya)?.subscription?.live).toBe(false);
    // Борис не платил ни разу — подписки нет вовсе.
    expect(byId.get(boris)?.subscription).toBeUndefined();
  });

  it('из двух рельсов показывается тот, что кончится позже', async () => {
    /**
     * Рельсов два, а доступ общий. Показать тот, что кончится раньше,
     * значило бы напугать разбирающего жалобу без причины.
     */
    const soon = new Date(Date.now() + 3 * 24 * 3_600_000);
    const later = new Date(Date.now() + 30 * 24 * 3_600_000);

    await testDb()
      .insert(billingSubscriptions)
      .values([
        { provider: 'robokassa:smz', userId: anya, plan: 'monthly', currentPeriodEnd: soon },
        { provider: 'telegram:stars', userId: anya, plan: 'yearly', currentPeriodEnd: later },
      ]);

    const page = await people(testDb(), { limit: 20, offset: 0 });
    const found = page.rows.find((row) => row.id === anya);

    expect(found?.subscription?.rail).toBe('telegram:stars');
    expect(found?.subscription?.live).toBe(true);
  });

  it('неудачное продление видно как есть, а не как «активна»', async () => {
    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'robokassa:smz',
        userId: anya,
        plan: 'monthly',
        status: 'past_due',
        currentPeriodEnd: new Date(Date.now() + 24 * 3_600_000),
      });

    const page = await people(testDb(), { limit: 20, offset: 0 });

    expect(page.rows.find((row) => row.id === anya)?.subscription?.status).toBe('past_due');
  });

  it('карточка человека тоже знает про подписку', async () => {
    // Карточка — то место, куда идут по жалобе. «Заплатил ли он» там
    // первый вопрос, и уходить за ответом в список было бы странно.
    await testDb()
      .insert(billingSubscriptions)
      .values({
        provider: 'robokassa:smz',
        userId: anya,
        plan: 'monthly',
        currentPeriodEnd: new Date(Date.now() + 24 * 3_600_000),
      });

    const card = await personCard(testDb(), { userId: anya });

    expect(card?.person.subscription?.live).toBe(true);
  });
});

describe('список людей (§15)', () => {
  it('показывает источник, выгрузки, расход и пробный период', async () => {
    await testDb().update(users).set({ referralSource: 'blogger7' }).where(eq(users.id, anya));

    await sowDump({ userId: anya, said: 'первая', results: ['Дело'] });
    await sowDump({ userId: anya, said: 'вторая', results: ['Дело'], trial: false });

    const page = await people(testDb(), { limit: 20, offset: 0 });
    const row = page.rows.find((one) => one.title === 'Аня');

    expect(row?.source).toBe('blogger7');
    expect(row?.dumps).toBe(2);
    // Пробный период потратила одна из двух: вторая была без отметки.
    expect(row?.trialSpent).toBe(1);
    expect(row?.spend[0]?.micros).toBe(6_000_000);
  });

  it('ищет по имени и по телеграмному имени', async () => {
    // Жалоба приходит от человека, и искать его по коду неудобно.
    expect((await people(testDb(), { limit: 20, offset: 0, query: 'Ан' })).rows).toHaveLength(1);
    expect((await people(testDb(), { limit: 20, offset: 0, query: 'anya' })).rows).toHaveLength(1);
    expect((await people(testDb(), { limit: 20, offset: 0, query: 'никого' })).rows).toEqual([]);
  });

  it('человек без имени назван кодом, а не пустой ячейкой', async () => {
    await testDb().update(users).set({ firstName: null }).where(eq(users.id, boris));

    const page = await people(testDb(), { limit: 20, offset: 0 });
    const row = page.rows.find((one) => one.tgId === 8_002);

    expect(row?.title).toContain('без имени');
  });

  it('страницы держат тысячу человек — и общее число верно', async () => {
    /**
     * План требует проверить постраничность на тысяче: список, тянущий
     * всех, работает до первой сотни и ложится на тысяче — причём не у
     * нас, а у заказчицы, когда бот станет популярным.
     */
    const many = Array.from({ length: 1000 }, (_unused, index) => ({
      tgId: 100_000 + index,
      firstName: `Человек ${String(index)}`,
    }));

    await testDb().insert(users).values(many);

    const first = await people(testDb(), { limit: 20, offset: 0 });
    const last = await people(testDb(), { limit: 20, offset: 1000 });

    expect(first.rows).toHaveLength(20);
    expect(first.total).toBe(1002);
    // Последняя страница короче: людей 1002, значит на ней двое.
    expect(last.rows).toHaveLength(2);

    // И страницы не пересекаются — иначе постраничность видимость.
    const second = await people(testDb(), { limit: 20, offset: 20 });
    const seen = new Set([...first.rows, ...second.rows].map((row) => row.id));
    expect(seen.size).toBe(40);
  }, 60_000);
});

describe('карточка: разбор жалобы «бот неправильно понял»', () => {
  it('за один запрос даёт сказанное, разбор и версию промпта', async () => {
    /**
     * **Условие готовности задачи 4.6.** Жалоба: «сказала про врача, а
     * бот записал не то». Из карточки должно быть видно всё, что нужно
     * для ответа: что человек сказал, что из этого вышло и каким
     * промптом это сделано.
     */
    await sowDump({
      userId: anya,
      said: 'надо записать сына к врачу в четверг',
      results: ['Записать сына к врачу'],
      promptVersion: 'classifier@9',
    });

    const card = await personCard(testDb(), { userId: anya });

    expect(card?.dumps).toHaveLength(1);

    const dump = card?.dumps[0];

    expect(dump?.said).toBe('надо записать сына к врачу в четверг');
    expect(dump?.results.map((one) => one.text)).toEqual(['Записать сына к врачу']);
    expect(dump?.prompts.find((one) => one.stage === 'classifier')?.version).toBe('classifier@9');
  });

  it('версия промпта берётся из учёта, а не из активной сегодня', async () => {
    /**
     * §15 разрешает менять промпт без выкладки — значит к моменту жалобы
     * активная версия уже другая. Версия, которой разобрали **эту**
     * выгрузку, записана в строке учёта; оттуда и берётся.
     */
    await sowDump({
      userId: anya,
      said: 'первая',
      results: ['Дело'],
      promptVersion: 'classifier@5',
    });
    await sowDump({
      userId: anya,
      said: 'вторая',
      results: ['Дело'],
      promptVersion: 'classifier@9',
    });

    const card = await personCard(testDb(), { userId: anya });
    const versions = card?.dumps.flatMap((dump) => dump.prompts.map((one) => one.version));

    // Две выгрузки — две разные версии: карточка не подменяет их одной.
    expect(new Set(versions ?? [])).toEqual(new Set(['classifier@5', 'classifier@9']));
  });

  it('показывает черновики с причиной — то, что бот не разобрал', async () => {
    // Половина жалоб «бот меня не понял» — про черновики, и без причины
    // их не объяснить.
    const batch = await sowDump({ userId: anya, said: 'бормотание', results: [] });

    await testDb().insert(items).values({
      userId: anya,
      sourceBatchId: batch,
      text: 'нет, лучше в пятницу',
      isDraft: true,
      draftReason: 'резолвер не нашёл цели',
    });

    const card = await personCard(testDb(), { userId: anya });
    const draft = card?.dumps[0]?.results.find((one) => one.isDraft);

    expect(draft?.text).toBe('нет, лучше в пятницу');
    expect(draft?.draftReason).toContain('резолвер');
  });

  it('показывает применённые изменения и откаты', async () => {
    const batch = await sowDump({ userId: anya, said: 'к врачу в четверг', results: ['К врачу'] });
    const [item] = await testDb()
      .select({ id: items.id })
      .from(items)
      .where(eq(items.sourceBatchId, batch));

    if (item === undefined) throw new Error('запись не создалась');

    await testDb()
      .insert(itemRevisions)
      .values({
        itemId: item.id,
        userId: anya,
        changedBy: 'user',
        reason: 'человек сказал «не в четверг, а в пятницу»',
        before: { deadline: '2026-09-03' },
        after: { deadline: '2026-09-04' },
      });

    const card = await personCard(testDb(), { userId: anya });

    expect(card?.changes).toHaveLength(1);
    expect(card?.changes[0]?.reason).toContain('пятницу');
    expect(card?.changes[0]?.itemText).toBe('К врачу');
    expect(card?.changes[0]?.reverted).toBe(false);
  });

  it('показывает заданные уточняющие вопросы', async () => {
    const batch = await sowDump({ userId: anya, said: 'перенеси на пятницу', results: ['Дело'] });
    const [item] = await testDb()
      .select({ id: items.id })
      .from(items)
      .where(eq(items.sourceBatchId, batch));

    if (item === undefined) throw new Error('запись не создалась');

    await testDb()
      .insert(pendingQuestions)
      .values({
        userId: anya,
        itemId: item.id,
        batchId: batch,
        segment: 'перенеси на пятницу',
        action: 'update',
        changes: {},
        expiresAt: new Date(Date.now() + 3_600_000),
        outcome: 'attached',
      });

    const card = await personCard(testDb(), { userId: anya });

    expect(card?.questions).toHaveLength(1);
    expect(card?.questions[0]?.segment).toBe('перенеси на пятницу');
    expect(card?.questions[0]?.outcome).toBe('attached');
  });

  it('чужие выгрузки в карточку не попадают', async () => {
    // Карточка про одного человека: чужая строка здесь — это утечка.
    await sowDump({ userId: anya, said: 'моё', results: ['Моё дело'] });
    await sowDump({ userId: boris, said: 'чужое', results: ['Чужое дело'] });

    const card = await personCard(testDb(), { userId: anya });

    expect(card?.dumps).toHaveLength(1);
    expect(card?.dumps[0]?.said).toBe('моё');
  });

  it('несуществующий человек — пусто, а не выдуманная карточка', async () => {
    expect(
      await personCard(testDb(), { userId: '00000000-0000-0000-0000-000000000000' }),
    ).toBeUndefined();
  });

  it('числа в карточке те же, что в списке — включая способы разойтись', async () => {
    /**
     * Одно и то же число, посчитанное двумя способами, однажды
     * разойдётся — и человек, увидев разное в списке и в карточке,
     * перестанет верить обоим.
     *
     * **Обстановка усилена ревизией четвёртого этапа.** Прежде здесь
     * стояли две удачные выгрузки в одной валюте и сравнивались два
     * поля: `dumps` и первая сумма расхода. Такая проверка не различала
     * главные способы разойтись — а они все были настоящими:
     *  - выгрузка со статусом `failed` и стоящей отметкой пробного
     *    (список считал по `status = 'done'`, гейт — по отметке);
     *  - расход во второй валюте (сравнивалась только первая сумма);
     *  - число потраченных пробных вообще (его не сравнивали).
     *
     * Теперь сравнивается **вся строка**, а обстановка содержит каждый
     * из этих случаев.
     */
    await sowDump({ userId: anya, said: 'раз', results: ['Дело'] });
    await sowDump({ userId: anya, said: 'два', results: ['Дело'] });

    // Сорвавшаяся выгрузка с отметкой пробного: разбор дошёл до конца, а
    // отправка ответа сорвалась, и конвейер вернул выгрузку.
    await testDb()
      .insert(batches)
      .values({
        userId: anya,
        status: 'failed',
        openedAt: new Date(Date.now() - 5 * 3_600_000),
        trialCountedAt: new Date(Date.now() - 5 * 3_600_000),
      });

    // Расход во второй валюте: сравнение только первой суммы его теряло.
    await testDb().insert(aiCalls).values({
      userId: anya,
      stage: 'embedder',
      model: 'openai:text-embedding-3-small',
      promptVersion: 'нет',
      latencyMs: 40,
      ok: true,
      costMicros: 1_500,
      costCurrency: 'usd',
    });

    const fromList = (await people(testDb(), { limit: 20, offset: 0 })).rows.find(
      (row) => row.id === anya,
    );
    const fromCard = (await personCard(testDb(), { userId: anya }))?.person;

    expect(fromCard).toBeDefined();
    expect(fromList).toBeDefined();

    // Вся строка целиком, а не два поля: способ разойтись найдётся в том
    // поле, которое сравнить забыли.
    expect(fromCard).toEqual(fromList);

    // И обстановка действительно та, что описана: иначе сравнение выше
    // прошло бы на пустом месте.
    expect(fromCard?.trialSpent).toBeGreaterThan(0);
    expect(fromCard?.spend).toHaveLength(2);

    /**
     * Порядок валют назван, а не «как получилось» (ревизия этапа 4).
     *
     * Сравнение выше чувствительно к порядку — и потому краснело **через
     * раз**: у `group by` без `order by` порядок групп выбирает план, а
     * планы у карточки (один человек) и списка (двадцать) разные. Без
     * этой строки проверка снова стала бы лотереей: два случайных
     * порядка иногда совпадают.
     */
    expect(fromCard?.spend.map((money) => money.currency)).toEqual(['rub', 'usd']);
    expect(fromList?.spend.map((money) => money.currency)).toEqual(['rub', 'usd']);
  });
});

describe('ревизия четвёртого этапа: числа людей не расходятся и не врут', () => {
  /**
   * Четыре находки в одном месте, и все про одно: панель называла
   * фактом то, чего не проверяла.
   */

  it('«Пробных» считается тем же правилом, что гейт — даже у сорвавшейся выгрузки', async () => {
    /**
     * **Четвёртый способ считать одно и то же.** Гейт доступа считает по
     * отметке без условия на статус, карточка — своим запросом, сегмент
     * рассылки — общим выражением, а список людей брал оба числа из
     * одного запроса с `status = 'done'`. Расхождение достижимо: отметка
     * ставится в конце разбора, а конвейер может вернуть выгрузку в
     * очередь **после** неё при сбое отправки ответа.
     *
     * Панель показывала «потрачено 4», гейт блокировал на пятой.
     */
    const person = await upsertUser(testDb(), { tgId: 9_301, firstName: 'Аня' });

    // Разобранная выгрузка с отметкой.
    await testDb()
      .insert(batches)
      .values({
        userId: person.id,
        status: 'done',
        openedAt: new Date(Date.now() - 3 * 3_600_000),
        trialCountedAt: new Date(Date.now() - 3 * 3_600_000),
      });

    // И сорвавшаяся — с отметкой тоже: разбор дошёл до конца, а отправка
    // ответа сорвалась, и конвейер вернул выгрузку.
    await testDb()
      .insert(batches)
      .values({
        userId: person.id,
        status: 'failed',
        openedAt: new Date(Date.now() - 2 * 3_600_000),
        trialCountedAt: new Date(Date.now() - 2 * 3_600_000),
      });

    const page = await people(testDb(), { limit: 20, offset: 0 });
    const row = page.rows.find((one) => one.id === person.id);

    // Разобрана одна, а пробных потрачено две — как и считает гейт.
    expect(row?.dumps).toBe(1);
    expect(row?.trialSpent).toBe(2);

    // И то же число у гейта: одно определение на всех.
    expect(await trialSpent(testDb(), person.id)).toBe(2);

    // И в карточке — то же, что в списке.
    const card = await personCard(testDb(), { userId: person.id });

    expect(card?.person.trialSpent).toBe(2);
    expect(card?.person.dumps).toBe(1);
  });

  it('карточка не теряет слова человека у сорвавшейся выгрузки', async () => {
    /**
     * **Карточка теряла слова именно там, где они нужнее всего.**
     * `combined_text` пишется в начале разбора; у выгрузки, сорвавшейся
     * до него, поле пусто — и карточка печатала «(текста нет)» как факт.
     * Разбирающий жалобу «бот меня не понял» видел пустоту у той самой
     * выгрузки, из-за которой человек и написал.
     */
    const person = await upsertUser(testDb(), { tgId: 9_302, firstName: 'Оля' });

    const [batch] = await testDb()
      .insert(batches)
      .values({
        userId: person.id,
        status: 'failed',
        openedAt: new Date(Date.now() - 3_600_000),
        error: 'распознавание не ответило',
      })
      .returning({ id: batches.id });

    await testDb()
      .insert(messagesRaw)
      .values([
        {
          userId: person.id,
          updateId: 9_302_001,
          tgChatId: 9_302,
          tgMessageId: 1,
          batchId: batch?.id ?? '',
          kind: 'text',
          text: 'надо купить корм коту',
          receivedAt: new Date(Date.now() - 3_600_000),
        },
        {
          userId: person.id,
          updateId: 9_302_002,
          tgChatId: 9_302,
          tgMessageId: 2,
          batchId: batch?.id ?? '',
          kind: 'text',
          text: 'и записаться к врачу',
          receivedAt: new Date(Date.now() - 3_500_000),
        },
      ]);

    const card = await personCard(testDb(), { userId: person.id });
    const said = card?.dumps[0]?.said ?? '';

    // Слова на месте и в том порядке, в котором сказаны.
    expect(said).toContain('корм коту');
    expect(said).toContain('к врачу');
    expect(said.indexOf('корм коту')).toBeLessThan(said.indexOf('к врачу'));
  });

  it('голосовое без расшифровки названо словами, а не пустотой', async () => {
    const person = await upsertUser(testDb(), { tgId: 9_303, firstName: 'Вера' });

    const [batch] = await testDb()
      .insert(batches)
      .values({ userId: person.id, status: 'failed', openedAt: new Date() })
      .returning({ id: batches.id });

    await testDb()
      .insert(messagesRaw)
      .values({
        userId: person.id,
        updateId: 9_303_001,
        tgChatId: 9_303,
        tgMessageId: 1,
        batchId: batch?.id ?? '',
        kind: 'voice',
        fileId: 'файл-голосового',
        receivedAt: new Date(),
      });

    const card = await personCard(testDb(), { userId: person.id });

    expect(card?.dumps[0]?.said).toContain('не расшифровано');
  });

  it('карточка говорит, сколько выгрузок всего, а не только показанных', async () => {
    /**
     * Список обрезан двадцатью, и прежде об этом не было сказано ничего:
     * разбирающий жалобу читал его как полный.
     */
    const person = await upsertUser(testDb(), { tgId: 9_304, firstName: 'Ася' });

    for (let index = 0; index < 25; index++) {
      await testDb()
        .insert(batches)
        .values({
          userId: person.id,
          status: 'done',
          openedAt: new Date(Date.now() - index * 3_600_000),
        });
    }

    const card = await personCard(testDb(), { userId: person.id });

    expect(card?.dumps).toHaveLength(20);
    expect(card?.dumpsTotal).toBe(25);
  });

  it('вызовы без известной цены видны числом, а не молчанием', async () => {
    /**
     * Модели нет в прайс-листе — цена не записана, и вызов молча выпадал
     * из суммы: расход показывался как факт, хотя был нижней границей.
     */
    const person = await upsertUser(testDb(), { tgId: 9_305, firstName: 'Ната' });

    await testDb()
      .insert(aiCalls)
      .values([
        {
          userId: person.id,
          stage: 'router',
          model: 'yandex:yandexgpt-lite/latest',
          promptVersion: 'router@2',
          latencyMs: 90,
          ok: true,
          costMicros: 2_000_000,
          costCurrency: 'rub',
        },
        {
          userId: person.id,
          stage: 'classifier',
          model: 'модель-без-цены',
          promptVersion: 'classifier@7',
          latencyMs: 120,
          ok: true,
          costMicros: null,
        },
      ]);

    const report = await overview(testDb(), 30);

    expect(report.unpricedCalls).toBe(1);
  });
});
