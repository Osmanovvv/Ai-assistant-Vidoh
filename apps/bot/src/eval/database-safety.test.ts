import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assertSafeEvalDatabaseUrl } from './database-safety.js';

describe('отдельная база прогонов качества', () => {
  it.each([
    'postgres://vydoh:vydoh@localhost:5434/vydoh_eval',
    'postgres://vydoh:vydoh@localhost:5432/vydoh_eval',
    'postgresql://vydoh:vydoh@127.0.0.1:5434/vydoh_eval',
    'postgres://vydoh:vydoh@[::1]:5434/vydoh_eval',
  ])('разрешает локальную базу из рантбука: %s', (url) => {
    expect(() => {
      assertSafeEvalDatabaseUrl(url);
    }).not.toThrow();
  });

  it.each([
    undefined,
    '',
    'postgres://localhost:5434/vydoh',
    'postgres://localhost:5434/postgres',
    'postgres://localhost:5434/vydoh_test',
    'postgres://localhost:5434/vydoh_admin_e2e',
    'postgres://localhost:5434/vydoh_e2e',
    'postgres://localhost:5434/vydoh_eval_copy',
    'postgres://localhost:5434/vydoh%5Feval',
    'postgres://localhost:5434/vydoh_eval/extra',
    'postgres://db.example.com:5434/vydoh_eval',
    'postgres://192.0.2.1:5434/vydoh_eval',
    'postgres://localhost.example.com:5434/vydoh_eval',
    'postgres://localhost:6543/vydoh_eval',
    'postgres://localhost/vydoh_eval',
    'https://localhost:5434/vydoh_eval',
    'host=localhost port=5434 dbname=vydoh_eval',
    ' postgres://localhost:5434/vydoh_eval',
    'postgres://localhost:5434/vydoh_eval?host=db.example.com',
    'postgres://localhost:5434/vydoh_eval?%68ost=db.example.com',
    'postgres://localhost:5434/vydoh_eval?database=vydoh',
    'postgres://localhost:5434/vydoh_eval?port=6543',
    'postgres://localhost:5434/vydoh_eval#other',
  ])('отвергает рабочую, тестовую и неоднозначную базу: %s', (url) => {
    expect(() => {
      assertSafeEvalDatabaseUrl(url);
    }).toThrow('Небезопасный адрес базы прогона качества');
  });

  it.each([
    'postgres://private-user:private-password@db.example.com:5434/vydoh_eval',
    'postgres://private-user:private-password@[broken',
  ])('отказ не раскрывает реквизиты подключения', (url) => {
    try {
      assertSafeEvalDatabaseUrl(url);
      expect.fail('небезопасный адрес принят');
    } catch (error) {
      expect(String(error)).toContain('Подключение не выполнялось');
      expect(String(error)).not.toContain('private-user');
      expect(String(error)).not.toContain('private-password');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('CLI отказывает до чтения набора и подключения', () => {
  const botRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

  it.each(['run-eval', 'run-resolver-eval', 'run-eval-merged'])(
    '%s не использует унаследованный рабочий адрес',
    (script) => {
      const secretKeys = new Set([
        'YANDEX_API_KEY',
        'YANDEX_SA_KEY_FILE',
        'OPENAI_API_KEY',
        'BOT_TOKEN',
        'RK_PASS1',
        'RK_PASS2',
        'RK_PASSWORD1',
        'RK_PASSWORD2',
      ]);
      const childEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !secretKeys.has(key)),
      );
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve(botRoot, 'src/scripts', `${script}.ts`),
          resolve(botRoot, 'intentionally-absent-eval-dataset'),
        ],
        {
          cwd: botRoot,
          env: {
            ...childEnv,
            AI_PROVIDER: 'mock',
            SPEECH_PROVIDER: 'mock',
            DATABASE_URL: 'postgres://private-user:private-password@127.0.0.1:1/vydoh',
          },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      const output = child.stdout + child.stderr;
      expect(output).toContain('Небезопасный адрес базы прогона качества');
      expect(output).not.toContain('ENOENT');
      expect(output).not.toContain('ECONNREFUSED');
      expect(output).not.toContain('private-user');
      expect(output).not.toContain('private-password');
    },
  );
});
