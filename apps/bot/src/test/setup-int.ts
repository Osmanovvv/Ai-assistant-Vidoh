import { afterAll, beforeAll, beforeEach } from 'vitest';

import { closeTestDatabase, setupTestDatabase, truncateAll } from './db.js';

/**
 * Общая подготовка интеграционных тестов: одна база на весь прогон,
 * чистые таблицы перед каждым тестом.
 */

beforeAll(async () => {
  await setupTestDatabase();
}, 60_000);

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDatabase();
});
