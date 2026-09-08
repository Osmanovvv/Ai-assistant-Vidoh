import { glob, readFile } from 'node:fs/promises';
import { sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Страж связки: у экспорта модуля рассылки есть вызывающий (ревизия 4).
 *
 * **Написанное и никем не вызванное — не задел на будущее.** Это третье
 * место, где живёт правда про доставку, и оно устаревает молча: `failedOf`
 * обещала комментарием «для журнала ошибок», не имела ни одного
 * вызывающего и не знала про состояние `sending`, появившееся позже.
 * Такую же находку ревизия сделала на третьем этапе («написано, покрыто
 * тестами и недостижимо»), и тогда же был сделан вывод: связку надо
 * стеречь, а не проверять глазами.
 *
 * Инструмента для мёртвых экспортов в проекте нет (ни `knip`, ни
 * `ts-prune`), и вводить его ради одного модуля дороже, чем эта проверка.
 */

const MODULES = [
  'src/modules/broadcast/broadcast.repo.ts',
  'src/modules/broadcast/broadcast.service.ts',
];

/**
 * Экспорты, у которых вызывающего нет **нарочно** — с причиной.
 *
 * Пустой список означал бы, что исключений не бывает; они бывают, но
 * каждое обязано быть названо здесь, а не обнаружено через год.
 */
const ALLOWED = new Map<string, string>([
  ['LEASE_MS', 'предел взятия строки: читается своим же модулем и проверками'],
  ['DEFAULT_PER_SECOND', 'умолчание темпа: настройка его перекрывает, но без неё оно нужно'],
  [
    'TELEGRAM_MESSAGE_LIMIT',
    'предел Bot API: проверяется в своём же модуле, а наружу отдан затем, чтобы панель однажды показала его человеку, а не повторила числом',
  ],
  ['REAL_CLOCK', 'настоящие часы: подставляются проверками, в бою берутся умолчанием'],
  ['CHUNK', 'размер порции: читается своим же модулем и проверками'],
]);

async function sources(): Promise<readonly { path: string; text: string }[]> {
  const found: { path: string; text: string }[] = [];

  for await (const entry of glob('src/**/*.ts')) {
    const path = entry.split(sep).join('/');

    if (path.includes('.test.')) continue;

    found.push({ path, text: await readFile(path, 'utf8') });
  }

  return found;
}

/** Имена значений (не типов), которые модуль отдаёт наружу. */
function exportsOf(text: string): readonly string[] {
  const names: string[] = [];
  const patterns = [
    /export async function ([A-Za-z0-9_]+)/gu,
    /export function ([A-Za-z0-9_]+)/gu,
    /export const ([A-Za-z0-9_]+)/gu,
  ];

  for (const pattern of patterns) {
    for (const found of text.matchAll(pattern)) {
      const name = found[1];
      if (name !== undefined) names.push(name);
    }
  }

  return names;
}

describe('у экспортов рассылки есть вызывающие', () => {
  it('каждый экспорт зовут снаружи своего модуля либо он назван исключением', async () => {
    const all = await sources();
    const orphans: string[] = [];

    for (const modulePath of MODULES) {
      const own = all.find((one) => one.path === modulePath);

      expect(own, `не нашёлся файл ${modulePath}`).toBeDefined();
      if (own === undefined) continue;

      for (const name of exportsOf(own.text)) {
        if (ALLOWED.has(name)) continue;

        const callers = all.filter(
          (one) => one.path !== modulePath && new RegExp(`\\b${name}\\b`, 'u').test(one.text),
        );

        if (callers.length === 0) orphans.push(`${name} (${modulePath})`);
      }
    }

    expect(
      orphans,
      [
        `Экспорты без вызывающих: ${orphans.join(', ')}.`,
        'Написанное и никем не вызванное — третье место, где живёт правда,',
        'и оно устаревает молча. Либо дать вызывающего, либо убрать,',
        'либо назвать исключением с причиной в ALLOWED.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('проверка смотрит на настоящее дерево', async () => {
    // Страж стража: сломайся сборка путей, и проверка выше зеленела бы
    // на пустом списке экспортов.
    const all = await sources();
    const own = all.find((one) => one.path === MODULES[0]);

    expect(all.length).toBeGreaterThan(50);
    expect(exportsOf(own?.text ?? '').length).toBeGreaterThan(5);
  });
});
