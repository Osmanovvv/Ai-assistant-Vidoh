import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Стенд резолвера пишет ответы модели на плёнку (план docs/26, задача 1).
 *
 * До 24.09.2026 он гнал модель вживую каждый раз: любая проверка правки
 * кода после замера стоила денег заново. Стенд выгрузок пишет плёнку с
 * 20.09 — этот страж держит второй стенд на том же правиле.
 *
 * Страж читает текст скрипта: у скрипта нет функций, только верхний
 * уровень, и поведенческой проверки без живой модели не собрать. Ловит
 * ровно то, что важно, — провайдер создаётся из окружения записи, и
 * записанное сохраняется.
 */

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '../scripts/run-resolver-eval.ts');

/** Текст без комментариев: слова в пояснениях не должны сойти за вызов. */
async function code(): Promise<string> {
  const text = await readFile(script, 'utf8');
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
}

describe('стенд резолвера: живой прогон пишется на плёнку', () => {
  it('провайдер создаётся из окружения записи, а не из голого env', async () => {
    const source = await code();
    expect(source).toMatch(/recordingEnvFor\(\s*env\s*,/u);
    expect(source).not.toMatch(/createLlmProvider\(\s*env\s*\)/u);
  });

  it('записанное сохраняется', async () => {
    expect(await code()).toContain('flushCassette(');
  });

  it('фильтр --only применяется к случаям', async () => {
    const source = await code();
    expect(source).toContain('parseOnly(');
    expect(source).toContain('pickCases(');
  });

  it('флаг --without-dialog доходит до прогонщика (замер «как сейчас», план docs/26)', async () => {
    const source = await code();
    expect(source).toContain("'--without-dialog'");
    expect(source).toMatch(/runResolverDataset\([\s\S]*withoutDialog/u);
  });
});
