import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runHealthChecks } from './server.js';

/**
 * У стартовой проверки зависимостей есть срок (ревизия этапов 1–2).
 *
 * Молчаливый отказ: прежде подъём звал `Promise.all([pingDb, pingRedis])`
 * без срока. Клиент ioredis настроен копить команды до возвращения связи,
 * поэтому `ping` при мёртвом Redis не возвращается **никогда**. Процесс
 * висел молча, не подняв даже `/health`, а `restart: unless-stopped`
 * перезапускает по выходу, а не по нездоровью — то есть не перезапускал.
 * Выкладка, не дождавшись здоровья, печатала хвост журнала, где про этот
 * запуск не было ни строки о причине.
 *
 * Проверяется поведение — что срок и вправду срабатывает, — и связка:
 * что подъём этим сроком пользуется и не уходит в бесконечное ожидание.
 */

describe('зависшая зависимость не держит подъём вечно', () => {
  it('срок срабатывает и называет, кто именно не ответил', async () => {
    const report = await runHealthChecks(
      [
        { name: 'postgres', check: () => Promise.resolve() },
        // Ровно то, чем оборачивается мёртвый Redis: обещание, которое
        // не исполнится никогда.
        { name: 'redis', check: () => new Promise<void>(() => undefined) },
      ],
      50,
    );

    expect(report.ok).toBe(false);
    expect(report.checks['postgres']).toBe('ok');
    expect(report.checks['redis'], 'зависшая зависимость не названа').toContain('не ответил');
  });

  it('живые зависимости проходят молча', async () => {
    // Громкость, звучащая всегда, перестаёт значить что-либо.
    const report = await runHealthChecks(
      [
        { name: 'postgres', check: () => Promise.resolve() },
        { name: 'redis', check: () => Promise.resolve() },
      ],
      50,
    );

    expect(report).toEqual({ ok: true, checks: { postgres: 'ok', redis: 'ok' } });
  });
});

describe('связка: подъём ждёт зависимости со сроком и говорит о неудаче', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, '../index.ts'), 'utf8');

  it('подъём не ждёт зависимости голым Promise.all', () => {
    /**
     * Ровно та строка, которой отказ и был. Ищется без комментариев:
     * разбор ловушки принято писать рядом словами, и цитата не должна
     * красить стража.
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '');

    expect(
      /Promise\.all\(\[\s*pingDb/u.test(code),
      'подъём снова ждёт зависимости без срока — при мёртвом Redis он повиснет молча',
    ).toBe(false);
  });

  it('подъём зовёт проверку со сроком и выходит при неудаче', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '');

    expect(code).toContain('runHealthChecks(healthChecks, STARTUP_HEALTH_TIMEOUT_MS)');

    // Отчёт уходит полем: по нему в журнале отбирается, что именно упало.
    expect(code).toContain('logger.fatal({ checks: health.checks }');

    // И процесс кончается — повисший контейнер не поднимет никто.
    const after = code.slice(code.indexOf('if (!health.ok)'));
    expect(after.slice(0, 400)).toContain('process.exit(1)');
  });

  it('готовность стережёт тот же список, что проверен при подъёме', () => {
    // Разойдись они — и готовность отвечала бы «готов» о том, чего при
    // старте не спрашивали. Одно и то же не считается двумя способами.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '');

    expect(code).toContain('healthChecks,');
    expect(
      (code.match(/name: 'redis', check:/gu) ?? []).length,
      'список зависимостей снова написан дважды',
    ).toBe(1);
  });
});
