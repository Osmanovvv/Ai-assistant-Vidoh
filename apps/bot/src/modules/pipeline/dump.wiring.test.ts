import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Необязательные зависимости конвейера действительно пробросаны (4.4).
 *
 * **Зачем страж.** У обработчика выгрузки одиннадцать необязательных
 * зависимостей, и каждая необязательна по делу: без отправителя он молча
 * копит, без веток работает в плоском режиме §8.2, без реестра настроек
 * не пишет момент конца пробного периода. Все проверки при этом зелёные —
 * они и написаны так, чтобы работать без них.
 *
 * Цена забытой строки в боевой сборке: функция написана, покрыта
 * тестами и **недостижима**. Этот класс отказа в проекте уже случался
 * (задача 3.82: шаг проекта нельзя было закрыть ничем) и стоил не
 * ошибки, а тишины.
 *
 * Проверка идёт **по исходнику** `src/index.ts`, а не вызовом сборки:
 * поднять весь запуск в тесте — значит поднять базу, Redis, Telegram и
 * модель. Сверка текста грубая, зато ловит именно ту ошибку, которая
 * бывает: имя есть в объявлении зависимостей и не встречается там, где
 * обработчик собирают.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Имена зависимостей, объявленные в `DumpHandlerDeps`. */
function declared(): readonly string[] {
  const source = readFileSync(resolve(here, 'dump.handler.ts'), 'utf8');

  const start = source.indexOf('export interface DumpHandlerDeps {');
  expect(start, 'объявление DumpHandlerDeps не найдено').toBeGreaterThan(-1);

  const end = source.indexOf('\n}', start);
  const block = source.slice(start, end);

  return [...block.matchAll(/^ {2}readonly ([a-zA-Z]+)\??:/gmu)]
    .map((match) => match[1] ?? '')
    .filter((name) => name !== '');
}

/** Что передано обработчику в боевой сборке. */
function wired(): string {
  const source = readFileSync(resolve(here, '../../index.ts'), 'utf8');

  const start = source.indexOf('createDumpHandler({');
  expect(start, 'createDumpHandler в запуске не найден').toBeGreaterThan(-1);

  const end = source.indexOf('\n  });', start);

  return source.slice(start, end);
}

/**
 * Швы для проверок — единственное законное исключение.
 *
 * Первая версия стража исключений не имела вовсе, и это было честнее по
 * замыслу, но неверно по факту: `now` подменяет часы в проверках, и в
 * бою его передавать нечем — там настоящее время. Страж нашёл это сразу
 * же, на себе.
 *
 * Список именно такой короткий и с причиной у каждой строки. Соблазн
 * пополнять его «этим тоже не надо» велик, и именно он прячет забытое:
 * список растёт вместе с забыванием. Не нужна зависимость — её надо
 * убрать из объявления, а не дописать сюда.
 */
const SEAMS: readonly string[] = [
  // Часы. В бою — настоящее время, подменяются только в проверках.
  'now',
];

describe('обработчик выгрузки собран целиком', () => {
  it('каждая зависимость передана в боевой сборке', () => {
    const missing = declared().filter((name) => !SEAMS.includes(name) && !wired().includes(name));

    expect(
      missing,
      `в src/index.ts обработчику не передано: ${missing.join(', ')}. ` +
        'Функция, зависящая от этого, будет написана, покрыта тестами и недостижима.',
    ).toEqual([]);
  });

  it('проверка правда что-то проверяет', () => {
    // Пустое объявление сделало бы тест выше вечно зелёным.
    expect(declared().length).toBeGreaterThan(8);
    expect(declared()).toContain('settings');
  });

  it('список швов остаётся коротким', () => {
    /**
     * Страж с длинным списком исключений — это страж, который ничего не
     * охраняет. Порог назван числом нарочно: расширять список станет
     * можно только вместе с этой строкой, то есть осознанно.
     */
    expect(SEAMS.length).toBeLessThanOrEqual(2);

    // И каждый шов обязан существовать в объявлении: устаревшее
    // исключение молча прощает настоящую забытую зависимость.
    for (const seam of SEAMS) expect(declared()).toContain(seam);
  });
});
