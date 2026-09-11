import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { sep } from 'node:path';

import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { paidSql, unpricedCountSql, unpricedSql } from './unpriced.js';

/**
 * Готовый текст запроса.
 *
 * `SQL` — дерево, а не строка: у него нет `.sql`, и собрать текст можно
 * только диалектом, тем же, которым его собирает драйвер. Иначе проверка
 * мерила бы не то, что уедет в Postgres.
 */
const dialect = new PgDialect();

function rendered(fragment: ReturnType<typeof unpricedSql>): string {
  return dialect.sqlToQuery(fragment).sql;
}

/**
 * «Вызовов без цены» считается **одним** условием (ревизия панели).
 *
 * Условие забывали дважды: сперва в `account-spend.ts` (там об этом
 * написано своими словами), потом — в пяти местах разом: обзор, строка
 * человека, расход человека для §10.5 и два разреза раздела расходов.
 * Пока условие переписывалось руками, «забыть» его было делом одной
 * строки, и заметить это было неоткуда: сорвавшийся вызов попадал и в
 * «сбоев», и в «без цены», а рядом печаталась оговорка «расход не меньше
 * показанного».
 *
 * Поэтому страж проверяет не поведение, а **устройство**: сырого условия
 * в продуктовом коде быть не должно вовсе.
 */

/**
 * Исходник без комментариев.
 *
 * Иначе страж не отличает цитату от кода: прежнее условие в разборах
 * принято описывать словами, и проверка краснела бы от собственного
 * объяснения. `//` внутри адреса (`https://`) — не комментарий.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/u, '$1'))
    .join('\n');
}

/** Продуктовые исходники, кроме самого дома условия и проверок. */
async function productSources(): Promise<readonly { path: string; text: string }[]> {
  const found: { path: string; text: string }[] = [];

  for await (const entry of glob('src/**/*.ts')) {
    const path = entry.split(sep).join('/');

    if (path.includes('.test.')) continue;
    // Дом условия — единственное место, где оно написано словами.
    if (path.endsWith('/metering/unpriced.ts')) continue;

    found.push({ path, text: code(await readFile(path, 'utf8')) });
  }

  return found;
}

describe('вызовы без цены считаются одним условием', () => {
  it('ни один запрос не пишет условие сам', async () => {
    const sources = await productSources();

    // Страж стража: файлов должно быть найдено много. Сломанный обход
    // сделал бы проверку вечно зелёной.
    expect(sources.length).toBeGreaterThan(50);

    const own: string[] = [];

    for (const source of sources) {
      /**
       * Ищем оба написания разом: и сырой SQL, и вариант через drizzle.
       * Первым обошли условие в разрезах расходов, вторым — в обзоре.
       */
      const raw = /costMicros\}\s*is\s*null/u.test(source.text);
      const viaDrizzle = /isNull\(\s*aiCalls\.costMicros\s*\)/u.test(source.text);

      if (raw || viaDrizzle) own.push(source.path);
    }

    expect(
      own,
      [
        'Условие «вызов без цены» написано мимо общего:',
        '',
        ...own,
        '',
        'Зовите unpricedSql() или unpricedCountSql() из modules/metering/unpriced.ts.',
        'Причина — в докстринге там же: без фильтра по успеху оговорка',
        '«расход не меньше показанного» загорается от любого сбоя модели.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('ни один запрос не пишет условие оплаченности сам', async () => {
    /**
     * Вторая половина того же условия — «за отправку платили» — тоже
     * переписывалась руками (ревизия этапов 1–2, дефект №11).
     *
     * Себестоимость (`scripts/cost-report.ts`) держала своё условие через
     * drizzle, а здесь оно жило сырым SQL. Сперва они расходились по
     * смыслу: скрипт брал всё подряд, и сорвавшийся вызов делал модель
     * «без цены» и выбрасывал выгрузку из средней. Потом их дважды
     * подтягивали друг к другу руками — по признаку успеха, затем по
     * объёму, — и оба раза двумя написаниями: следующая правка одного из
     * них разошлась бы с другим молча, сверить их нечем, кроме этого
     * стража.
     */
    const sources = await productSources();
    const own: string[] = [];

    for (const source of sources) {
      const raw = /(audioSeconds|tokensIn)\}\s*is\s*not\s*null|ok\}\s*=\s*true/u.test(source.text);
      const viaDrizzle =
        /isNotNull\(\s*aiCalls\.(audioSeconds|tokensIn)\s*\)|eq\(\s*aiCalls\.ok\s*,\s*true\s*\)/u.test(
          source.text,
        );

      if (raw || viaDrizzle) own.push(source.path);
    }

    expect(
      own,
      [
        'Условие «за отправку платили» написано мимо общего:',
        '',
        ...own,
        '',
        'Зовите paidSql() из modules/metering/unpriced.ts.',
        'Себестоимость и «вызовы без цены» обязаны считать оплаченность одинаково:',
        'иначе один сорвавшийся вызов делает модель «без цены» в одном отчёте и нет в другом.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('условие требует успеха, а не только отсутствия цены', () => {
    /**
     * Проверка самого условия, без базы: сорвавшийся вызов цены не имеет
     * и иметь не может, поэтому в это число он не попадает. Читается по
     * готовому SQL — так же, как проверяются подписи в биллинге.
     */
    const text = rendered(unpricedSql());

    expect(text).toContain('is null');
    // Упоминание успеха обязательно: без него условие вернулось бы к
    // прежнему поведению, а страж выше остался бы зелёным.
    expect(text.replaceAll(/\s+/gu, ' ')).toMatch(/is null and/u);
  });

  it('счётчик считает по тому же условию, а не по своему', () => {
    // Два способа посчитать одно число — это два места, где живёт одна
    // правда. Счётчик обязан быть собран из условия, а не повторять его.
    const inner = rendered(unpricedSql());
    const counter = rendered(unpricedCountSql());

    expect(counter).toContain(inner);
    expect(counter).toContain('filter (where');
  });

  it('«без цены» собрано из условия оплаченности, а не повторяет его', () => {
    /**
     * Иначе правка оплаченности (скажем, новый вид объёма) дошла бы до
     * себестоимости и не дошла бы до «вызовов без цены» — или наоборот.
     *
     * Сверяется готовый SQL, пробел в пробел: повтор условия со своим
     * переносом строк (так оно и было написано до выноса) краснеет.
     * Предел честный — повтор буква в букву страж не отличит, но такой
     * повтор делают нарочно, а не по забывчивости, от которой он стоит.
     */
    const paid = rendered(paidSql());
    const unpriced = rendered(unpricedSql());

    expect(unpriced).toContain(paid);
    // Оплаченность — это успех ИЛИ объём: без объёма оплаченный отказ
    // распознавания снова выпал бы из себестоимости.
    expect(paid.replaceAll(/\s+/gu, ' ')).toMatch(/"ok" or .*is not null/u);
  });

  it('скрипт себестоимости берёт строки общей выборкой, а не своим запросом', async () => {
    /**
     * Выборка вынесена в `loadDumpCalls`, чтобы её проверял тест
     * (`cost-per-dump.int.test.ts`). Но проверенная функция, которую
     * скрипт не зовёт, — это «написано, покрыто тестами и недостижимо»:
     * стражи выше не заметят, если скрипт снова заведёт свой запрос без
     * условия вовсе.
     */
    const script = code(await readFile('src/scripts/cost-report.ts', 'utf8'));

    expect(script).toContain('loadDumpCalls(');
    expect(script).not.toContain('from(aiCalls)');
  });
});
