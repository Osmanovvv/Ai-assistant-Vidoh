import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Платный прогон называет свою цену — и до того, как выйти из процесса.
 *
 * Ревизия этапов 1–2, молчаливый отказ. У обвязки 3.82 две половины:
 * потолок расхода **до** прогона и счёт **после** него. Первая работала
 * везде, вторая — не всегда:
 *
 * - в объединённом прогоне строки счёта стояли **ниже** `process.exit`,
 *   то есть не исполнялись ни разу. Ни типы, ни линтер этого не видят:
 *   для них `process.exit` — обычный вызов;
 * - в проверке сроков счёт не звался вовсе, и замер через полную модель
 *   выглядел бесплатным.
 *
 * Стережём **инвариант, а не приём**: завёл страж расхода — назови цену.
 * Прежняя мысль «после выхода не должно быть кода» проверяла не то:
 * удали мёртвые строки — и она зеленеет, а цена молчит навсегда.
 */

const here = dirname(fileURLToPath(import.meta.url));
const scripts = resolve(here, '../../scripts');

/** Исходник без комментариев: приёмы тут принято описывать словами. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/u, '$1'))
    .join('\n');
}

async function paidScripts(): Promise<readonly { name: string; text: string }[]> {
  const found: { name: string; text: string }[] = [];

  for (const name of await readdir(scripts)) {
    if (!name.endsWith('.ts')) continue;

    const text = code(await readFile(join(scripts, name), 'utf8'));
    if (text.includes('createRunGuard(')) found.push({ name, text });
  }

  return found;
}

describe('платный прогон называет свою цену', () => {
  it('у каждого стража расхода есть счёт', async () => {
    const silent = (await paidScripts())
      .filter((one) => !one.text.includes('costReport('))
      .map((one) => one.name);

    expect(
      silent,
      'скрипт завёл страж расхода и не назвал цену: тратит деньги заказчицы молча',
    ).toEqual([]);
  });

  it('счёт стоит до выхода из процесса, а не после', async () => {
    /**
     * Позиция считается по тексту, и этого достаточно: в скриптах код
     * плоский, а `process.exit` на нулевом отступе — безусловный выход.
     * Всё, что ниже него, не исполняется никогда.
     */
    const dead: string[] = [];

    for (const one of await paidScripts()) {
      const lines = one.text.split('\n');
      const exit = lines.findIndex((line) => /^process\.exit\s*\(/u.test(line));
      if (exit === -1) continue;

      const below = lines.slice(exit + 1).join('\n');
      if (below.includes('costReport(')) dead.push(one.name);
    }

    expect(dead, 'счёт стоит ниже безусловного выхода — он не напечатается никогда').toEqual([]);
  });

  it('скриптов со стражем расхода не меньше восьми', async () => {
    /**
     * Число — не украшение. Пропади вызов `createRunGuard` из скрипта —
     * обе проверки выше замолчат вместе с ним: списка-то не станет.
     * Здесь этот случай и краснеет.
     */
    expect((await paidScripts()).length).toBeGreaterThanOrEqual(8);
  });
});
