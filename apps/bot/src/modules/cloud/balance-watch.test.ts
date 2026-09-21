import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { startBalanceWatch } from './balance-watch.js';

/**
 * Запуск сторожа баланса при старте бота (проджект, 21.09.2026).
 *
 * Без файла ключа — сторожа нет, и бот от этого не страдает; кривой
 * файл — отказ словами в журнал, бот поднимается; с ключом — сторож
 * проверяет баланс сразу и потом по расписанию.
 */

function loggerSpy() {
  const lines: { level: string; msg: string; extra: unknown }[] = [];
  const at =
    (level: string) =>
    (extra: unknown, msg?: string): void => {
      lines.push({ level, msg: msg ?? String(extra), extra });
    };

  return {
    lines,
    logger: { info: at('info'), warn: at('warn'), error: at('error') } as never,
  };
}

describe('запуск сторожа баланса', () => {
  it('без файла ключа — сторожа нет, в журнале сказано, что это нормально', async () => {
    const { logger, lines } = loggerSpy();

    const started = await startBalanceWatch({
      keyFile: undefined,
      thresholdRub: () => Promise.resolve(300),
      alert: () => Promise.resolve(true),
      logger,
    });

    expect(started).toBeUndefined();
    expect(lines.some((line) => line.level === 'info' && line.msg.includes('не задан'))).toBe(true);
  });

  it('файл не читается — бот не падает, отказ в журнале без содержимого файла', async () => {
    const { logger, lines } = loggerSpy();
    const dir = await mkdtemp(join(tmpdir(), 'vydoh-key-'));
    const file = join(dir, 'key.json');
    await writeFile(file, '{"private_key": "СЕКРЕТ-НЕ-ПОКАЗЫВАТЬ"}');

    const started = await startBalanceWatch({
      keyFile: file,
      thresholdRub: () => Promise.resolve(300),
      alert: () => Promise.resolve(true),
      logger,
    });

    expect(started).toBeUndefined();
    const failure = lines.find((line) => line.level === 'error');
    expect(failure?.msg).toMatch(/баланс/iu);
    expect(JSON.stringify(failure)).not.toContain('СЕКРЕТ-НЕ-ПОКАЗЫВАТЬ');
  });

  it('с ключом — проверка сразу и по расписанию; остановка снимает расписание', async () => {
    vi.useFakeTimers();
    try {
      const { logger } = loggerSpy();
      const checks: number[] = [];
      const started = await startBalanceWatch({
        keyFile: 'не читается: сторож подменён',
        thresholdRub: () => Promise.resolve(300),
        alert: () => Promise.resolve(true),
        logger,
        // Подмена самого сторожа: здесь проверяется расписание, не сеть.
        watch: {
          status: () => Promise.reject(new Error('не зовётся')),
          check: () => {
            checks.push(Date.now());
            return Promise.resolve();
          },
        },
        everyMs: 60_000,
      });

      expect(started).toBeDefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(checks).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(checks).toHaveLength(2);

      started?.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(checks).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
