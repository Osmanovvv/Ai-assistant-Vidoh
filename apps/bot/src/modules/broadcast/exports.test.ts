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

/**
 * Какие модули стережём.
 *
 * Рассылка — с ревизии четвёртого этапа (там нашлась `failedOf`), деньги
 * — оттуда же: у них нашлись пять экспортов без вызывающих, и каждый
 * хранил устаревшее знание. `errorCodeOfPage` разбирала страницу,
 * которую открывает браузер человека; `successSignature` повторяла
 * формулу уведомления; `tariffsOf` была вторым способом ответить на
 * «что мы продаём»; `invoiceByInvId` искала счёт способом, которым его
 * никто не ищет.
 *
 * Список растёт по мере надобности — как и всякий список в этом проекте,
 * он живёт рядом с проверкой, а не в чьей-то голове.
 */
const MODULES = [
  'src/modules/broadcast/broadcast.repo.ts',
  'src/modules/broadcast/broadcast.service.ts',
  'src/modules/billing/billing.repo.ts',
  'src/modules/billing/tariffs.ts',
  'src/modules/billing/promo.service.ts',
  'src/modules/billing/checkout.service.ts',
  'src/modules/billing/renewal.service.ts',
  'src/modules/billing/providers/robokassa.ts',
  'src/modules/billing/providers/robokassa-signature.ts',
];

/**
 * Экспорты, у которых вызывающего нет **нарочно** — с причиной.
 *
 * Пустой список означал бы, что исключений не бывает; они бывают, но
 * каждое обязано быть названо здесь, а не обнаружено через год.
 */
const ALLOWED = new Map<string, string>([
  // Сегодня исключений нет: правило спрашивает «зовёт ли кто-нибудь»,
  // и внутренние помощники ему отвечают сами. Список остаётся: у
  // следующего исключения будет причина, названная здесь.
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

/**
 * Сколько раз имя стоит в своём же объявлении.
 *
 * Обычно один раз. Считать, а не предполагать: предположение здесь
 * сделало бы проверку либо слепой, либо крикливой.
 */
function declarationsOf(text: string, name: string): number {
  const patterns = [
    new RegExp(`export async function ${name}\\b`, 'gu'),
    new RegExp(`export function ${name}\\b`, 'gu'),
    new RegExp(`export const ${name}\\b`, 'gu'),
  ];

  return patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
}

describe('у экспортов рассылки и денег есть вызывающие', () => {
  it('каждый экспорт кто-нибудь зовёт либо он назван исключением', async () => {
    const all = await sources();
    const orphans: string[] = [];

    for (const modulePath of MODULES) {
      const own = all.find((one) => one.path === modulePath);

      expect(own, `не нашёлся файл ${modulePath}`).toBeDefined();
      if (own === undefined) continue;

      for (const name of exportsOf(own.text)) {
        if (ALLOWED.has(name)) continue;

        /**
         * Вызывающий может быть и **в своём модуле** — так правильно.
         *
         * Первая версия требовала вызывающего снаружи, и от неё краснели
         * помощники, которыми модуль пользуется сам (`startRenewals`
         * зовёт `runRenewals`, `chargeRecurring` — `errorTextOf`).
         * Вопрос не в том, кто зовёт, а в том, зовёт ли **кто-нибудь**:
         * `failedOf` не звал никто, и она хранила устаревшее знание про
         * доставку.
         *
         * Считаются все упоминания имени в продуктовом коде; если их
         * ровно столько, сколько в самом объявлении, — значит только
         * объявление и есть.
         */
        const mentions = all.reduce((sum, one) => {
          const found = one.text.match(new RegExp(`\\b${name}\\b`, 'gu'));

          return sum + (found?.length ?? 0);
        }, 0);

        if (mentions <= declarationsOf(own.text, name)) orphans.push(`${name} (${modulePath})`);
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
