import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Повтор живёт **внутри** учёта, а не снаружи (§10.5 ТЗ).
 *
 * §10.5 дословно (`docs/00-tz-source.md:320`): «Таблица обращений к
 * моделям заполняется на каждом вызове, **включая неуспешные**: … задержка,
 * признак успеха, текст ошибки».
 *
 * **Зачем страж по исходнику.** Поведенческая проверка на это есть —
 * `ai/client.int.test.ts`, «сорвавшаяся отправка внутри повтора тоже
 * попадает в учёт». Но она проверяет один путь из трёх, а неверный
 * порядок обёрток был одинаков во всех трёх: модель, распознавание речи
 * и вектора писались независимо и повторили одну и ту же ошибку. Четвёртый
 * платный путь повторит её снова, и ни одна поведенческая проверка не
 * покраснеет — они все написаны про свой путь.
 *
 * Проверка грубая, текстовая, и это осознанно: поднять три платных пути
 * целиком значит поднять базу, Redis и трёх провайдеров.
 */

const here = dirname(fileURLToPath(import.meta.url));
const modulesRoot = resolve(here, '..');

/** Определение обёртки и сам учёт — им звать `meterCall` положено. */
const ALLOWED_TO_CALL_METER = ['metered-send.ts', 'ai-calls.repo.ts'];

/** Продуктовые файлы модулей: без проверок и без вспомогательных подделок. */
function productFiles(): readonly string[] {
  const found: string[] = [];

  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder)) {
      const full = join(folder, entry);

      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }

      if (!entry.endsWith('.ts')) continue;
      if (entry.includes('.test.')) continue;
      if (entry.startsWith('fake-') || entry.startsWith('mock')) continue;

      found.push(full);
    }
  };

  walk(modulesRoot);

  return found;
}

/**
 * Исходник без комментариев.
 *
 * Иначе страж не отличает цитату от кода: в `metered-send.ts` прежний
 * неверный порядок обёрток описан словами — на то и разбор, — и без этой
 * чистки проверка краснела бы от собственного объяснения.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/[^\n]*/gu, '');
}

/** Текст вызова целиком — от имени до парной закрывающей скобки. */
function callsOf(source: string, name: string): readonly string[] {
  const found: string[] = [];
  let from = 0;

  for (;;) {
    const start = source.indexOf(name + '(', from);
    if (start === -1) return found;

    let depth = 0;
    let end = start + name.length;

    for (; end < source.length; end++) {
      const char = source[end];
      if (char === '(') depth++;
      if (char === ')') {
        depth--;
        if (depth === 0) break;
      }
    }

    found.push(source.slice(start, end + 1));
    from = end + 1;
  }
}

describe('порядок обёрток вокруг платной отправки', () => {
  it('платные пути не зовут meterCall напрямую', () => {
    const guilty = productFiles().filter(
      (file) =>
        !ALLOWED_TO_CALL_METER.includes(file.split(/[\\/]/u).at(-1) ?? '') &&
        code(file).includes('meterCall('),
    );

    // Прямой `meterCall` вокруг повтора — ровно тот дефект, что чинили:
    // до трёх отправок в одной строке учёта и ни одной неуспешной.
    expect(guilty).toEqual([]);
  });

  it('внутри учёта на отправку нет своего повтора', () => {
    const guilty = productFiles().filter((file) => {
      const source = code(file);
      return source.includes('meterEachSend(') && source.includes('withRetry(');
    });

    // Повтор снаружи учёта прячет сорвавшиеся отправки; повтор внутри
    // отправки прячет их так же — только на уровень ниже.
    expect(guilty).toEqual([]);
  });

  it('каждый платный путь передаёт свои настройки повтора', () => {
    const without: string[] = [];

    for (const file of productFiles()) {
      for (const call of callsOf(code(file), 'meterEachSend')) {
        if (!call.includes('retry:')) without.push(file);
      }
    }

    // Без `retry: deps.retry` обёртка молча берёт умолчание, и проверки
    // теряют власть над паузами: прогон удлиняется на настоящие секунды.
    expect(without).toEqual([]);
  });

  it('платных путей ровно три и они на месте', () => {
    const paid = productFiles()
      .filter((file) => code(file).includes('meterEachSend('))
      .map((file) => file.split(/[\\/]/u).at(-1))
      .sort();

    // Список не про запрет нового пути, а про то, чтобы его появление
    // было замечено: у платной отправки есть свои правила, и они здесь.
    expect(paid).toEqual(['client.ts', 'embedder.service.ts', 'speech.service.ts']);
  });
});
