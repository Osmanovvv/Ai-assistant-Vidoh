import { afterEach, describe, expect, it, vi } from 'vitest';

import { PENDING_FIX_ENV } from './pending-fixes.js';

/**
 * Флаги замера по умолчанию выключены (находки 10.09.2026).
 *
 * **Это про боевой бот, а не про удобство.** Обе правки под флагами
 * меняют то, что бот примет за срок и за правило повторения. Включись
 * любая из них молча — и боевое поведение поедет от переменной
 * окружения, которую никто не ставил осознанно, а замера, ради которого
 * флаг заведён, так и не будет.
 *
 * Проверяется и то, как читается значение: пустая строка в окружении
 * встречается сама собой (`VAR=` в скрипте, пустое значение из compose),
 * и прочитать её как «включено» значило бы включить правку случайно.
 */

async function fixes(env: Record<string, string>): Promise<typeof import('./pending-fixes.js')> {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

  return await import('./pending-fixes.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('правки, ждущие замера', () => {
  it('без переменных окружения выключены все', async () => {
    const { PENDING_FIXES, pendingFixesLine } = await fixes({
      [PENDING_FIX_ENV.weekdayRoot]: '',
      [PENDING_FIX_ENV.strictRecurrenceAnchor]: '',
    });

    expect(Object.values(PENDING_FIXES).some(Boolean), 'правка включена без спроса').toBe(false);
    expect(pendingFixesLine()).toContain('как в бою');
  });

  it('пустое значение — это выключено, а не включено', async () => {
    const { PENDING_FIXES } = await fixes({ [PENDING_FIX_ENV.weekdayRoot]: '' });

    expect(PENDING_FIXES.weekdayRoot).toBe(false);
  });

  it('«0», «false» и «да» тоже не включают', async () => {
    for (const value of ['0', 'false', 'да', 'yes', 'on']) {
      const { PENDING_FIXES } = await fixes({ [PENDING_FIX_ENV.weekdayRoot]: value });

      expect(PENDING_FIXES.weekdayRoot, `«${value}» включило правку`).toBe(false);
    }
  });

  it('включает ровно «1», и каждый флаг сам по себе', async () => {
    const { PENDING_FIXES, pendingFixesLine } = await fixes({
      [PENDING_FIX_ENV.weekdayRoot]: '1',
      [PENDING_FIX_ENV.strictRecurrenceAnchor]: '',
    });

    expect(PENDING_FIXES.weekdayRoot).toBe(true);
    expect(PENDING_FIXES.strictRecurrenceAnchor).toBe(false);
    expect(pendingFixesLine()).toBe('weekdayRoot');
  });
});
