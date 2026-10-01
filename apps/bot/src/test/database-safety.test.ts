import { describe, expect, it } from 'vitest';

import { assertSafeTestDatabaseUrl, type TestDatabaseName } from './database-safety.js';

describe('защита тестовых баз', () => {
  it.each([
    'postgres://vydoh:vydoh@localhost:5434/vydoh_test',
    'postgres://vydoh:vydoh@localhost:5432/vydoh_test',
    'postgresql://vydoh:vydoh@127.0.0.1:5434/vydoh_test',
    'postgres://vydoh:vydoh@[::1]:5434/vydoh_test',
  ])('разрешает локальный стенд и адрес CI: %s', (url) => {
    expect(() => {
      assertSafeTestDatabaseUrl(url, 'vydoh_test');
    }).not.toThrow();
  });

  it.each<TestDatabaseName>(['vydoh_test', 'vydoh_admin_e2e', 'vydoh_e2e'])(
    'разрешает базу соответствующего сценария: %s',
    (databaseName) => {
      expect(() => {
        assertSafeTestDatabaseUrl(
          `postgres://vydoh:vydoh@localhost:5434/${databaseName}`,
          databaseName,
        );
      }).not.toThrow();
    },
  );

  it.each([
    'postgres://vydoh:vydoh@localhost:5434/vydoh',
    'postgres://vydoh:vydoh@localhost:5434/postgres',
    'postgres://vydoh:vydoh@localhost:5434/vydoh_admin_e2e',
    'postgres://vydoh:vydoh@localhost:5434/vydoh_eval',
    'postgres://vydoh:vydoh@localhost:5434/vydoh_p_c',
    'postgres://vydoh:vydoh@localhost:5434/vydoh_test_copy',
    'postgres://vydoh:vydoh@localhost:5434/vydoh%5Ftest',
    'postgres://vydoh:vydoh@localhost:5434/vydoh_test/extra',
    'postgres://vydoh:vydoh@db.example.com:5434/vydoh_test',
    'postgres://vydoh:vydoh@192.0.2.1:5434/vydoh_test',
    'postgres://vydoh:vydoh@localhost.example.com:5434/vydoh_test',
    'postgres://vydoh:vydoh@localhost:6543/vydoh_test',
    'postgres://vydoh:vydoh@localhost/vydoh_test',
    'https://localhost:5434/vydoh_test',
    'host=localhost port=5434 dbname=vydoh_test',
    '',
  ])('отвергает рабочую, чужую или неоднозначную базу: %s', (url) => {
    expect(() => {
      assertSafeTestDatabaseUrl(url, 'vydoh_test');
    }).toThrow('Небезопасный адрес тестовой базы');
  });

  it.each([
    '?host=db.example.com',
    '?database=vydoh',
    '?port=6543',
    '?%68ost=db.example.com',
    '?options=-csearch_path=other',
    '#other',
  ])('не допускает переопределение подключения: %s', (tail) => {
    expect(() => {
      assertSafeTestDatabaseUrl(`postgres://localhost:5434/vydoh_test${tail}`, 'vydoh_test');
    }).toThrow('Небезопасный адрес тестовой базы');
  });

  it('не позволяет стенду админки очищать базу интеграционных тестов', () => {
    expect(() => {
      assertSafeTestDatabaseUrl('postgres://localhost:5434/vydoh_test', 'vydoh_admin_e2e');
    }).toThrow('Небезопасный адрес тестовой базы');
  });

  it.each([
    'postgres://private-user:private-password@db.example.com:5434/vydoh_test',
    'postgres://private-user:private-password@[broken',
  ])('не выводит логин и пароль в ошибке', (url) => {
    expect(() => {
      assertSafeTestDatabaseUrl(url, 'vydoh_test');
    }).toThrow('Подключение не выполнялось');
    try {
      assertSafeTestDatabaseUrl(url, 'vydoh_test');
    } catch (error) {
      expect(String(error)).not.toContain('private-user');
      expect(String(error)).not.toContain('private-password');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
