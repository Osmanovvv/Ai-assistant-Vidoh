import { glob, readFile } from 'node:fs/promises';
import { sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Ни одного платного пути мимо учёта (задача 3.82).
 *
 * **Корневая причина 05.09.2026 — расхождение отчёта со счётом.** Отчёт
 * по всем базам показывал ≈856 ₽, а счёт был потрачен на ≈5 900 ₽. Часть
 * этой разницы — скрипты, которые обращаются к провайдеру **напрямую**,
 * минуя `meterCall`: их расход не видит ни учёт, ни страж расхода, ни
 * отчёт. Ни в одну базу они не пишут вообще ничего.
 *
 * Каждый из них попал в дерево по одному, со своим объяснением «база
 * здесь не нужна», и ни один тест не возразил. Пятый попал бы так же.
 *
 * **Поэтому проверка на исходники, а не на поведение.** Прямой вызов
 * провайдера разрешён только там, где он и должен быть: внутри самих
 * провайдеров, в клиенте модели, в службе векторов и в службе речи —
 * то есть там, где рядом стоит `meterCall`. Всё остальное обязано идти
 * через учёт.
 *
 * Список исключений закрытый и короткий нарочно: он и есть ответ на
 * вопрос «где у нас тратятся деньги».
 */

/** Где прямой вызов провайдера законен: рядом с ним стоит учёт. */
const ALLOWED = [
  // Сами провайдеры: им и положено звать сеть.
  'modules/ai/providers/',
  'modules/embedder/providers/',
  'modules/speech/providers/',
  // Запись ответов оборачивает живого провайдера (3.80).
  'modules/ai/cassette/',
  // Три места, где вызов обёрнут учётом.
  'modules/ai/client.ts',
  'modules/embedder/embedder.service.ts',
  'modules/speech/speech.service.ts',
];

/** Вызовы, которые тратят деньги провайдера. */
const PAID_CALLS = /\.(complete|transcribe|embed)\s*\(/u;

/** Кому эти вызовы принадлежат: только провайдеру, не любому объекту. */
const PAID_OWNER = /\b(provider|llm|speech|embedder)\b/iu;

/**
 * Разбор одного файла. Вынесен отдельно, чтобы вторым тестом проверить
 * саму проверку на выдуманном содержимом.
 */
function paidCallsWithoutMetering(source: string): string[] {
  if (source.includes('meterCall(')) return [];

  return source
    .split(/\r?\n/u)
    .filter((line) => PAID_CALLS.test(line) && PAID_OWNER.test(line))
    .map((line) => line.trim());
}

/** Вызовы платного эмбеддера из чужих модулей. */
const EMBED_CALLS = /\bembedText\s*\(/u;

/** Кто зовёт `embedText` законно без стража: сама служба векторов. */
const EMBED_ALLOWED = ['modules/embedder/'];

/**
 * Разбор одного файла на вызов эмбеддера без стража расхода.
 *
 * Вынесен отдельно, чтобы проверить проверку на выдуманном содержимом.
 */
function embedCallsWithoutGuard(source: string): boolean {
  return EMBED_CALLS.test(source) && !source.includes('spendGuard');
}

async function sourceFiles(): Promise<string[]> {
  const found: string[] = [];

  for await (const entry of glob('src/**/*.ts')) {
    const path = entry.split(sep).join('/');

    // Тесты и стенды сюда не считаются: они ходят к заглушкам.
    if (path.includes('.test.') || path.includes('/test/') || path.includes('/eval/synthetic'))
      continue;

    found.push(path);
  }

  return found.sort();
}

describe('платные пути идут через учёт', () => {
  it('файл с прямым вызовом провайдера обязан звать meterCall', async () => {
    /**
     * **Проверка по файлу, а не по строке, и это важно.** Первая версия
     * искала строку `provider.complete(` — и осталась красной даже после
     * починки: вызов-то никуда не девается, он просто оказывается
     * **внутри** `meterCall`. Проверка, которая не умеет отличить
     * починенное от сломанного, годится только на то, чтобы её
     * отключили.
     *
     * Признак простой и честный: в файле есть платный вызов — значит в
     * файле должен быть и учёт. Наличие `meterCall` означает, что автор
     * про деньги подумал; его отсутствие — что нет.
     */
    const offenders: string[] = [];

    for (const path of await sourceFiles()) {
      const relative = path.replace(/^src\//u, '');
      if (ALLOWED.some((one) => relative.startsWith(one))) continue;

      const paid = paidCallsWithoutMetering(await readFile(path, 'utf8'));
      if (paid.length === 0) continue;

      offenders.push(`${relative}: ${String(paid.length)} платн. вызовов без meterCall`);
    }

    expect(
      offenders,
      [
        'Платный вызов провайдера без учёта.',
        'Расход такого вызова не видит ни страж расхода, ни отчёт по базам —',
        'именно это расхождение отчёта со счётом стоило гранта 05.09.2026.',
        'Заверни вызов в meterCall (см. modules/ai/client.ts) или добавь путь',
        'в ALLOWED, если учёт рядом действительно есть.',
        '',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });

  it('проверка способна упасть: подсаженный файл ловится', () => {
    /**
     * Страж, который не может покраснеть, хуже отсутствующего. Здесь тот
     * же разбор проверяется на выдуманном содержимом — и на нём видно,
     * где границы: платный вызов ловится, обёрнутый учётом пропускается,
     * похожее имя (`promise.complete`) за платный вызов не считается.
     */
    expect(paidCallsWithoutMetering('const a = await provider.complete({ prompt });')).toHaveLength(
      1,
    );
    expect(paidCallsWithoutMetering('await speech.transcribe({ filePath });')).toHaveLength(1);
    expect(
      paidCallsWithoutMetering('const a = await meterCall(db, ctx, () => provider.complete({}));'),
    ).toEqual([]);
    expect(paidCallsWithoutMetering('const done = await promise.complete();')).toEqual([]);
  });

  it('файл, зовущий embedText, обязан протаскивать страж расхода', async () => {
    /**
     * **Дефект ровно этой формы уже был** (задача 3.82): поле
     * `spendGuard` в зависимостях существовало, а протаскивания не было —
     * вопрос по бэклогу и правка в резолвере считали векторы мимо
     * потолка. Потолок при этом переставал быть потолком: он
     * останавливал модель, а расход шёл до настоящего отказа
     * провайдера. Так 05.09.2026 и узнали, что деньги кончились.
     *
     * Векторы дёшевы поштучно, и именно поэтому дыра прожила незаметно:
     * ни в одном отчёте она не выглядела ошибкой.
     */
    const offenders: string[] = [];

    for (const path of await sourceFiles()) {
      const relative = path.replace(/^src\//u, '');
      if (EMBED_ALLOWED.some((one) => relative.startsWith(one))) continue;

      if (embedCallsWithoutGuard(await readFile(path, 'utf8'))) offenders.push(relative);
    }

    expect(
      offenders,
      [
        'Платный вызов эмбеддера мимо стража расхода.',
        'Потолок остановит модель, а векторы будут тратиться дальше —',
        'до настоящего отказа провайдера, как 05.09.2026.',
        'Протащи spendGuard в зависимости embedText.',
        '',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });

  it('и эта проверка способна упасть', () => {
    expect(embedCallsWithoutGuard('await embedText(deps, params);')).toBe(true);
    expect(embedCallsWithoutGuard('await embedText({ ...deps, spendGuard }, params);')).toBe(false);
    expect(embedCallsWithoutGuard('const text = await readFile(path);')).toBe(false);
  });
});
