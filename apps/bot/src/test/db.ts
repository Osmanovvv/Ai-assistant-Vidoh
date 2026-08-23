import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import * as schema from '../db/schema.js';
import type { Database } from '../infra/db.js';

/**
 * Тестовая база для интеграционных тестов.
 *
 * Отдельная база, а не отдельная схема: миграции применяются ровно так же,
 * как в бою, поэтому тест ловит и ошибки в самих миграциях. Между тестами
 * таблицы очищаются, а не пересоздаются — это на порядок быстрее.
 */

const DEFAULT_URL = 'postgres://vydoh:vydoh@localhost:5434/vydoh_test';

export function testDatabaseUrl(): string {
  return process.env['TEST_DATABASE_URL'] ?? DEFAULT_URL;
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** Создаёт тестовую базу, если её ещё нет. */
async function ensureDatabaseExists(url: string): Promise<void> {
  const parsed = new URL(url);
  const databaseName = parsed.pathname.replace(/^\//u, '');

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [
      databaseName,
    ]);
    if (existing.rowCount === 0) {
      // Имя базы нельзя передать параметром, поэтому экранируем кавычками.
      await admin.query(`create database "${databaseName.replaceAll('"', '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

let pool: pg.Pool | undefined;
let database: NodePgDatabase<typeof schema> | undefined;

/** Готовит базу к прогону: создаёт её при необходимости и применяет миграции. */
export async function setupTestDatabase(): Promise<Database> {
  if (database) return database;

  const url = testDatabaseUrl();
  await ensureDatabaseExists(url);

  pool = new pg.Pool({ connectionString: url, max: 4 });
  database = drizzle(pool, { schema });

  await migrate(database, { migrationsFolder });

  return database;
}

export function testDb(): Database {
  if (!database) {
    throw new Error('setupTestDatabase() не вызывался');
  }
  return database;
}

/**
 * Очистка между тестами. TRUNCATE с CASCADE и RESTART IDENTITY: быстрее
 * пересоздания и не оставляет висящих внешних ключей.
 */
export async function truncateAll(): Promise<void> {
  const db = testDb();
  await db.execute(
    sql`truncate table ${schema.messagesRaw}, ${schema.telegramUpdates}, ${schema.userSettings}, ${schema.users} restart identity cascade`,
  );
}

export async function closeTestDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    database = undefined;
  }
}
