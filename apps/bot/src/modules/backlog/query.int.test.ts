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

async function addItem(text: string, where: 'active' | 'background'): Promise<void> {
  await testDb()
    .insert(items)
    .values({
      userId,
      text,
      type: 'TASK',
      priority: 'SOON',
      topic: 'дети',
      status: 'active',
      // Ушедшее в фон (§13.6) поиск находит, а «открытые» не отдают.
      backgroundedAt: where === 'background' ? new Date() : null,
      embedding: vector(1, 0, 0),
    });
}

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 9501, firstName: 'Аня' });

  userId = user.id;
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

  it('только ушедшая в фон — отвечает «ничего», а не шапкой в пустоту', async () => {
    /**
     * Главная проверка. Запись в фоне поиск находит, а «открытые» не
     * отдают — и человек получал заголовок «Вот что у меня про это
     * записано:» без единой строки под ним. Честное «ничего не
     * записано» он поймёт; пустую шапку прочтёт как поломку.
     *
     * До ревизии этапа 3 (C1) здесь была отложенная запись; теперь
     * отложенное открыто и на вопрос отвечает — прятать его от «что там
     * с садиком» было бы ложью.
     */
    await addItem('записать сына в садик', 'background');

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что там с садиком' },
    );

    expect(answer.kind).toBe('nothing');
  });

  it('«что на сегодня?» при пустом дне — «на сегодня пусто», а не «ничего не записано» (ревизия этапа 3, E16)', async () => {
    /**
     * У неё тридцать записей на следующую неделю; «ничего не записано»
     * читалось как «записей нет». Пустой день — свой ответ, тот же, что
     * у кнопки «Сегодня».
     */
    await testDb()
      .insert(items)
      .values({
        userId,
        text: 'сдать отчёт',
        type: 'TASK',
        priority: 'SOON',
        topic: 'работа',
        deadlineAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
        deadlineAccuracy: 'day',
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
