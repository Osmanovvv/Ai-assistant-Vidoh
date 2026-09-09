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
 *
 * **Сам страж спал на четырёх ценах** (ревизия панели, находка 7).
 * Искалась строка «priceOf(» по всем исходникам, а `priceOf` там же и
 * объявлена — `export async function priceOf(` находило само себя.
 * Литералы четырёх цен лежат в её теле, в том же файле, поэтому и прямая
 * проверка была зелёной. Пропади у `priceOf` все вызывающие — страж
 * молчал бы ровно про те настройки, где §15 про деньги, то есть про
 * дефект «читатель есть, живого пути нет», от которого он и написан.
 *
 * Отсюда три правила, и каждое закрывает свой способ соврать:
 * 1. читатель ищется **вне файла, где он объявлен** (`homeOf`);
 * 2. объявление `SETTINGS` вычитается из текста (`withoutDeclaration`) —
 *    иначе список настроек доказывает читателя сам себе;
 * 3. панель в читатели не годится (`productSources`) — она читает
 *    настройку ради своих же чисел, а бот от этого не меняется.
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

interface Source {
  readonly path: string;
  readonly text: string;
}

/**
 * Текст файла без объявления `SETTINGS`.
 *
 * В объявлении литерал имени есть у **каждой** настройки по построению.
 * Не вычти его — и «сборщик правда читает эту настройку» доказывалось бы
 * самим списком настроек, лежащим в том же файле; опечатка в тройном
 * условии (`priceMonthlyStars` вместо годового дважды) осталась бы
 * незамеченной.
 */
function withoutDeclaration(text: string): string {
  const start = text.indexOf('export const SETTINGS = {');

  if (start === -1) return text;

  const end = text.indexOf('\n} as const;', start);

  return end === -1 ? text : text.slice(0, start) + text.slice(end);
}

/** Все исходники продукта: без проверок и без объявления `SETTINGS`. */
async function allSources(): Promise<readonly Source[]> {
  const found: Source[] = [];

  for await (const entry of glob('src/**/*.ts')) {
    const path = entry.split(sep).join('/');

    if (path.includes('.test.')) continue;

    found.push({ path, text: withoutDeclaration(await readFile(path, 'utf8')) });
  }

  return found;
}

/**
 * Где искать читателя настройки — и почему не везде.
 *
 * `settings.repo.ts` исключён целиком: кроме объявления там живут оба
 * сборщика, и их тела — не читатели, а сами читатели, чьих вызывающих мы
 * ищем отдельно.
 *
 * `http/admin` исключён потому, что **панель — не продукт**. Она читает
 * настройку, чтобы показать её же число (пробный период в воронке),
 * и настройка, которую читает только панель, не читается никем: бот от
 * её правки не меняется, а человек видит «Сохранено» и ждёт обратного.
 */
function productSources(all: readonly Source[]): readonly Source[] {
  return all.filter(
    (one) =>
      !one.path.endsWith('src/modules/settings/settings.repo.ts') &&
      !one.path.startsWith('src/http/admin/'),
  );
}

/**
 * Файл, где сборщик **объявлен**. Его собственное тело — не вызывающий.
 *
 * Ровно на этом страж и спал: строка «priceOf(» находилась в
 * `export async function priceOf(`.
 */
function homeOf(all: readonly Source[], collector: string): Source | undefined {
  const declaration = new RegExp(String.raw`\bfunction\s+${collector}\s*\(`, 'u');

  return all.find((one) => declaration.test(one.text));
}

/** Вызов, а не объявление и не хвост более длинного имени. */
function isCall(text: string, at: number): boolean {
  // Назад и недалеко: «export async function priceOf(» — девять знаков
  // от «function» до имени.
  const before = text.slice(Math.max(0, at - 16), at);

  return !/\b(?:function|const|let|var)\s+$/u.test(before) && !/[A-Za-z0-9_$]$/u.test(before);
}

/** Файлы, где сборщик действительно зовут — вне файла его объявления. */
function callersOf(
  sources: readonly Source[],
  collector: string,
  home: string | undefined,
): readonly string[] {
  const needle = `${collector}(`;

  return sources
    .filter((one) => one.path !== home)
    .filter((one) => {
      for (let at = one.text.indexOf(needle); at !== -1; at = one.text.indexOf(needle, at + 1)) {
        if (isCall(one.text, at)) return true;
      }

      return false;
    })
    .map((one) => one.path);
}

/** Сборщики без повторов: у `priceOf` четыре настройки, файл один. */
function collectors(): readonly string[] {
  return [...new Set(Object.values(THROUGH))];
}

describe('у каждой настройки есть читатель на живом пути', () => {
  it('имя настройки или её сборщик встречается в продуктовом коде', async () => {
    const all = await allSources();
    const product = productSources(all);
    const orphans: string[] = [];

    for (const name of Object.keys(SETTINGS) as SettingName[]) {
      const through = THROUGH[name];
      const home = through === undefined ? undefined : homeOf(all, through);

      // Прямое чтение — вне файла, где объявлен сборщик: литералы
      // четырёх цен лежат в теле самой `priceOf`.
      const direct = product.some(
        (one) => one.path !== home?.path && one.text.includes(`'${name}'`),
      );

      /**
       * Через сборщик — **два** условия, а не одно: сборщик обязан и
       * правда читать эту настройку, и иметь вызывающего вне своего
       * файла. Одного первого хватало бы мёртвому сборщику, одного
       * второго — сборщику, который эту настройку перестал читать.
       */
      const viaCollector =
        through !== undefined &&
        home !== undefined &&
        home.text.includes(`'${name}'`) &&
        callersOf(product, through, home.path).length > 0;

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
    const all = await allSources();
    const product = productSources(all);
    const dead: string[] = [];

    for (const collector of collectors()) {
      const home = homeOf(all, collector);

      // Сборщика не нашли вовсе — это тоже «нет живого пути», а не
      // повод пропустить проверку: переименуют, и страж уснёт.
      if (home === undefined || callersOf(product, collector, home.path).length === 0) {
        dead.push(collector);
      }
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

describe('предел числа тем доезжает до опроса', () => {
  /**
   * Реестр настроек доезжает до обработчика опроса **пятым, необязательным
   * аргументом** — и снять его можно молча (находка 6 ревизии панели):
   * прямой поиск литерала `'maxTopics'` останется зелёным, потому что
   * литерал лежит в самом обработчике, а проверки регистрируют его без
   * настроек нарочно. Цена забытой строки: предел снова станет константой
   * из кода, панель продолжит показывать число заказчицы, а бот будет
   * жить по чужому.
   *
   * По исходнику `src/index.ts`, а не подъёмом сборки: поднять запуск —
   * значит поднять базу, Redis, Telegram и модель. Тот же приём, что в
   * `dump.wiring.test.ts`.
   */
  it('реестр настроек передан обработчику опроса в боевой сборке', async () => {
    const index = await readFile('src/index.ts', 'utf8');
    const at = index.indexOf('registerOnboardingHandlers(bot');

    expect(at, 'сборки обработчика опроса в src/index.ts не найдено').toBeGreaterThan(-1);

    const call = index.slice(at, index.indexOf(');', at));

    expect(
      call,
      'в src/index.ts обработчику опроса не передан реестр настроек: предел числа тем молча станет константой из кода.',
    ).toContain('settings');
  });
});

describe('пути к папке проверок', () => {
  it('проверка смотрит на настоящее дерево, а не на пустоту', async () => {
    // Страж стража: сломайся сборка путей, и обе проверки выше стали бы
    // зелёными на пустом списке.
    const sources = productSources(await allSources());

    expect(sources.length).toBeGreaterThan(50);

    // Прежде эта строка стояла без матчера — то есть не утверждала
    // ничего (находка 7 ревизии панели). Проверок на ней держалось две.
    expect(
      sources.some((one) => one.path.endsWith(join('src', 'index.ts').split(sep).join('/'))),
      'боевой сборки src/index.ts в выборке нет — значит выборка собрана не оттуда',
    ).toBe(true);
  });

  it('объявление SETTINGS вычтено — иначе оно доказывает читателя само себе', async () => {
    const repo = (await allSources()).find((one) =>
      one.path.endsWith('src/modules/settings/settings.repo.ts'),
    );

    expect(repo, 'settings.repo.ts в выборке не найден').toBeDefined();

    // Ключи живут только в объявлении: остался хоть один — значит вычет
    // не сработал (переименовали `SETTINGS` или сменили формат), и
    // условие «сборщик читает настройку» станет зелёным от самого списка.
    expect(repo?.text).not.toContain("key: 'topics.max'");

    // А тела сборщиков вычетом задеть нельзя: по ним ищутся вызывающие.
    expect(repo?.text).toContain('effectiveLimits');
  });
});

/**
 * Обещание «переедет в админку» живёт вместе с настройкой или не живёт.
 *
 * Разбор «частично подтверждённых» нашёл его двумя экземплярами —
 * `config/env.ts` и `metering/limits.ts`, — при том что четвёртый этап
 * уходит в сдачу, а настройки расхода в реестре нет. Обещание в
 * комментарии тем и опасно, что читается как сделанное: следующий, кто
 * возьмётся за лимит, поверит, что ручка уже есть, и будет искать её в
 * панели.
 *
 * Страж связывает два места, а не запрещает фразу: вернуть обещание
 * можно — вместе с настройкой, которую оно обещает.
 */
describe('обещания про переезд настроек не расходятся с реестром', () => {
  /** Фразы, которыми в этом проекте обещают переезд значения в панель. */
  const PROMISES = ['переедет в админку', 'переедет в панель', 'переедут в админку'];

  it('обещавший переезд обязан показать настройку в реестре', async () => {
    const sources = await allSources();
    const promising = sources.filter((one) => PROMISES.some((phrase) => one.text.includes(phrase)));

    if (promising.length === 0) return;

    /**
     * Чем именно проверяется исполнение: у настройки расхода в реестре
     * должно быть имя. Другого способа «переехать в админку» у значения
     * нет — панель правит только то, что объявлено в `SETTINGS`.
     */
    const names: readonly string[] = Object.keys(SETTINGS);
    const spendKnob = names.some((name) => /spend|расход/iu.test(name));

    expect(
      spendKnob,
      `в ${promising.map((one) => one.path).join(', ')} обещан переезд значения в админку, ` +
        'а настройки расхода в SETTINGS нет. Либо завести её, либо снять обещание: ' +
        'комментарий читается как сделанное, и следующий будет искать ручку в панели.',
    ).toBe(true);
  });

  it('страж правда читает исходники', async () => {
    // Пустой обход сделал бы проверку выше вечно зелёной.
    const sources = await allSources();

    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((one) => one.path.endsWith('src/config/env.ts'))).toBe(true);
  });
});
