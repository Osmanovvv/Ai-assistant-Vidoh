import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { items } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { withCapital } from './item-text.js';

/**
 * Уборка строчных названий (проверка 26.09.2026, вечер).
 *
 * Заглавную ставит запись (задача 3.25, `storedTitle`), и все пути записи
 * её держат. Но дело, у которого правка срезала час до починки 26.09,
 * осталось строчным — «зайти в аптеку», — и утренний разбор назвал бы его
 * так: «3. зайти в аптеку». Миграция доводит такие записи до того же
 * правила, что и `withCapital`.
 *
 * **Правило — ровно `withCapital`.** Поэтому ожидание здесь не выписано
 * руками, а берётся из самой функции: разойдись SQL с ней — тест красный.
 *
 * **Локаль базы — `C`** (и на бою, и в тестовой). `upper()` там не знает
 * кириллицы, а «ё» не входит в `[а-я]`: миграция, написанная через
 * `upper()`, прошла бы на базе с другой локалью и молча ничего не сделала
 * бы на бою. Случаи с кириллицей и «ё» стоят здесь ради этого.
 */

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/0066_titles_with_capital.sql',
);

async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (const statement of statements) await testDb().execute(sql.raw(statement));
}

const TITLES = [
  'зайти в аптеку',
  'ёлку нарядить',
  'яблоки купить',
  'zoom созвон с командой',
  'купить хлеб для iPhone-чата',
  'iPhone починить',
  'ВБ заказы',
  'Позвонить маме',
  '5 сентября позвонить',
  '«тёплый» свитер купить',
];

const UPDATED_AT = new Date('2026-09-20T10:00:00.000Z');

let userId: string;

beforeEach(async () => {
  const user = await upsertUser(testDb(), { tgId: 901, firstName: 'Аня' });
  userId = user.id;
});

async function insertRaw(text: string, isDraft: boolean): Promise<string> {
  // Мимо `saveItems`: так лежат записи, сохранённые до починки.
  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text,
      isDraft,
      ...(isDraft ? { draftReason: 'test' } : { type: 'TASK', priority: 'SOON', topic: 'дом' }),
      updatedAt: UPDATED_AT,
    })
    .returning({ id: items.id });
  return row!.id;
}

async function textOf(id: string): Promise<{ text: string; updatedAt: Date }> {
  const [row] = await testDb()
    .select({ text: items.text, updatedAt: items.updatedAt })
    .from(items)
    .where(eq(items.id, id));
  return row!;
}

describe('миграция 0066: названия с заглавной', () => {
  it.each(TITLES)('«%s» — как withCapital', async (title) => {
    const id = await insertRaw(title, false);

    await runMigration();

    expect((await textOf(id)).text).toBe(withCapital(title));
  });

  it('кириллица и «ё» правятся и на базе с локалью C', async () => {
    const pharmacy = await insertRaw('зайти в аптеку', false);
    const tree = await insertRaw('ёлку нарядить', false);

    await runMigration();

    expect((await textOf(pharmacy)).text).toBe('Зайти в аптеку');
    expect((await textOf(tree)).text).toBe('Ёлку нарядить');
  });

  it('черновик — слова человека как есть — не трогается', async () => {
    const id = await insertRaw('зайти в аптеку', true);

    await runMigration();

    expect((await textOf(id)).text).toBe('зайти в аптеку');
  });

  it('время изменения не сдвигается: порядок «последнего обсуждённого» прежний', async () => {
    const id = await insertRaw('зайти в аптеку', false);

    await runMigration();

    expect((await textOf(id)).updatedAt.toISOString()).toBe(UPDATED_AT.toISOString());
  });

  it('повторный прогон ничего не меняет', async () => {
    const id = await insertRaw('зайти в аптеку', false);

    await runMigration();
    await runMigration();

    expect((await textOf(id)).text).toBe('Зайти в аптеку');
  });
});
