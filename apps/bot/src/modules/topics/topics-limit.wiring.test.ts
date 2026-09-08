import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Предел числа тем доезжает до **каждого** создателя тем (§6.4).
 *
 * **Зачем страж по исходнику.** Предел — необязательный параметр:
 * `createTopics` и `createChosenTopics` без него работают по умолчанию из
 * кода. Это правильно для стенда, где реестра настроек нет, и это же
 * прячет забытую строку в бою: заказчица ставит в панели три, человек
 * получает девять ветвей, и ни одна проверка не краснеет — все они
 * написаны так, чтобы работать без реестра.
 *
 * Ровно так дефект и жил до ревизии панели: путей создания тем два —
 * опрос и базовый набор на первой выгрузке, — а настройку читало только
 * согласие добавить сферу.
 *
 * Проверка грубая, текстовая, и это осознанно: поднять оба пути целиком
 * значит поднять базу, Redis, Telegram и модель. Зато ловит именно ту
 * ошибку, которая бывает — вызов без предела.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

/** Продуктовые файлы: без проверок и без вспомогательных подделок. */
function productFiles(): readonly string[] {
  const found: string[] = [];

  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder)) {
      const full = join(folder, entry);

      if (statSync(full).isDirectory()) {
        if (entry !== 'test') walk(full);
        continue;
      }

      if (!entry.endsWith('.ts')) continue;
      if (entry.includes('.test.')) continue;
      if (entry.startsWith('fake-')) continue;

      found.push(full);
    }
  };

  walk(root);

  return found;
}

/**
 * Текст вызова целиком — от имени до закрывающей скобки.
 *
 * Считать скобки, а не искать первую закрывающую: у обоих вызовов внутри
 * лежат вложенные вызовы (`await deps.settings?.number('maxTopics')`), и
 * поиск по первой скобке обрезал бы аргумент ровно там, где он и стоит.
 */
function callsOf(source: string, name: string): readonly string[] {
  const calls: string[] = [];
  let at = source.indexOf(`${name}(`);

  while (at !== -1) {
    let depth = 0;
    let index = at + name.length;

    for (; index < source.length; index += 1) {
      const symbol = source[index];

      if (symbol === '(') depth += 1;
      if (symbol === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    calls.push(source.slice(at, index + 1));
    at = source.indexOf(`${name}(`, index + 1);
  }

  return calls;
}

/** Вызовы создателей тем в продуктовом коде: где и с чем. */
function creations(): readonly { readonly file: string; readonly call: string }[] {
  const found: { file: string; call: string }[] = [];

  for (const file of productFiles()) {
    const source = readFileSync(file, 'utf8');

    for (const name of ['createChosenTopics', 'createTopics', 'appendTopics']) {
      // Объявление функции — не вызов: искать надо тех, кто её зовёт.
      if (source.includes(`export async function ${name}(`)) continue;

      for (const call of callsOf(source, name)) {
        found.push({ file: file.slice(root.length + 1).replaceAll('\\', '/'), call });
      }
    }
  }

  return found;
}

describe('предел числа тем доезжает до всех создателей (§6.4)', () => {
  it('каждый вызов создателя тем передаёт предел из настроек', () => {
    const forgetful = creations().filter((one) => !one.call.includes('maxTopics'));

    expect(
      forgetful.map((one) => one.file),
      'вызов создаёт темы без предела из настроек: заказчица поставит в панели своё число, ' +
        'а человек получит другое — и ни одна проверка не покраснеет, они все работают без реестра',
    ).toEqual([]);
  });

  it('страж правда что-то нашёл', () => {
    /**
     * Пустой список сделал бы проверку выше вечно зелёной — и это не
     * догадка про будущее: сюда легко приехать переименованием функции
     * или сменой раскладки папок.
     *
     * Путей создания тем два (опрос и базовый набор первой выгрузки),
     * плюс добавление сферы согласием — значит меньше трёх вызовов
     * означает, что искали не там.
     */
    const calls = creations();

    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.map((one) => one.file)).toContain('modules/pipeline/dump.handler.ts');
    expect(calls.map((one) => one.file)).toContain('bot/handlers/onboarding.ts');
  });

  it('и правда читает файлы, а не пустоту', () => {
    // Обход, съехавший с папки, дал бы пустой список файлов и зелень
    // обеим проверкам выше.
    expect(productFiles().length).toBeGreaterThan(100);
  });
});
