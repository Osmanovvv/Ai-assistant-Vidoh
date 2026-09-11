import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type DrizzleSnapshotJSON, generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';

import * as schema from './schema.js';

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

/**
 * Снимок схемы в `drizzle/meta` не отстаёт от кода.
 *
 * **Зачем понадобился.** Снимки писались генератором до `0019`, дальше
 * миграции пошли руками, и снимков к ним не появлялось. `drizzle-kit
 * generate` не смотрит в журнал: он берёт **последний по имени** файл
 * из `meta/` и считает разницу от него до `schema.ts`. От `0019` разница —
 * восемьдесят выражений: заново создать девять таблиц и пять типов,
 * которые в базе давно есть. Один раз такой файл уже был сгенерирован
 * и удалён руками (план, задача 3.61); в бою он уронил бы базу.
 * А `npm run db:generate` при этом оставался в README как рабочая команда.
 *
 * Здесь та же разница считается тем же кодом, каким её считает генератор,
 * и обязана быть пустой: тогда следующая генерация опишет только то, что
 * изменилось в схеме. Снимок берётся так же, как берёт его генератор —
 * последний по имени, — а не по номеру из журнала: иначе страж проверял
 * бы не тот файл, который генератор возьмёт на самом деле.
 *
 * Снимков `0020`–`0042` нет и не будет: генератору нужен только последний,
 * а дописать двадцать три промежуточных состояния руками — значит
 * выдумать их. Ручная миграция без смены схемы делается через
 * `db:generate -- --custom --name=…`: генератор сам скопирует снимок под
 * новым номером, и цепочка не порвётся.
 */
describe('снимок схемы не отстаёт от кода', () => {
  it('следующая генерация от последнего снимка даёт пустую миграцию', async () => {
    const metaDir = resolve(drizzleDir, 'meta');
    const snapshots = readdirSync(metaDir)
      .filter((name) => !name.startsWith('_'))
      .sort();
    const last = snapshots.at(-1);

    expect(last, 'в drizzle/meta нет ни одного снимка').toBeDefined();

    const previous = JSON.parse(
      readFileSync(resolve(metaDir, last!), 'utf8'),
    ) as DrizzleSnapshotJSON;
    const current = generateDrizzleJson(schema);

    const statements = await generateMigration(previous, current);

    expect(
      statements,
      `снимок ${last!} отстал от schema.ts: db:generate выдал бы ${String(statements.length)} выражений, первое — ${statements[0] ?? ''}`,
    ).toEqual([]);
  });
});
