import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MODEL_VERSIONS, ModelVersionWatch, watchVersions } from './versions.js';
import type { CompletionResult, LlmProvider } from './types.js';

/**
 * Сторож сборки модели (22.09.2026, закрепление модели по имени).
 *
 * Порог качества и цены мерились на конкретных сборках. Когда провайдер
 * подменит сборку за тем же именем, бот изменится за одну ночь, и без
 * этого сторожа об этом узнали бы по жалобе — а не из журнала в тот же
 * день.
 */

function recording(): {
  warns: { context: object; message: string }[];
  warn: (context: object, message: string) => void;
} {
  const warns: { context: object; message: string }[] = [];

  return { warns, warn: (context, message) => warns.push({ context, message }) };
}

const EXPECTED = { 'yandex:pro': '09.02.2025' } as const;

describe('сторож сборки модели', () => {
  it('молчит, когда сборка та, на которой мерили', () => {
    const log = recording();
    const watch = new ModelVersionWatch(log, EXPECTED);

    expect(watch.note('yandex:pro', '09.02.2025')).toBeUndefined();
    expect(log.warns).toEqual([]);
  });

  it('чужая сборка — предупреждение с обеими версиями и именем модели', () => {
    const log = recording();
    const watch = new ModelVersionWatch(log, EXPECTED);

    expect(watch.note('yandex:pro', '01.10.2026')).toEqual({
      model: 'yandex:pro',
      expected: '09.02.2025',
      actual: '01.10.2026',
    });
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]?.message).toContain('сборк');
    expect(log.warns[0]?.context).toEqual({
      model: 'yandex:pro',
      expected: '09.02.2025',
      actual: '01.10.2026',
    });
  });

  it('одна и та же чужая сборка — одно предупреждение, а не на каждый вызов', () => {
    // Иначе журнал за день — тысяча одинаковых строк, и их перестанут читать.
    const log = recording();
    const watch = new ModelVersionWatch(log, EXPECTED);

    watch.note('yandex:pro', '01.10.2026');
    watch.note('yandex:pro', '01.10.2026');
    watch.note('yandex:pro', '01.10.2026');

    expect(log.warns).toHaveLength(1);
  });

  it('вторая чужая сборка — второе предупреждение', () => {
    const log = recording();
    const watch = new ModelVersionWatch(log, EXPECTED);

    watch.note('yandex:pro', '01.10.2026');
    watch.note('yandex:pro', '15.10.2026');

    expect(log.warns.map((one) => one.context)).toEqual([
      { model: 'yandex:pro', expected: '09.02.2025', actual: '01.10.2026' },
      { model: 'yandex:pro', expected: '09.02.2025', actual: '15.10.2026' },
    ]);
  });

  it('модель, для которой сборка не назначена, не сторожится', () => {
    // Заглушка и запись стенда версий не имеют; чужую модель на пробе тоже
    // не за что ругать.
    const log = recording();
    const watch = new ModelVersionWatch(log, EXPECTED);

    expect(watch.note('mock', '?')).toBeUndefined();
    expect(log.warns).toEqual([]);
  });

  it('ответ без версии — судить не о чем, молчит', () => {
    const log = recording();
    const watch = new ModelVersionWatch(log, EXPECTED);

    expect(watch.note('yandex:pro', undefined)).toBeUndefined();
    expect(log.warns).toEqual([]);
  });
});

describe('ожидаемые сборки', () => {
  it('назначены для полной и лёгкой моделей боя — по явному имени и по ветке', () => {
    // Значения — из учёта боя 27.08–21.09.2026: одна сборка на каждую
    // модель за весь месяц.
    expect(EXPECTED_MODEL_VERSIONS['yandex:yandexgpt-5-pro']).toBe('09.02.2025');
    expect(EXPECTED_MODEL_VERSIONS['yandex:yandexgpt/latest']).toBe('09.02.2025');
    expect(EXPECTED_MODEL_VERSIONS['yandex:yandexgpt-5-lite']).toBe('25.03.2025');
    expect(EXPECTED_MODEL_VERSIONS['yandex:yandexgpt-lite/latest']).toBe('25.03.2025');
  });
});

describe('обёртка провайдера', () => {
  const answer: CompletionResult = {
    text: '{}',
    model: 'yandex:pro',
    tokensIn: 10,
    tokensOut: 2,
    modelVersion: '01.10.2026',
  };
  const live: LlmProvider = { name: 'yandex:pro', complete: () => Promise.resolve(answer) };
  const request = {
    stage: 'extractor' as const,
    prompt: 'п',
    input: 'в',
    jsonSchema: {},
  };

  it('версия из ответа доходит до сторожа под именем провайдера', async () => {
    const log = recording();
    const watched = watchVersions(live, new ModelVersionWatch(log, EXPECTED));

    await watched.complete(request);

    expect(log.warns[0]?.context).toEqual({
      model: 'yandex:pro',
      expected: '09.02.2025',
      actual: '01.10.2026',
    });
  });

  it('ответ и имя провайдера не меняются: учёт и запись видят то же самое', async () => {
    const watched = watchVersions(live, new ModelVersionWatch(recording(), EXPECTED));

    expect(watched.name).toBe('yandex:pro');
    await expect(watched.complete(request)).resolves.toBe(answer);
  });
});

describe('связка: бой сторожит обе модели', () => {
  /**
   * Страж по исходнику: сторож написан и покрыт, но его ещё должны
   * позвать — и для полной модели, и для лёгкой. Разрыв «написано,
   * покрыто тестами и недостижимо» уже случался.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, '../../../index.ts'), 'utf8');

  it('сторож создаётся один на процесс и уходит в обе фабрики', () => {
    expect(source.includes('new ModelVersionWatch('), 'сторож сборки не создаётся').toBe(true);

    const calls = source.match(/createLlmProvider\([^;]*;/gu) ?? [];
    expect(calls, 'фабрик модели должно быть две: полная и лёгкая').toHaveLength(2);
    for (const call of calls) {
      expect(call.includes('versionWatch'), `сторож не передан: ${call}`).toBe(true);
    }
  });
});
