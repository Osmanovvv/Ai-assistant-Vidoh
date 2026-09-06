import { createHmac } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

/**
 * Общая дорога к панели для всех проверок (§15 ТЗ, задача 4.12).
 *
 * **Одним местом нарочно.** Помощников входа было два, и когда панель
 * стала открываться на «Обзоре», один перестал работать, а второй нет:
 * пять проверок покраснели от чужой правки. Одна дорога — одно место,
 * где её править.
 */

/** Секрет стенда — тот же, что в `admin-e2e-server.ts`. */
const SECRET = Buffer.from('12345678901234567890', 'ascii');

export const LOGIN = 'аня';
export const PASSWORD = 'очень-длинный-пароль-42';

/** Разделы панели, которые уже есть. */
export type Tab = 'Обзор' | 'Пользователи' | 'Расходы' | 'Промпты' | 'Настройки';

/**
 * Код на текущую секунду.
 *
 * Считается здесь, а не берётся из кода панели: проверка не должна
 * зависеть от того, что проверяет. Если алгоритм в панели однажды
 * разойдётся со стандартом, эта проверка покраснеет — а взяв его
 * реализацию оттуда же, она осталась бы зелёной.
 */
export function currentCode(): string {
  const step = Math.floor(Date.now() / 1000 / 30);

  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step % 2 ** 32, 4);

  const digest = createHmac('sha1', SECRET).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const slice =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(slice % 1_000_000).padStart(6, '0');
}

/** Вход целиком и переход в нужный раздел. */
export async function signIn(page: Page, tab?: Tab): Promise<void> {
  await page.goto('/admin/');
  await page.locator('input[name="login"]').fill(LOGIN);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Дальше' }).click();
  await page.locator('input[name="code"]').fill(currentCode());
  await page.getByRole('button', { name: 'Войти' }).click();

  // Панель открывается на «Обзоре»: дождаться его — значит дождаться
  // входа, а не гадать по таймауту.
  await expect(page.getByTestId('overview')).toBeVisible();

  if (tab !== undefined && tab !== 'Обзор') {
    await page.getByRole('button', { name: tab }).click();
  }
}
