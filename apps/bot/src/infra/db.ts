import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import pg from 'pg';

import { getEnv } from '../config/env.js';
import * as schema from '../db/schema.js';

/**
 * Подключение к Postgres (задача 1.5).
 *
 * Пул создаётся лениво: модуль можно импортировать в тестах, которые
 * до базы не доходят, и это не откроет соединений.
 */

export type Database = NodePgDatabase<typeof schema>;

export type Transaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * То, на чём можно выполнить запрос: пул или транзакция. Репозитории
 * принимают именно это, поэтому один и тот же код работает и сам по себе,
 * и внутри транзакции — без дублирования методов.
 */
export type Executor = Database | Transaction;

let pool: pg.Pool | undefined;
let database: Database | undefined;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Долгий запрос к базе не должен держать обработку выгрузки бесконечно.
    statement_timeout: 30_000,
  });
}

export function getPool(): pg.Pool {
  pool ??= createPool(getEnv().DATABASE_URL);
  return pool;
}

export function getDb(): Database {
  database ??= drizzle(getPool(), { schema });
  return database;
}

/** Проверка живости для /health/ready. */
export async function pingDb(db: Database = getDb()): Promise<void> {
  await db.execute(sql`select 1`);
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    database = undefined;
  }
}
