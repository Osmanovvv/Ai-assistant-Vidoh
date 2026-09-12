import { beforeEach, describe, expect, it } from 'vitest';

import { items } from '../../db/schema.js';
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
  overrides: { readonly topic?: string; readonly deadlineAt?: Date } = {},
): Promise<void> {
  await testDb()
    .insert(items)
    .values({
      userId,
      text,
      type: 'TASK',
      priority: 'SOON',
      topic: overrides.topic ?? 'дети',
      status: where === 'done' ? 'done' : 'active',
      completedAt: where === 'done' ? new Date('2026-09-10T10:00:00.000Z') : null,
      // Ушедшее в фон (§13.6) поиск находит, а «открытые» не отдают.
      backgroundedAt: where === 'background' ? new Date() : null,
      embedding: vector(1, 0, 0),
      ...(overrides.deadlineAt === undefined
        ? {}
        : { deadlineAt: overrides.deadlineAt, deadlineAccuracy: 'day' as const }),
    });
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

  it('на завтра пусто — так и сказано, а не «ничего не записано»', async () => {
    await addItem('сдать отчёт', 'active', { deadlineAt: dayAfter(3) });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что на завтра', now: NOW },
    );

    expect(answer.kind).toBe('periodEmpty');
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

  it('«что на сегодня?» с просроченным — список', async () => {
    await addItem('сдать отчёт', 'active', { deadlineAt: new Date(Date.now() - 24 * 60 * 60_000) });

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что у меня на сегодня' },
    );

    expect(answer.kind).toBe('today');
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
