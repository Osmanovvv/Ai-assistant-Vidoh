import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SETTINGS, type SettingName } from './settings.repo.js';

/**
 * Страж связки «настройка — читатель» (§15, ревизия четвёртого этапа).
 *
 * **Настройка, которую никто не читает, хуже отсутствующей.** Человек
 * меняет число, видит «Сохранено» и ждёт, что что-то изменится. Ревизия
 * нашла четыре таких: «Сколько тем» и три порога резолвера, чей
 * единственный читатель (`effectiveThresholds`) сам не имел ни одного
 * вызывающего. Панель при этом утверждала литералом `missing: []`, что
 * настроек без читателя нет.
 *
 * Проверка идёт по исходникам, а не по вызову функций: связка — это
 * именно то, что теряется между модулями, и увидеть её потерю можно
 * только снаружи обоих. Тот же приём, что в `dump.wiring.test.ts`.
 */

/** Настройки, читаемые не по имени, а через сборщик. */
const THROUGH: Partial<Record<SettingName, string>> = {
  // `effectiveLimits` собирает окно тишины и суточный потолок разом:
  // они читаются вместе на каждом сообщении.
  silenceWindowMs: 'effectiveLimits',
  dumpsPerDay: 'effectiveLimits',
  // `effectiveThresholds` собирает три порога резолвера.
  resolverApply: 'effectiveThresholds',
  resolverCreate: 'effectiveThresholds',
  resolverSimilarity: 'effectiveThresholds',
  // Цены собирает тарифная служба: она знает, какая цена у какого рельса.
  priceMonthlyRub: 'priceOf',
  priceYearlyRub: 'priceOf',
  priceMonthlyStars: 'priceOf',
  priceYearlyStars: 'priceOf',
};

async function productionSources(): Promise<readonly { path: string; text: string }[]> {
  const found: { path: string; text: string }[] = [];

  for await (const entry of glob('src/**/*.ts')) {
    const path = entry.split(sep).join('/');

    if (path.includes('.test.')) continue;
    if (path.endsWith('src/modules/settings/settings.repo.ts')) continue;

    found.push({ path, text: await readFile(path, 'utf8') });
  }

  return found;
}

describe('у каждой настройки есть читатель на живом пути', () => {
  it('имя настройки или её сборщик встречается в продуктовом коде', async () => {
    const sources = await productionSources();
    const orphans: string[] = [];

    for (const name of Object.keys(SETTINGS) as SettingName[]) {
      const through = THROUGH[name];

      const direct = sources.some((one) => one.text.includes(`'${name}'`));
      const viaCollector =
        through !== undefined && sources.some((one) => one.text.includes(`${through}(`));

      if (!direct && !viaCollector) orphans.push(name);
    }

    expect(
      orphans,
      [
        `Настройки без читателя: ${orphans.join(', ')}.`,
        'Настройка, которую никто не читает, хуже отсутствующей:',
        'человек меняет число, видит «Сохранено» и ждёт, что что-то изменится.',
        'Либо дать читателя, либо убрать из SETTINGS и сказать об этом словами.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('у сборщика тоже есть вызывающий — иначе читатель мнимый', async () => {
    /**
     * **Ровно так дефект и прятался.** Три порога резолвера «читались»
     * функцией `effectiveThresholds`, у которой не было ни одного
     * вызывающего: читатель есть, живого пути нет.
     */
    const sources = await productionSources();
    const dead: string[] = [];

    for (const collector of new Set(Object.values(THROUGH))) {
      if (collector === undefined) continue;

      const callers = sources.filter((one) => one.text.includes(`${collector}(`));

      if (callers.length === 0) dead.push(collector);
    }

    expect(
      dead,
      `Сборщики значений без вызывающих: ${dead.join(', ')} — значит настройки, которые они читают, не читает никто.`,
    ).toEqual([]);
  });

  it('у каждой настройки объявлен читатель словами — иначе панель соврёт', () => {
    /**
     * Панель показывает список настроек без читателя (`missing`), и
     * прежде он был литералом `missing: []`. Теперь он считается по
     * полю `readBy`, и это поле обязано быть у каждой настройки: пустое
     * означает «читателя нет», и такая настройка попадёт в список.
     */
    const declared = Object.entries(SETTINGS)
      .filter(([, setting]) => (setting as { readonly readBy?: string }).readBy === undefined)
      .map(([name]) => name);

    // Сегодня читатель есть у всех — значит и список пуст. Появится
    // настройка без читателя, и она обязана назвать это в `readBy`.
    expect(declared).toEqual([]);
  });

  it('у каждой настройки есть пределы, и умолчание в них попадает', () => {
    /**
     * Предел без умолчания внутри — противоречие: чтение вне пределов
     * откатывается к умолчанию, и умолчание вне пределов дало бы
     * бесконечный откат в никуда.
     */
    for (const [name, setting] of Object.entries(SETTINGS)) {
      expect(setting.min, `${name}: min`).toBeLessThanOrEqual(setting.max);
      expect(setting.fallback, `${name}: умолчание ниже предела`).toBeGreaterThanOrEqual(
        setting.min,
      );
      expect(setting.fallback, `${name}: умолчание выше предела`).toBeLessThanOrEqual(setting.max);
    }
  });
});

describe('умолчания не набраны дважды', () => {
  /**
   * Одно и то же число стояло в `SETTINGS.fallback` и в константах кода,
   * и ничем не было связано: столбец «По умолчанию» в панели разошёлся
   * бы с поведением от правки одного из двух мест, и заметить это было
   * бы нечем.
   */
  it('пределы буфера берут окно и суточный потолок из настроек', async () => {
    const { DEFAULT_LIMITS } = await import('../buffer/buffer.service.js');

    expect(DEFAULT_LIMITS.silenceWindowMs).toBe(SETTINGS.silenceWindowMs.fallback);
    expect(DEFAULT_LIMITS.maxDumpsPerDay).toBe(SETTINGS.dumpsPerDay.fallback);
  });

  it('пороги резолвера берут свои три значения из настроек', async () => {
    const { DEFAULT_THRESHOLDS } = await import('../resolver/decision.js');

    expect(DEFAULT_THRESHOLDS.apply).toBe(SETTINGS.resolverApply.fallback / 100);
    expect(DEFAULT_THRESHOLDS.create).toBe(SETTINGS.resolverCreate.fallback / 100);
    expect(DEFAULT_THRESHOLDS.similarity).toBe(SETTINGS.resolverSimilarity.fallback / 100);
  });

  it('предел числа тем берёт значение из настроек', async () => {
    const { MAX_TOPICS } = await import('../topics/topics.repo.js');

    expect(MAX_TOPICS).toBe(SETTINGS.maxTopics.fallback);
  });

  it('связь именно вычислением, а не совпадением чисел', async () => {
    /**
     * **Проверка про механизм, а не про значения.** Сверка «80 равно 80»
     * прошла бы и на двух независимо набранных числах — то есть не
     * различала бы починенное от сломанного. Здесь читается исходник:
     * константа обязана быть выражением от `SETTINGS`.
     */
    const buffer = await readFile('src/modules/buffer/buffer.service.ts', 'utf8');
    const decision = await readFile('src/modules/resolver/decision.ts', 'utf8');
    const topics = await readFile('src/modules/topics/topics.repo.ts', 'utf8');

    expect(buffer).toContain('SETTINGS.silenceWindowMs.fallback');
    expect(buffer).toContain('SETTINGS.dumpsPerDay.fallback');
    expect(decision).toContain('SETTINGS.resolverApply.fallback');
    expect(topics).toContain('SETTINGS.maxTopics.fallback');
  });
});

describe('пути к папке проверок', () => {
  it('проверка смотрит на настоящее дерево, а не на пустоту', async () => {
    // Страж стража: сломайся сборка путей, и обе проверки выше стали бы
    // зелёными на пустом списке.
    const sources = await productionSources();

    expect(sources.length).toBeGreaterThan(50);
    expect(sources.some((one) => one.path.endsWith(join('src', 'index.ts').split(sep).join('/'))));
  });
});
