import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Страж решения от 25.08.2026: текстов промптов в репозитории нет.
 *
 * Репозиторий публичный, а промпты — основное ноу-хау продукта: не код
 * решает, насколько хорошо бот разбирает кашу в голове, а именно они.
 * Источник истины — таблица `prompt_versions`, тексты живут в `docs/`.
 *
 * Без этой проверки решение ничем не защищено. Через месяц кто-нибудь
 * положит текст рядом с кодом «на время», и он уедет в открытый доступ
 * первым же коммитом.
 *
 * **Чего этот страж не ловит.** Промпт, положенный строкой прямо в код.
 * Такую проверку я пробовал сделать поиском длинных строковых литералов
 * и отказался: регулярное выражение не отличает длинную строку от
 * промежутка между двумя короткими, и проверка давала два десятка ложных
 * срабатываний на собственных сообщениях об ошибках. Страж, который врёт,
 * однажды просто отключат — и тогда не останется и того, что работает.
 *
 * От строки в коде защищает не тест, а устройство: промпты попадают в
 * базу через `seedPrompt`, который вызывается из служебного скрипта с
 * путём к файлу. Класть текст в код незачем и неудобно.
 */

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Расширения, в которых обычно и лежат тексты промптов. */
const SUSPICIOUS = ['.md', '.txt', '.prompt'];

async function findSuspiciousFiles(dir: string): Promise<string[]> {
  const found: string[] = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await findSuspiciousFiles(full)));
      continue;
    }

    if (SUSPICIOUS.some((extension) => entry.name.endsWith(extension))) {
      found.push(relative(srcRoot, full));
    }
  }

  return found;
}

describe('промпты не лежат в репозитории', () => {
  it('в исходниках нет текстовых файлов, похожих на промпты', async () => {
    const found = await findSuspiciousFiles(srcRoot);

    expect(
      found,
      `Найдены текстовые файлы в исходниках: ${found.join(', ')}. ` +
        'Тексты промптов должны лежать в docs/, вне публичного репозитория.',
    ).toEqual([]);
  });

  it('в папке промптов только код', async () => {
    const promptsDir = join(srcRoot, 'modules/ai/prompts');
    const entries = await readdir(promptsDir);

    expect(entries.every((name) => name.endsWith('.ts'))).toBe(true);
  });
});
