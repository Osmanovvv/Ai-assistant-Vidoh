import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Связка в `index.ts` (бой 25.09.2026): «баланс ниже порога» приходил
 * после каждой выкладки. Память дребезга и стирание написаны и покрыты
 * тестами — но без подключения при старте бот вёл бы себя по-старому.
 * `index.ts` поднимает бота целиком, позвать его проверка не может, —
 * связка проверяется по исходнику.
 */
const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts'),
  'utf8',
);

/** Текст вызова от открывающей скобки до парной закрывающей. */
function callBlock(start: string): string {
  const from = source.indexOf(start);
  expect(from, `нет «${start}» в index.ts`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = from + start.length - 1; index < source.length; index++) {
    const char = source[index];
    if (char === '(' || char === '{') depth++;
    if (char === ')' || char === '}') depth--;
    if (depth === 0) return source.slice(from, index + 1);
  }
  return source.slice(from);
}

describe('память оповещений подключена при старте', () => {
  it('монитор помнит дребезг в Redis', () => {
    expect(callBlock('new Monitor({')).toMatch(/memory:\s*redisAlertMemory\(getRedis\(\)\)/u);
  });

  it('сторож баланса стирает память через монитор, когда баланс снова выше порога', () => {
    expect(callBlock('startBalanceWatch({')).toMatch(/forget:[\s\S]*monitor\.forget\(key\)/u);
  });
});
