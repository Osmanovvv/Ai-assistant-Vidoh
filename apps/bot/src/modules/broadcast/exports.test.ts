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
  /**
   * Люди — с ревизии панели: там нашлись `activeUserIds` и
   * `recordConsent`, оба без вызывающих и оба вторым способом сказать
   * то, что уже сказано живым кодом. `activeUserIds` обещала
   * комментарием «планировщик берёт адресатов только отсюда» —
   * неправду: адресатов рассылки набирает `recipientsOf`, а планировщик
   * свой запрос. Модуль в списке не стоял, и стеречь эту связку было
   * нечем.
   */
  'src/modules/users/users.repo.ts',
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
 * Текст без комментариев: упоминание в комментарии — не вызов.
 *
 * **Страж спал на своём же случае** (ревизия панели). Он считал все
 * совпадения имени во всех продуктовых файлах, а стиль этого модуля —
 * оставлять на месте убранной функции памятную запись с её именем
 * («`failedOf` убрана ревизией четвёртого этапа» — она и сейчас в
 * `broadcast.repo.ts`). Значит вернись `export function failedOf` без
 * единого вызывающего — упоминаний стало бы два (объявление и
 * комментарий) против одного объявления, условие сироты не выполнилось
 * бы, и проверка осталась бы зелёной ровно на том случае, ради которого
 * написана. Проверено диверсией: см. проверку на поддельном дереве ниже.
 *
 * `[^:]` перед `//` — чтобы не съесть `https://…` в строке: съеденный
 * хвост строки унёс бы с собой настоящий вызов и страж закричал бы на
 * живой код.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gmu, '$1');
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

/**
 * Экспорты названных модулей, которых никто не зовёт.
 *
 * Вынесено отдельной функцией нарочно: страж, который нельзя прогнать на
 * поддельном дереве, не проверить диверсией — а именно так он и
 * пропустил свой собственный случай. Проверка ниже гоняет эту функцию на
 * дереве, где имя экспорта стоит в комментарии, и требует, чтобы сирота
 * нашлась.
 *
 * Отсутствие файла здесь не разбирается: его отдельно спрашивает
 * вызывающий — так у него получается сказать, какого именно файла нет.
 */
function orphansIn(
  all: readonly { readonly path: string; readonly text: string }[],
  modules: readonly string[],
): readonly string[] {
  // Комментарии режутся один раз на всё дерево, а не на каждое имя:
  // модулей и имён десятки, файлов — сотни.
  const code = all.map((one) => ({ path: one.path, text: withoutComments(one.text) }));
  const orphans: string[] = [];

  for (const modulePath of modules) {
    const own = code.find((one) => one.path === modulePath);

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
       * Считаются все упоминания имени в продуктовом коде **без
       * комментариев**; если их ровно столько, сколько в самом
       * объявлении, — значит только объявление и есть.
       */
      const mentions = code.reduce((sum, one) => {
        const found = one.text.match(new RegExp(`\\b${name}\\b`, 'gu'));

        return sum + (found?.length ?? 0);
      }, 0);

      if (mentions <= declarationsOf(own.text, name)) orphans.push(`${name} (${modulePath})`);
    }
  }

  return orphans;
}

describe('у экспортов рассылки и денег есть вызывающие', () => {
  it('каждый экспорт кто-нибудь зовёт либо он назван исключением', async () => {
    const all = await sources();

    for (const modulePath of MODULES) {
      expect(
        all.some((one) => one.path === modulePath),
        `не нашёлся файл ${modulePath}`,
      ).toBe(true);
    }

    const orphans = orphansIn(all, MODULES);

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

  it('упоминание в комментарии за вызов не считается', () => {
    /**
     * **Диверсия, которую страж прежде не замечал.**
     *
     * Дерево поддельное, но случай настоящий: убранная функция оставила
     * после себя памятную запись с именем (так написано в
     * `broadcast.repo.ts` про `failedOf` и в `users.repo.ts` про
     * `activeUserIds`), а вернувшийся экспорт вызывающего не получил.
     * Прежний подсчёт видел два упоминания против одного объявления и
     * молчал — ровно на том случае, ради которого страж и написан.
     */
    const withMemorial = [
      {
        path: 'src/modules/пример/repo.ts',
        text: [
          '/* `failedOf` убрана ревизией четвёртого этапа. */',
          'export async function failedOf(): Promise<void> {}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/modules/пример/service.ts',
        text: '// Про failedOf здесь сказано словом, а не вызовом.\n',
      },
    ];

    expect(orphansIn(withMemorial, ['src/modules/пример/repo.ts'])).toEqual([
      'failedOf (src/modules/пример/repo.ts)',
    ]);

    /**
     * И на живом коде страж молчит: вызывающий за комментарий не
     * считается, но и вызов из-за резки комментариев не теряется.
     * Крикливый страж хуже отсутствующего — его отключают.
     */
    const withCaller = [
      {
        path: 'src/modules/пример/repo.ts',
        text: [
          '/* `failedOf` живёт: её зовёт служба. */',
          'export async function failedOf(): Promise<void> {}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/modules/пример/service.ts',
        text: [
          "import { failedOf } from './repo.js';",
          '// Ссылка в комментарии: https://example.test/failedOf',
          'export async function run(): Promise<void> {',
          '  await failedOf();',
          '}',
          '',
        ].join('\n'),
      },
    ];

    expect(orphansIn(withCaller, ['src/modules/пример/repo.ts'])).toEqual([]);
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
