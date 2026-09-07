import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Файл миграции и запись о нём в журнале — вместе или никак (задача 4.2).
 *
 * **Зачем понадобился.** Миграция `0033` была написана руками и положена
 * в папку, а запись в `drizzle/meta/_journal.json` я не добавил.
 * `migrate()` идёт **по журналу**, а не по папке: он отчитался «миграции
 * применены», ничего не применив. Колонок в базе не появилось, а
 * сообщение об успехе было настоящим.
 *
 * Сквозной страж на это есть — `check-schema.ts` сверяет схему с базой, —
 * но он стоит в выкладке и требует живой базы. Здесь то же расхождение
 * ловится обычным прогоном за миллисекунды, до коммита.
 *
 * **Проверка двусторонняя нарочно.** Забытая запись оставляет миграцию
 * неприменённой; лишняя запись без файла роняет `migrate()` при старте —
 * то есть весь сервис. Оба конца одинаково дороги.
 */

const drizzleDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[];
}

function journal(): Journal {
  return JSON.parse(readFileSync(resolve(drizzleDir, 'meta/_journal.json'), 'utf8')) as Journal;
}

function sqlFiles(): string[] {
  return readdirSync(drizzleDir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.replace(/\.sql$/u, ''))
    .sort();
}

describe('миграции и журнал не расходятся', () => {
  it('у каждого файла есть запись в журнале', () => {
    /**
     * Забытая запись — это «применено» без применения: `migrate()`
     * отчитается успехом, а колонок в базе не будет никогда, потому что
     * второй раз он к этой миграции не вернётся.
     */
    const tags = new Set(journal().entries.map((entry) => entry.tag));
    const orphans = sqlFiles().filter((file) => !tags.has(file));

    expect(orphans, `миграции без записи в журнале: ${orphans.join(', ')}`).toEqual([]);
  });

  it('у каждой записи есть файл', () => {
    // Лишняя запись роняет `migrate()` при старте — то есть весь сервис.
    const files = new Set(sqlFiles());
    const missing = journal()
      .entries.map((entry) => entry.tag)
      .filter((tag) => !files.has(tag));

    expect(missing, `записи без файла миграции: ${missing.join(', ')}`).toEqual([]);
  });

  it('номера идут по порядку и без дыр', () => {
    /**
     * `idx` — порядок применения, и он же порядок в папке. Дыра или
     * перестановка означают, что две миграции спорят за одно место, и
     * какая из них применится на чистой базе — вопрос сортировки.
     */
    const entries = [...journal().entries].sort((first, second) => first.idx - second.idx);

    expect(entries.map((entry) => entry.idx)).toEqual(entries.map((_entry, index) => index));

    expect(entries.map((entry) => entry.tag)).toEqual(sqlFiles());
  });
});
