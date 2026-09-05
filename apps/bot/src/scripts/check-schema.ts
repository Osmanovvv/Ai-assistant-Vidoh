import { getTableColumns, getTableName, is, Table } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import * as schema from '../db/schema.js';
import { closeDb, getDb } from '../infra/db.js';

/**
 * Сверка схемы в коде с тем, что на самом деле в базе (задача 3.63).
 *
 * **Зачем понадобилась.** 05.09.2026 миграция 0027 была применена к базе
 * разработки **в недописанном виде**: первую колонку добавил, вторую
 * дописал в файл минутой позже. Журнал `drizzle/meta/_journal.json` уже
 * пометил миграцию выполненной, и `migrate()` больше её не запускает —
 * значит вторая колонка в той базе не появится **никогда**.
 *
 * Дальше это стоило трёх прогонов сквозного и неверной догадки. Сквозной
 * валил одну проверку, тесты при этом были зелёными — они работают на
 * своей базе `vydoh_test`, которую пересоздают каждый раз. Я успел
 * заподозрить модель и смену даты, прежде чем увидел настоящую причину:
 * `column "preferred_name" does not exist`.
 *
 * **Правило простое: расхождение схемы обязано быть громким.** Миграции
 * говорят «применено» по журналу, а не по факту — и этому «применено»
 * нельзя верить. Здесь сверяется факт.
 *
 * Запуск:
 *   DATABASE_URL=… npx tsx src/scripts/check-schema.ts
 *
 * Ставится в `ops/deploy.sh` сразу после миграций: выкладка обязана
 * падать, а не идти дальше с базой, где не хватает колонки.
 */

interface Missing {
  readonly table: string;
  readonly columns: readonly string[];
}

/** Все таблицы схемы: имя и список колонок, как их видит ORM. */
function tablesOfSchema(): Map<string, string[]> {
  const tables = new Map<string, string[]>();

  for (const value of Object.values(schema)) {
    if (!is(value, Table)) continue;

    /**
     * Имена колонок читаются через явный тип, а не выводом.
     *
     * `getTableColumns` на таблице неизвестной формы отдаёт `any`, и
     * строгий линтер такое не пропускает — справедливо: опечатка в
     * `.name` здесь превратила бы страж в вечно зелёный.
     */
    const columns: Record<string, { readonly name: string }> = getTableColumns(value);
    tables.set(
      getTableName(value),
      Object.values(columns).map((column) => column.name),
    );
  }

  return tables;
}

const db = getDb();

try {
  const expected = tablesOfSchema();

  const rows = await db.execute<{ table_name: string; column_name: string }>(
    sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
  );

  const actual = new Map<string, Set<string>>();
  for (const row of rows.rows) {
    const columns = actual.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    actual.set(row.table_name, columns);
  }

  const missingTables: string[] = [];
  const missingColumns: Missing[] = [];

  for (const [table, columns] of expected) {
    const present = actual.get(table);

    if (present === undefined) {
      missingTables.push(table);
      continue;
    }

    const gaps = columns.filter((column) => !present.has(column));
    if (gaps.length > 0) missingColumns.push({ table, columns: gaps });
  }

  /**
   * Лишние колонки в базе — не повод падать.
   *
   * Их оставляет отказ от поля в коде: колонка живёт, пока кто-нибудь не
   * напишет миграцию на удаление, и это нормальный порядок. Опасно
   * обратное — когда код ждёт того, чего в базе нет.
   */
  if (missingTables.length === 0 && missingColumns.length === 0) {
    process.stdout.write(`Схема совпадает: таблиц ${String(expected.size)}\n`);
  } else {
    for (const table of missingTables) {
      process.stderr.write(`НЕТ ТАБЛИЦЫ: ${table}\n`);
    }
    for (const gap of missingColumns) {
      process.stderr.write(`НЕТ КОЛОНОК в ${gap.table}: ${gap.columns.join(', ')}\n`);
    }
    process.stderr.write(
      '\nБаза отстала от кода. Миграции считают себя применёнными по журналу,\n' +
        'а не по факту — проверьте, не правился ли файл миграции после её\n' +
        'применения (задача 3.63).\n',
    );
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
