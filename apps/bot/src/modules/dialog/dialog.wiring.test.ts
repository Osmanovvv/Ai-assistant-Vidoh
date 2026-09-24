import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Хвост разговора подключён в боевой сборке везде, где нужен (план docs/26).
 *
 * Хранилище необязательно у всех, кто его принимает, — так работают
 * проверки. Цена забытой строки в `index.ts`: функция написана, покрыта
 * тестами и недостижима (задача 3.82). Здесь три места, где забыть
 * опаснее всего: перехват реплик бота, стирание по `/delete_my_data` и
 * стирание после 24 месяцев тишины. Конвейер сторожит `dump.wiring.test.ts`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../../index.ts'), 'utf8');

/** Текст вызова от имени до закрывающей скобки на своём уровне отступа. */
function callOf(name: string, closing: string): string {
  const start = source.indexOf(name);
  expect(start, `${name} в запуске не найден`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf(closing, start));
}

describe('хвост разговора в боевой сборке', () => {
  it('одно хранилище на процесс', () => {
    expect(source).toMatch(/const dialog = redisDialogStore\(getRedis\(\)\);/u);
  });

  it('бот получает его — реплики бота попадают в хвост', () => {
    expect(callOf('createBot(env.BOT_TOKEN', ');')).toMatch(/\bdialog\b/u);
  });

  it('/delete_my_data стирает хвост', () => {
    expect(callOf('registerPrivacyHandlers(bot, {', '\n  });')).toMatch(/^\s+dialog,$/mu);
  });

  it('удаление после 24 месяцев тишины стирает хвост', () => {
    expect(callOf('startInactivityLoop({', '\n      })')).toMatch(/^\s+dialog,$/mu);
  });

  it('модели хвост показывается только по DIALOG_CONTEXT=on', () => {
    expect(source).toContain("useDialog: env.DIALOG_CONTEXT === 'on'");
  });
});
