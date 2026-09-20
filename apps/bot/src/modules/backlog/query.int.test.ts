import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, topics } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { SpendCeilingError } from '../../infra/failures.js';
import { testDb } from '../../test/db.js';
import { MockEmbeddingProvider } from '../embedder/providers/mock.js';
import { PermanentEmbeddingError } from '../embedder/providers/types.js';
import type { EmbedRequest, EmbedResult, EmbeddingProvider } from '../embedder/providers/types.js';
import { upsertUser } from '../users/users.repo.js';
import { answerBacklogQuery } from './query.service.js';

/**
 * Вопрос по бэклогу не отвечает шапкой в пустоту (§13.6; ревизия этапа 2).
 *
 * **Что было.** Смысловой поиск и «открытые записи» смотрят на разные
 * наборы: поиск берёт и отложенные записи, а `openItemsFor` их не отдаёт.
 * Пересечение поэтому бывает пустым при непустом поиске — и человек
 * получал «Вот что у меня про это записано:» и ничего после двоеточия.
 *
 * Путь житейский: нажал под карточкой «Отложить», через день спросил «что
 * там с садиком». Проверок у этого пути не было **ни одной** — что и
 * позволило дефекту дожить до ревизии.
 */

const logger = createLogger({ level: 'silent' });
const DIMENSIONS = 256;

/** Вектор с заданным началом, остальное нули. */
function vector(...head: number[]): number[] {
  const full = new Array<number>(DIMENSIONS).fill(0);

  head.forEach((value, index) => {
    full[index] = value;
  });

  return full;
}

/**
 * Подделка провайдера векторов: всегда один и тот же вектор.
 *
 * Смысловой близости здесь и не надо — она мерится в проверках самого
 * поиска. Здесь важно другое: поиск **нашёл**, а показать нечего.
 */
const embedder: EmbeddingProvider = {
  name: 'подделка',
  dimensions: DIMENSIONS,
  embed: (request: EmbedRequest): Promise<EmbedResult> =>
    Promise.resolve({ vector: vector(1, 0, 0), model: 'подделка', tokens: request.text.length }),
};

let userId = '';

async function addItem(
  text: string,
  where: 'active' | 'background' | 'done',
  overrides: {
    readonly topic?: string;
    readonly deadlineAt?: Date;
    readonly accuracy?: 'day' | 'week' | 'month';
    readonly type?: 'TASK' | 'DESIRE' | 'IDEA';
    readonly isProject?: boolean;
    readonly deferredAt?: Date;
    readonly createdAt?: Date;
    readonly completedAt?: Date;
    readonly sourceBatchId?: string;
  } = {},
): Promise<void> {
  await testDb()
    .insert(items)
    .values({
      userId,
      text,
      type: overrides.type ?? 'TASK',
      priority: (overrides.type ?? 'TASK') === 'TASK' ? 'SOON' : 'NONE',
      topic: overrides.topic ?? 'дети',
      status: where === 'done' ? 'done' : 'active',
      completedAt:
        where === 'done' ? (overrides.completedAt ?? new Date('2026-09-10T10:00:00.000Z')) : null,
      // Ушедшее в фон (§13.6) поиск находит, а «открытые» не отдают.
      backgroundedAt: where === 'background' ? new Date() : null,
      embedding: vector(1, 0, 0),
      isProject: overrides.isProject ?? false,
      deferredAt: overrides.deferredAt ?? null,
      sourceBatchId: overrides.sourceBatchId ?? null,
      ...(overrides.createdAt === undefined ? {} : { createdAt: overrides.createdAt }),
      ...(overrides.deadlineAt === undefined
        ? {}
        : {
            deadlineAt: overrides.deadlineAt,
            deadlineAccuracy: overrides.accuracy ?? ('day' as const),
          }),
    });
}

async function addTopic(name: string): Promise<void> {
  await testDb().insert(topics).values({ userId, name });
}

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 9501, firstName: 'Аня' });

  userId = user.id;
});

describe('вопрос про день, кроме сегодняшнего (ревизия этапа 3, F2)', () => {
  const DAY = 24 * 60 * 60_000;
  // Пятница 04.09.2026, 12:00 по Москве.
  const NOW = new Date('2026-09-04T09:00:00.000Z');
  const dayAfter = (days: number): Date =>
    new Date(new Date('2026-09-03T21:00:00.000Z').getTime() + days * DAY);

  it('«что на завтра» — дела со сроком завтра, а не поиск по словам', async () => {
    /**
     * Слово о времени, кроме «сегодня», не узнавалось: вопрос уходил в
     * смысловой поиск по словам «что на завтра», ничего похожего не
     * находил, и человек с тремя делами на завтра читал «ничего не
     * записано».
     */
    await addItem('к стоматологу', 'active', { deadlineAt: dayAfter(1) });
    await addItem('сдать отчёт', 'active', { deadlineAt: dayAfter(3) });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что у меня на завтра', now: NOW },
    );

    expect(answer.kind).toBe('period');
    expect(answer.kind === 'period' ? answer.period : '').toBe('tomorrow');
    expect(answer.kind === 'period' ? answer.items.map((one) => one.text) : []).toEqual([
      'к стоматологу',
    ]);
  });

  it('«что на выходных» — суббота и воскресенье', async () => {
    await addItem('к стоматологу', 'active', { deadlineAt: dayAfter(1) }); // сб 05.09
    await addItem('к маме', 'active', { deadlineAt: dayAfter(2) }); // вс 06.09
    await addItem('сдать отчёт', 'active', { deadlineAt: dayAfter(3) }); // пн

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что на выходных', now: NOW },
    );

    expect(answer.kind === 'period' ? answer.items.map((one) => one.text) : []).toEqual([
      'к стоматологу',
      'к маме',
    ]);
  });

  it('«что на неделе» — ближайшие семь дней', async () => {
    await addItem('сдать отчёт', 'active', { deadlineAt: dayAfter(3) });
    await addItem('к врачу', 'active', { deadlineAt: dayAfter(10) });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что у меня на неделе', now: NOW },
    );

    expect(answer.kind === 'period' ? answer.items.map((one) => one.text) : []).toEqual([
      'сдать отчёт',
    ]);
  });

  it('неточный срок внутри окна тоже показывается: «на неделе с …» и «в …» (прогон 18.09.2026)', async () => {
    /**
     * Бой: «Расскажи мои задачи на ближайшую неделю» — стоматолог со
     * сроком «на неделе с 21.09» в ответ не попал: выборка брала только
     * точные дни. Неделя, начинающаяся внутри окна, — тоже на этой
     * неделе; месяц, начинающийся внутри окна, — тоже.
     */
    // NOW — пятница 04.09; окно недели — 04.09…10.09.
    await addItem('к стоматологу', 'active', { deadlineAt: dayAfter(3), accuracy: 'week' }); // пн 07.09
    await addItem('сдать отчёт', 'active', { deadlineAt: dayAfter(1) });
    await addItem('к врачу', 'active', { deadlineAt: dayAfter(10), accuracy: 'week' }); // пн 14.09
    await addItem('диспансеризация', 'active', {
      deadlineAt: new Date('2026-09-30T21:00:00.000Z'),
      accuracy: 'month',
    });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что у меня на неделе', now: NOW },
    );

    expect(answer.kind === 'period' ? answer.items.map((one) => one.text) : []).toEqual([
      'сдать отчёт',
      'к стоматологу',
    ]);
  });

  it('на завтра неточный срок не показывается: «завтра» — день, а неделя — не день', async () => {
    await addItem('к стоматологу', 'active', { deadlineAt: dayAfter(1), accuracy: 'week' });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что на завтра', now: NOW },
    );

    expect(answer.kind).toBe('periodEmpty');
  });

  it('на завтра пусто — так и сказано, а не «ничего не записано»', async () => {
    await addItem('сдать отчёт', 'active', { deadlineAt: dayAfter(3) });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что на завтра', now: NOW },
    );

    expect(answer.kind).toBe('periodEmpty');
  });

  /**
   * Отрезки, которых не было (21.09.2026, вопрос Никиты): N дней,
   * послезавтра, следующая неделя, месяц, названный месяц, день недели.
   * NOW — пятница 04.09.2026, 12:00 по Москве; `dayAfter(0)` — сегодня.
   */
  const listOf = async (text: string): Promise<readonly string[]> => {
    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text, now: NOW },
    );
    return answer.kind === 'period' ? answer.items.map((one) => one.text) : [answer.kind];
  };

  it('«на 3 дня» — сегодня, завтра и послезавтра', async () => {
    await addItem('сегодняшнее', 'active', { deadlineAt: dayAfter(0) });
    await addItem('послезавтрашнее', 'active', { deadlineAt: dayAfter(2) });
    await addItem('через три дня', 'active', { deadlineAt: dayAfter(3) });

    expect(await listOf('что у меня на эти 3 дня')).toEqual(['сегодняшнее', 'послезавтрашнее']);
  });

  it('«на послезавтра» — один день', async () => {
    await addItem('завтрашнее', 'active', { deadlineAt: dayAfter(1) });
    await addItem('послезавтрашнее', 'active', { deadlineAt: dayAfter(2) });

    expect(await listOf('что на послезавтра')).toEqual(['послезавтрашнее']);
  });

  it('«на следующей неделе» — с понедельника по воскресенье, не семь дней от сегодня', async () => {
    await addItem('в это воскресенье', 'active', { deadlineAt: dayAfter(2) }); // вс 06.09
    await addItem('в следующий понедельник', 'active', { deadlineAt: dayAfter(3) }); // пн 07.09
    await addItem('в следующее воскресенье', 'active', { deadlineAt: dayAfter(9) }); // вс 13.09
    await addItem('через две недели', 'active', { deadlineAt: dayAfter(10) }); // пн 14.09

    expect(await listOf('что у меня на следующей неделе')).toEqual([
      'в следующий понедельник',
      'в следующее воскресенье',
    ]);
  });

  it('«на месяц» — тридцать дней от сегодня, неточные сроки внутри окна тоже', async () => {
    await addItem('сегодняшнее', 'active', { deadlineAt: dayAfter(0) });
    await addItem('на той неделе', 'active', { deadlineAt: dayAfter(10), accuracy: 'week' });
    await addItem('через 29 дней', 'active', { deadlineAt: dayAfter(29) });
    await addItem('через 31 день', 'active', { deadlineAt: dayAfter(31) });

    expect(await listOf('что у меня на месяц')).toEqual([
      'сегодняшнее',
      'на той неделе',
      'через 29 дней',
    ]);
  });

  it('«в октябре» — календарный месяц', async () => {
    await addItem('в конце сентября', 'active', {
      deadlineAt: new Date('2026-09-29T21:00:00.000Z'),
    });
    await addItem('первого октября', 'active', {
      deadlineAt: new Date('2026-09-30T21:00:00.000Z'),
    });
    await addItem('в октябре где-то', 'active', {
      deadlineAt: new Date('2026-09-30T21:00:00.000Z'),
      accuracy: 'month',
    });
    await addItem('первого ноября', 'active', { deadlineAt: new Date('2026-10-31T21:00:00.000Z') });

    expect(await listOf('что у меня в октябре')).toEqual(['первого октября', 'в октябре где-то']);
  });

  it('«в сентябре», спрошенное в сентябре, — остаток месяца', async () => {
    await addItem('вчерашнее', 'active', { deadlineAt: dayAfter(-1) });
    await addItem('сегодняшнее', 'active', { deadlineAt: dayAfter(0) });
    await addItem('в конце сентября', 'active', {
      deadlineAt: new Date('2026-09-29T21:00:00.000Z'),
    });
    await addItem('первого октября', 'active', {
      deadlineAt: new Date('2026-09-30T21:00:00.000Z'),
    });

    expect(await listOf('что в сентябре')).toEqual(['сегодняшнее', 'в конце сентября']);
  });

  it('«во вторник» — ближайший вторник, «в следующий вторник» — через неделю после него', async () => {
    await addItem('во вторник', 'active', { deadlineAt: dayAfter(4) }); // вт 08.09
    await addItem('через неделю во вторник', 'active', { deadlineAt: dayAfter(11) }); // вт 15.09

    expect(await listOf('что у меня во вторник')).toEqual(['во вторник']);
    expect(await listOf('что в следующий вторник')).toEqual(['через неделю во вторник']);
  });

  it('на день недели пусто — «на вторник ничего не назначено», а не поиск предмета', async () => {
    await addItem('сдать отчёт', 'active', { deadlineAt: dayAfter(3) });

    expect(await listOf('что у меня во вторник')).toEqual(['periodEmpty']);
  });
});

describe('вопрос внутри ветки сферы (ревизия этапа 3, F4)', () => {
  it('сужается до сферы ветки', async () => {
    await addItem('к стоматологу', 'active', { topic: 'здоровье' });
    await addItem('к стоматологу с ребёнком', 'active', { topic: 'дети' });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что там со стоматологом', topic: 'здоровье' },
    );

    expect(answer.kind === 'about' ? answer.items.map((one) => one.topic) : []).toEqual([
      'здоровье',
    ]);
  });
});

describe('без провайдера векторов (ревизия этапа 3, F3)', () => {
  it('«не смогла посмотреть», а не «ничего не записано»', async () => {
    await addItem('записать сына в садик', 'active');

    const answer = await answerBacklogQuery(
      { db: testDb(), logger },
      { userId, text: 'что там с садиком' },
    );

    expect(answer.kind).toBe('unavailable');
  });
});

describe('вопрос про дело, которое нашлось поиском', () => {
  it('открытая запись — отвечает списком', async () => {
    await addItem('записать сына в садик', 'active');

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что там с садиком' },
    );

    expect(answer.kind).toBe('about');
    expect(answer.kind === 'about' ? answer.items.length : 0).toBeGreaterThan(0);
  });

  it('закрытое дело — «записано, но закрыто», а не «ничего не записано» (ревизия этапа 3, F1)', async () => {
    /**
     * «Что там с днём рождения?» — «ничего не записано», хотя вчера
     * нажала «сделано». Поиск находил запись, отсев по открытым выбрасывал
     * её, и пустой остаток читался как «ничего». Человек решал, что бот
     * забыл.
     */
    await addItem('заказать торт на день рождения', 'done');

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что там с тортом' },
    );

    expect(answer.kind).toBe('aboutClosed');
    expect(answer.kind === 'aboutClosed' ? answer.items.map((one) => one.text) : []).toEqual([
      'заказать торт на день рождения',
    ]);
  });

  it('ушедшее в фон — тоже названо, а не спрятано за «ничего» (F1)', async () => {
    await addItem('записать сына в садик', 'background');

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что там с садиком' },
    );

    expect(answer.kind).toBe('aboutClosed');
  });

  it('открытое важнее закрытого: если есть и то, и другое — список открытых', async () => {
    await addItem('заказать торт', 'done');
    await addItem('заказать торт побольше', 'active');

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что там с тортом' },
    );

    expect(answer.kind).toBe('about');
  });

  it('«что на сегодня?» с делом на сегодня — список', async () => {
    // Просроченное в «Сегодня» больше не идёт (запрос №4): оно
    // разбирается утром. Сюда — дело со сроком в ближайший час.
    // Момент — полдень, а не `Date.now()`: после 23:00 по Москве «через
    // час» — уже завтра, и тест краснел по часам, а не по коду.
    const noon = new Date('2026-09-04T09:00:00.000Z');
    await addItem('сдать отчёт', 'active', { deadlineAt: new Date(noon.getTime() + 60 * 60_000) });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что у меня на сегодня', now: noon },
    );

    expect(answer.kind).toBe('today');
  });

  it('«что на сегодня?» при пустом дне называет, сколько открытых дел (находка 21)', async () => {
    await addItem('записать сына в садик', 'active');
    await addItem('купить корм коту', 'active');
    await addItem('старое', 'done');

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что у меня на сегодня' },
    );

    expect(answer).toEqual({ kind: 'todayEmpty', open: 2 });
  });

  it('«что на сегодня?» при пустом дне — «на сегодня пусто», а не «ничего не записано» (ревизия этапа 3, E16)', async () => {
    // У неё тридцать записей на следующую неделю; «ничего не записано»
    // читалось как «записей нет». Пустой день — свой ответ.
    await addItem('сдать отчёт', 'active', {
      deadlineAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что у меня на сегодня' },
    );

    expect(answer.kind).toBe('todayEmpty');
  });

  it('без похожего вовсе — тоже «ничего»', async () => {
    // Обратная сторона: правило не должно превращать «нашлось» в
    // «ничего» всегда — иначе ответ по бэклогу перестал бы работать.
    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что там с садиком' },
    );

    expect(answer.kind).toBe('nothing');
  });
});

describe('вопрос обо всём сразу (заказчица, 16.09.2026, панель п. 3)', () => {
  /**
   * На бою 16.09.2026 она спросила «Покажи все мои задачи» и «Какие у
   * меня есть задачи?» — и при шести делах в базе получила «Про это у
   * меня ничего не записано». Путей было два: «что на сегодня» и «что
   * там с <предметом>» через поиск по смыслу; вопрос без предмета уходил
   * во второй, а на «все задачи» ничего похожего не находилось. Вопрос,
   * в котором нет ни дня, ни предмета, — про всё: отвечается списком
   * открытых дел.
   */
  it('«Покажи все мои задачи» — список всех открытых дел', async () => {
    await addItem('Заказать цветы', 'active');
    await addItem('Написать список продуктов мужу', 'active');
    await addItem('Купить торт', 'done');

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'Покажи все мои задачи' },
    );

    expect(answer.kind).toBe('all');
    if (answer.kind !== 'all') return;
    expect(answer.items.map((item) => item.text).sort()).toEqual([
      'Заказать цветы',
      'Написать список продуктов мужу',
    ]);
  });

  it('«Какие у меня есть задачи?», «что записано?», «что у меня в списке?» — тоже про всё', async () => {
    await addItem('Заказать цветы', 'active');

    for (const text of [
      'Какие у меня есть задачи?',
      'что у меня записано',
      'Что у меня в списке?',
      'какие дела',
    ]) {
      const answer = await answerBacklogQuery({ db: testDb(), embedder, logger }, { userId, text });
      expect(answer.kind, text).toBe('all');
    }
  });

  it('вопрос обо всём при пустом бэклоге — «пусто», а не «ничего не записано» про несуществующий предмет', async () => {
    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'Покажи все мои задачи' },
    );

    expect(answer.kind).toBe('allEmpty');
  });

  it('вопрос с предметом по-прежнему идёт поиском, а про день — списком дня', async () => {
    await addItem('Заказать цветы', 'active');

    expect(
      (
        await answerBacklogQuery(
          { db: testDb(), embedder, logger },
          { userId, text: 'что там с цветами' },
        )
      ).kind,
    ).toBe('about');
    expect(
      (
        await answerBacklogQuery(
          { db: testDb(), embedder, logger },
          { userId, text: 'что на сегодня' },
        )
      ).kind,
    ).toBe('todayEmpty');
  });

  it('внутри ветки сферы «все задачи» — только её', async () => {
    await addItem('Заказать цветы', 'active', { topic: 'дом' });
    await addItem('Записать сына к врачу', 'active', { topic: 'дети' });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'покажи все задачи', topic: 'дети' },
    );

    expect(answer.kind).toBe('all');
    if (answer.kind !== 'all') return;
    expect(answer.items.map((item) => item.text)).toEqual(['Записать сына к врачу']);
  });
});

describe('наш простой не выдаётся за отсутствие записей', () => {
  /**
   * Ревизия этапов 1–2, молчаливый отказ — и самый дорогой из них для
   * человека.
   *
   * Вектор вопроса не посчитался — перейдённый потолок расхода, 403 от
   * провайдера, таймаут, — и бот отвечал «Про это у меня ничего не
   * записано» про существующую запись. Наш сбой становился утверждением
   * о делах человека, а единственный его читатель — сам человек, и
   * проверить это ему нечем. Партия при этом закрывается успешной,
   * повтора не будет, и ответ остаётся навсегда.
   *
   * Мониторинг тоже слеп: отказ съеден внутри разбора, задание
   * завершается успехом, срочное оповещение про наш простой висит на
   * ветке отказа задания и не срабатывает вовсе.
   */

  it('вектор не посчитался — это «не смогла посмотреть», а не «ничего нет»', async () => {
    await addItem('записать сына в садик', 'active');

    const broken = new MockEmbeddingProvider({
      failFirst: { times: 5, error: new PermanentEmbeddingError('модель недоступна') },
    });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder: broken, logger },
      { userId, text: 'что там с садиком' },
    );

    expect(answer.kind, 'наш сбой выдан за отсутствие записей').toBe('unavailable');
  });

  it('перейдённый потолок расхода — то же самое', async () => {
    /**
     * Здесь неправда особенно дорога: записи на месте, деньги кончились
     * у нас, а человек читает, что у него ничего не записано.
     */
    await addItem('записать сына в садик', 'active');

    const answer = await answerBacklogQuery(
      {
        db: testDb(),
        embedder,
        logger,
        spendGuard: {
          beforeCall: () => Promise.reject(new SpendCeilingError('потолок за сутки перейдён')),
          noteSpent: () => undefined,
          report: () => Promise.resolve([]),
        },
      },
      { userId, text: 'что там с садиком' },
    );

    expect(answer.kind).toBe('unavailable');
  });

  it('исправный поиск по-прежнему отвечает «ничего», когда нечего показать', async () => {
    // Обратная сторона: «не смогла» не должно вытеснить честное
    // «ничего не записано» — иначе человек перестанет верить и ему.
    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что там с садиком' },
    );

    expect(answer.kind).toBe('nothing');
  });
});

describe('вопросы-списки по признаку (21.09.2026)', () => {
  const DAY = 24 * 60 * 60_000;
  // Пятница 04.09.2026, 12:00 по Москве.
  const NOW = new Date('2026-09-04T09:00:00.000Z');
  const dayAfter = (days: number): Date =>
    new Date(new Date('2026-09-03T21:00:00.000Z').getTime() + days * DAY);

  const ask = async (text: string, batchId?: string) =>
    await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text, now: NOW, ...(batchId === undefined ? {} : { batchId }) },
    );
  const titles = (answer: Awaited<ReturnType<typeof ask>>): readonly string[] =>
    answer.kind === 'listed' ? answer.items.map((one) => one.text) : [answer.kind];

  it('«что просрочено» — дела с прошедшим сроком, просроченные неточные тоже, сегодняшние — нет', async () => {
    await addItem('вчерашнее', 'active', { deadlineAt: dayAfter(-1) });
    await addItem('на прошлой неделе', 'active', { deadlineAt: dayAfter(-10), accuracy: 'week' });
    await addItem('на этой неделе', 'active', { deadlineAt: dayAfter(-3), accuracy: 'week' });
    await addItem('сегодняшнее', 'active', { deadlineAt: dayAfter(0) });
    await addItem('закрытое старое', 'done', { deadlineAt: dayAfter(-5) });

    const answer = await ask('что просрочено');
    expect(answer.kind === 'listed' && answer.question.kind).toBe('overdue');
    expect(titles(answer)).toEqual(['на прошлой неделе', 'вчерашнее']);
  });

  it('«что на потом» — отложенные, «что без срока» — открытые дела без даты', async () => {
    await addItem('отложенное', 'active', { deferredAt: dayAfter(-2) });
    await addItem('без даты', 'active');
    await addItem('с датой', 'active', { deadlineAt: dayAfter(2) });
    await addItem('мечта', 'active', { type: 'DESIRE' });

    expect(titles(await ask('что на потом'))).toEqual(['отложенное']);
    expect(titles(await ask('что без срока'))).toEqual(['без даты', 'отложенное']);
  });

  it('«сколько у меня дел» — открытые дела с раскладкой: сегодня, просрочено, на потом', async () => {
    await addItem('просроченное', 'active', { deadlineAt: dayAfter(-1) });
    await addItem('сегодняшнее', 'active', { deadlineAt: dayAfter(0) });
    await addItem('отложенное', 'active', { deferredAt: dayAfter(-2) });
    await addItem('просто дело', 'active');
    await addItem('мечта', 'active', { type: 'DESIRE' });
    await addItem('закрытое', 'done');

    const answer = await ask('сколько у меня дел');
    // «Сегодня» — по правилу продукта: просроченное в него не входит (запрос №4).
    expect(answer).toEqual({ kind: 'count', open: 4, today: 1, overdue: 1, later: 1 });
  });

  it('«с чего начать» — тот же выбор главного, что у кнопки', async () => {
    expect((await ask('с чего начать')).kind).toBe('pick');
    expect((await ask('что важное')).kind).toBe('pick');
  });

  it('«что я сегодня записала» — записанное сегодня, «что последнее» — последняя выгрузка', async () => {
    const [older] = await testDb()
      .insert(batches)
      .values({ userId, status: 'done', combinedText: 'старая', openedAt: dayAfter(-3) })
      .returning({ id: batches.id });
    const [latest] = await testDb()
      .insert(batches)
      .values({ userId, status: 'done', combinedText: 'вчерашняя', openedAt: dayAfter(-1) })
      .returning({ id: batches.id });
    const [current] = await testDb()
      .insert(batches)
      .values({ userId, status: 'processing', combinedText: 'что последнее', openedAt: NOW })
      .returning({ id: batches.id });

    await addItem('позавчерашняя запись', 'active', {
      createdAt: dayAfter(-3),
      sourceBatchId: older!.id,
    });
    await addItem('вчерашняя запись', 'active', {
      createdAt: dayAfter(-1),
      sourceBatchId: latest!.id,
    });
    await addItem('сегодняшняя запись', 'active', { createdAt: NOW });

    expect(titles(await ask('что я сегодня записала'))).toEqual(['сегодняшняя запись']);
    // Текущая выгрузка — сам вопрос, и её записи не «последние».
    expect(titles(await ask('что последнее записала', current!.id))).toEqual(['вчерашняя запись']);
  });

  it('«что я сделала за неделю» — закрытые за последние семь дней; «вчера» — за вчера', async () => {
    await addItem('закрыто сегодня', 'done', { completedAt: new Date(NOW.getTime() - 3_600_000) });
    await addItem('закрыто вчера', 'done', { completedAt: dayAfter(-1) });
    await addItem('закрыто неделю назад', 'done', { completedAt: dayAfter(-8) });
    await addItem('открытое', 'active');

    expect(titles(await ask('что я сделала за неделю'))).toEqual([
      'закрыто вчера',
      'закрыто сегодня',
    ]);
    expect(titles(await ask('что я сделала вчера'))).toEqual(['закрыто вчера']);
    expect(titles(await ask('что я сделала сегодня'))).toEqual(['закрыто сегодня']);
  });

  it('«покажи желания», «идеи», «цели» — по виду записи', async () => {
    await addItem('дело', 'active');
    await addItem('мечта', 'active', { type: 'DESIRE' });
    await addItem('замысел', 'active', { type: 'IDEA' });
    await addItem('большая цель', 'active', { isProject: true });
    await addItem('цель-желание', 'active', { type: 'DESIRE', isProject: true });

    expect(titles(await ask('покажи желания'))).toEqual(['цель-желание', 'мечта']);
    expect(titles(await ask('какие у меня идеи'))).toEqual(['замысел']);
    expect(titles(await ask('какие у меня цели'))).toEqual(['цель-желание', 'большая цель']);
  });

  it('«что по работе» — дела сферы человека, названной любым падежом', async () => {
    await addTopic('работа');
    await addTopic('дом');
    await addItem('отчёт', 'active', { topic: 'работа' });
    await addItem('полка', 'active', { topic: 'дом' });
    await addItem('витамины', 'active', { topic: 'здоровье' });

    expect(titles(await ask('что по работе'))).toEqual(['отчёт']);
    expect(titles(await ask('что у меня по дому'))).toEqual(['полка']);
    // Сферы «учёба» у человека нет — это вопрос про предмет, не про сферу.
    expect((await ask('что по учёбе')).kind).not.toBe('listed');
  });

  it('пустой список — тоже ответ, а не «ничего не записано»', async () => {
    await addItem('дело', 'active');

    const answer = await ask('что просрочено');
    expect(answer.kind).toBe('listed');
    expect(answer.kind === 'listed' && answer.items).toEqual([]);
  });
});
