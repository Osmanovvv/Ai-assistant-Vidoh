import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupTestDatabase } from './db.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('защита перед подключением и очисткой тестовой базы', () => {
  it.each([
    'postgres://localhost:5434/vydoh',
    'postgres://db.example.com:5434/vydoh_test',
    'postgres://localhost:5434/vydoh_test?host=db.example.com',
  ])('останавливает интеграционные тесты до обращения к Postgres: %s', async (url) => {
    vi.stubEnv('TEST_DATABASE_URL', url);
    // Даже при удалении защиты тест не сможет выйти в сеть.
    const connect = vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(() => {
      throw new Error('Тест не должен подключаться к Postgres');
    });

    await expect(setupTestDatabase()).rejects.toThrow('Небезопасный адрес тестовой базы');
    expect(connect).not.toHaveBeenCalled();
  });

  it('останавливает стенд админки, если ему дали базу интеграционных тестов', async () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgres://localhost:5434/vydoh_test');
    const connect = vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(() => {
      throw new Error('Тест не должен подключаться к Postgres');
    });

    await expect(setupTestDatabase('vydoh_admin_e2e')).rejects.toThrow(
      'Небезопасный адрес тестовой базы',
    );
    expect(connect).not.toHaveBeenCalled();
  });
});
