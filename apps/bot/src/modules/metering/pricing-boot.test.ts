import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { warnAboutUnpricedModels, type ModelPricing } from './pricing.js';

/**
 * Цену при подъёме спрашивают у всех, кто берёт деньги (§10.5).
 *
 * Ревизия этапов 1–2, молчаливый отказ. Проверка смотрела на одно
 * распознавание: написана 25.08.2026, когда платный провайдер был один, а
 * полная модель, лёгкая и вектора приехали следующим коммитом. Имя модели
 * приходит из окружения, значит смена ветки на ту, которой нет в прайсе,
 * уводила бы три четверти расхода на выгрузку в «цена неизвестна» — и об
 * этом не сказал бы никто: страж расхода ругается только при заданном
 * потолке, мягкий лимит — только у человека с лимитом.
 *
 * Проверяется **и вопрос, и ответ**. Вопрос — поведением функции, у
 * которой теперь свой голос; ответ — тем, что голос действительно звучит
 * и звучит на слышимом уровне. Прежняя мысль «сверить список имён в
 * исходнике» охраняла бы только половину: удали `logger.warn` — и она
 * осталась бы зелёной.
 */

const PRICES: Record<string, ModelPricing> = {
  'yandex:pro': { kind: 'tokens', currency: 'rub', inputPerMillion: 1, outputPerMillion: 2 },
};

function recording(): {
  warns: { context: object; message: string }[];
  warn: (context: object, message: string) => void;
} {
  const warns: { context: object; message: string }[] = [];

  return { warns, warn: (context, message) => warns.push({ context, message }) };
}

describe('проверка цен при подъёме', () => {
  it('называет все модели без цены, а не первую попавшуюся', () => {
    const log = recording();

    const unpriced = warnAboutUnpricedModels(
      log,
      ['yandex:pro', 'yandex:speech', 'yandex:lite', 'yandex:emb'],
      PRICES,
    );

    expect(unpriced).toEqual(['yandex:speech', 'yandex:lite', 'yandex:emb']);
  });

  it('молчание невозможно: список непуст — значит сказано вслух', () => {
    const log = recording();

    warnAboutUnpricedModels(log, ['yandex:speech'], PRICES);

    expect(log.warns, 'модель без цены прошла молча').toHaveLength(1);
    expect(log.warns[0]?.message).toContain('Цена модели неизвестна');
    expect(log.warns[0]?.context).toEqual({ models: ['yandex:speech'] });
  });

  it('когда все модели с ценой — не ворчит', () => {
    // Громкость, звучащая всегда, перестаёт значить что-либо.
    const log = recording();

    expect(warnAboutUnpricedModels(log, ['yandex:pro', 'yandex:pro'], PRICES)).toEqual([]);
    expect(log.warns).toEqual([]);
  });

  it('одна и та же модель не называется дважды', () => {
    // Полная и лёгкая ветка могут быть настроены на одну и ту же.
    const log = recording();

    expect(warnAboutUnpricedModels(log, ['x', 'x', 'y'], PRICES)).toEqual(['x', 'y']);
  });
});

describe('связка: подъём спрашивает у всех четырёх провайдеров', () => {
  /**
   * Страж по исходнику, и его предел назван вслух: он видит, какие имена
   * уходят в вызов, но не видит, не обрежет ли их кто-то по дороге.
   * Поведение самой проверки закрыто выше; здесь стережётся только то,
   * что её вообще спрашивают обо всех, — ровно тот разрыв, которым
   * находка и была.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, '../../index.ts'), 'utf8');

  it('в вызов уходят речь, полная модель, лёгкая и вектора', () => {
    const call = /warnAboutUnpricedModels\([^;]*;/u.exec(source)?.[0] ?? '';

    expect(call, 'проверка цен при подъёме не найдена вовсе').not.toBe('');

    for (const provider of ['speech.name', 'llm.name', 'llmLight.name', 'embedder.name']) {
      expect(call.includes(provider), `в проверку цен не уходит ${provider}`).toBe(true);
    }
  });

  it('список не обрезается по дороге', () => {
    // Обход, который иначе был бы бесшумным: имена перечислены все, а в
    // функцию уезжает первое.
    const call = /warnAboutUnpricedModels\([^;]*;/u.exec(source)?.[0] ?? '';

    expect(/\.(slice|filter|at)\(/u.test(call), 'список платных моделей обрезан').toBe(false);
  });
});
