import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { getEnv } from '../config/env.js';

/**
 * Применение миграций (задача 1.5).
 *
 * Запускается отдельной командой, а не при старте приложения: при нескольких
 * репликах одновременный запуск миграций из каждой — источник блокировок.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../drizzle');

const logger = createLogger({
  level: getEnv().LOG_LEVEL,
  pretty: getEnv().NODE_ENV !== 'production',
});

try {
  logger.info({ migrationsFolder }, 'Применяю миграции');
  await migrate(getDb(), { migrationsFolder });
  logger.info('Миграции применены');
} catch (error) {
  logger.error({ err: error }, 'Миграции не применились');
  process.exitCode = 1;
} finally {
  await closeDb();
}
