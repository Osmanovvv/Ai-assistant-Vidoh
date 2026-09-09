import { beforeEach, describe, expect, it } from 'vitest';

import { items } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
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

async function addItem(text: string, status: 'active' | 'snoozed'): Promise<void> {
  await testDb()
    .insert(items)
    .values({
      userId,
      text,
      type: 'TASK',
      priority: 'SOON',
      topic: 'дети',
      status,
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

  it('только отложенная — отвечает «ничего», а не шапкой в пустоту', async () => {
    /**
     * Главная проверка. Отложенную запись поиск находит, а «открытые»
     * не отдают — и человек получал заголовок «Вот что у меня про это
     * записано:» без единой строки под ним. Честное «ничего не
     * записано» он поймёт; пустую шапку прочтёт как поломку.
     */
    await addItem('записать сына в садик', 'snoozed');

    const answer = await answerBacklogQuery(
      { db: testDb(), embedder, logger },
      { userId, text: 'что там с садиком' },
    );

    expect(answer.kind).toBe('nothing');
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
