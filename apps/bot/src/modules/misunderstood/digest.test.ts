import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { misunderstoodDigest, startMisunderstoodDigest, type DigestRow } from './digest.js';

/**
 * Суточная сводка непонятого в чат мониторинга (22.09.2026).
 *
 * Журнал непонятого завели 16.09 по просьбе заказчицы и смотрели его
 * руками — то есть не смотрели: о «Напиши мне все, что накопилось»
 * (21.09) я узнал скриншотом от Никиты на следующий день. Сводка раз в
 * сутки превращает журнал в то, чем он должен быть: разбор случившегося
 * в тот же день, а не по жалобе.
 */
const at = (hour: number): Date => new Date(Date.UTC(2026, 8, 21, hour, 0, 0));

const row = (said: string, extra: Partial<DigestRow> = {}): DigestRow => ({
  at: at(9),
  who: 'Ольга',
  said,
  replied: 'Я здесь. Расскажешь, что в голове?',
  reason: 'answer.nothingToParse',
  kind: 'meaning',
  ...extra,
});

describe('суточная сводка непонятого', () => {
  it('пусто — сводки нет: тишина значит «всё поняли»', () => {
    expect(misunderstoodDigest([])).toBeUndefined();
  });

  it('называет число, причины и сами слова человека', () => {
    const digest = misunderstoodDigest([
      row('Напиши мне все, что накопилось'),
      row('что там у меня', { reason: 'backlog.nothing', at: at(11) }),
    ]);

    expect(digest?.key).toBe('misunderstood_daily');
    expect(digest?.title).toContain('2 раза');
    const details = JSON.stringify(digest?.details ?? {});
    expect(details).toContain('Напиши мне все, что накопилось');
    expect(details).toContain('что там у меня');
    expect(details).toContain('answer.nothingToParse');
  });

  it('сбои системы считаются отдельно от непонятых слов', () => {
    const digest = misunderstoodDigest([
      row('что там с котом', { kind: 'system', reason: 'backlog.unavailable' }),
      row('напиши всё'),
    ]);

    expect(digest?.title).toContain('сбоев: 1');
  });

  it('длинные реплики обрезаются, людей не больше, чем строк', () => {
    const digest = misunderstoodDigest(
      Array.from({ length: 12 }, (_, index) => row(`фраза ${String(index)} ${'о'.repeat(200)}`)),
    );

    const details = JSON.stringify(digest?.details ?? {});
    expect(digest?.title).toContain('12 раз');
    // Не больше восьми строк в сводке: остальное — в панели.
    expect((details.match(/фраза /gu) ?? []).length).toBeLessThanOrEqual(8);
    expect(details.length).toBeLessThan(2_000);
  });
});

describe('сторож сводки', () => {
  it('шлёт раз в сутки и не шлёт, когда непонятого не было', async () => {
    const sent: string[] = [];
    let rows: DigestRow[] = [];
    const watch = startMisunderstoodDigest({
      list: () => Promise.resolve(rows),
      alert: (alert) => {
        sent.push(alert.title);
        return Promise.resolve(true);
      },
      everyMs: 5,
    });

    await watch.check();
    expect(sent).toEqual([]);

    rows = [row('напиши всё')];
    await watch.check();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('не понял 1 раз');

    watch.stop();
  });

  it('отказ доставки не роняет бота', async () => {
    const watch = startMisunderstoodDigest({
      list: () => Promise.resolve([row('напиши всё')]),
      alert: () => Promise.reject(new Error('телеграм молчит')),
      everyMs: 5,
    });

    await expect(watch.check()).resolves.toBeUndefined();
    watch.stop();
  });
});

describe('связка: сводка и вправду запускается', () => {
  /**
   * Страж по исходнику: сводка написана и покрыта — но её ещё должны
   * позвать. Разрыв «написано, покрыто тестами и недостижимо» в этом
   * проекте уже случался (шаг проекта, который нельзя было закрыть).
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, '../../index.ts'), 'utf8');

  it('подъём бота ставит сторож сводки и даёт ему список и оповещение', () => {
    const call = /startMisunderstoodDigest\([^;]*;/u.exec(source)?.[0] ?? '';

    expect(call, 'сводка непонятого не запускается при подъёме').not.toBe('');
    expect(call, 'сводке нечем читать журнал').toMatch(/list:/u);
    expect(call, 'сводке некуда слать').toMatch(/alert:/u);
  });
});
