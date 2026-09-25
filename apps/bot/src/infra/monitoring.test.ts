import { describe, expect, it } from 'vitest';

import {
  ErrorRateWindow,
  Monitor,
  formatAlert,
  type Alert,
  type AlertMemory,
  type AlertSink,
} from './monitoring.js';

function collectingSink() {
  const delivered: Alert[] = [];
  const sink: AlertSink = {
    deliver: (alert) => {
      delivered.push(alert);
      return Promise.resolve();
    },
  };
  return { sink, delivered };
}

describe('ErrorRateWindow', () => {
  it('молчит, пока наблюдений мало', () => {
    const window = new ErrorRateWindow(60_000, 10);

    for (let i = 0; i < 9; i++) window.record(true, 1_000);

    // Девять ошибок из девяти — это ещё не статистика.
    expect(window.rate(1_000)).toBeNull();
  });

  it('считает долю ошибок', () => {
    const window = new ErrorRateWindow(60_000, 10);

    for (let i = 0; i < 10; i++) window.record(i < 3, 1_000);

    expect(window.rate(1_000)).toBeCloseTo(0.3, 5);
  });

  it('забывает события за пределами окна', () => {
    const window = new ErrorRateWindow(60_000, 5);

    for (let i = 0; i < 10; i++) window.record(true, 1_000);
    expect(window.rate(1_000)).toBe(1);

    // Спустя две минуты старые ошибки не должны влиять.
    for (let i = 0; i < 5; i++) window.record(false, 121_000);
    expect(window.rate(121_000)).toBe(0);
  });

  it('пустое окно не даёт оценки', () => {
    expect(new ErrorRateWindow(60_000).rate(0)).toBeNull();
  });
});

describe('Monitor: доля ошибок', () => {
  it('шлёт оповещение при превышении порога', async () => {
    const { sink, delivered } = collectingSink();
    const monitor = new Monitor({ sink, minSamples: 10, errorRateThreshold: 0.3, now: () => 0 });

    for (let i = 0; i < 10; i++) await monitor.recordOutcome(i >= 5);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.title).toContain('доля ошибок');
    expect(delivered[0]?.details?.['доля']).toBe('50%');
  });

  it('молчит, пока доля ниже порога', async () => {
    const { sink, delivered } = collectingSink();
    const monitor = new Monitor({ sink, minSamples: 10, errorRateThreshold: 0.5, now: () => 0 });

    for (let i = 0; i < 20; i++) await monitor.recordOutcome(i % 5 !== 0);

    expect(delivered).toEqual([]);
  });

  it('молчит на малой выборке, даже если всё упало', async () => {
    const { sink, delivered } = collectingSink();
    const monitor = new Monitor({ sink, minSamples: 10, now: () => 0 });

    for (let i = 0; i < 5; i++) await monitor.recordOutcome(false);

    expect(delivered).toEqual([]);
  });
});

describe('Monitor: дребезг', () => {
  it('не повторяет оповещение с тем же ключом в период тишины', async () => {
    const { sink, delivered } = collectingSink();
    let now = 0;
    const monitor = new Monitor({ sink, cooldownMs: 60_000, now: () => now });

    await monitor.alert({ key: 'model-down', title: 'Модель недоступна' });
    now = 30_000;
    const second = await monitor.alert({ key: 'model-down', title: 'Модель недоступна' });

    expect(second).toBe(false);
    expect(delivered).toHaveLength(1);
  });

  it('повторяет после окончания периода тишины', async () => {
    const { sink, delivered } = collectingSink();
    let now = 0;
    const monitor = new Monitor({ sink, cooldownMs: 60_000, now: () => now });

    await monitor.alert({ key: 'model-down', title: 'Модель недоступна' });
    now = 61_000;
    await monitor.alert({ key: 'model-down', title: 'Модель недоступна' });

    expect(delivered).toHaveLength(2);
  });

  it('разные ключи не глушат друг друга', async () => {
    const { sink, delivered } = collectingSink();
    const monitor = new Monitor({ sink, cooldownMs: 60_000, now: () => 0 });

    await monitor.alert({ key: 'model-down', title: 'Модель недоступна' });
    await monitor.alert({ key: 'db-down', title: 'База недоступна' });

    expect(delivered).toHaveLength(2);
  });

  it('одна авария не порождает сотню сообщений', async () => {
    const { sink, delivered } = collectingSink();
    const monitor = new Monitor({
      sink,
      minSamples: 10,
      errorRateThreshold: 0.3,
      cooldownMs: 15 * 60_000,
      now: () => 0,
    });

    for (let i = 0; i < 100; i++) await monitor.recordOutcome(false);

    expect(delivered).toHaveLength(1);
  });
});

describe('Monitor: дребезг переживает перезапуск (бой 25.09.2026)', () => {
  /**
   * «Баланс ниже порога» пришёл в 03:47 и снова в 03:51: выкладка
   * перезапустила бота, память дребезга была в процессе и пропала. Два
   * `Monitor` с одной памятью — это бот до и после перезапуска.
   */
  function sharedMemory() {
    const stored = new Map<string, number>();
    const ttls: number[] = [];
    const memory: AlertMemory = {
      last: (key) => Promise.resolve(stored.get(key)),
      remember: (key, at, ttlMs) => {
        stored.set(key, at);
        ttls.push(ttlMs);
        return Promise.resolve();
      },
      forget: (key) => {
        stored.delete(key);
        return Promise.resolve();
      },
    };
    return { memory, ttls };
  }

  it('второй процесс помнит оповещение первого: повтора нет, после паузы — есть', async () => {
    const { sink, delivered } = collectingSink();
    const { memory, ttls } = sharedMemory();
    let now = 0;
    const before = new Monitor({ sink, memory, cooldownMs: 15 * 60_000, now: () => now });
    const after = new Monitor({ sink, memory, cooldownMs: 15 * 60_000, now: () => now });

    expect(await before.alert({ key: 'yandex-balance-low', title: 'Баланс' })).toBe(true);
    now = 4 * 60_000;
    expect(await after.alert({ key: 'yandex-balance-low', title: 'Баланс' })).toBe(false);
    now = 16 * 60_000;
    expect(await after.alert({ key: 'yandex-balance-low', title: 'Баланс' })).toBe(true);

    expect(delivered).toHaveLength(2);
    // Память живёт ровно паузу: дольше хранить незачем.
    expect(ttls).toEqual([15 * 60_000, 15 * 60_000]);
  });

  it('своя пауза у оповещения — сутки у баланса — держится и через перезапуск', async () => {
    const { sink, delivered } = collectingSink();
    const { memory, ttls } = sharedMemory();
    let now = 0;
    const day = 24 * 60 * 60_000;
    const before = new Monitor({ sink, memory, now: () => now });
    const after = new Monitor({ sink, memory, now: () => now });

    await before.alert({ key: 'yandex-balance-low', title: 'Баланс', cooldownMs: day });
    now = 20 * 60_000;
    expect(await after.alert({ key: 'yandex-balance-low', title: 'Баланс', cooldownMs: day })).toBe(
      false,
    );
    now = day + 60_000;
    expect(await after.alert({ key: 'yandex-balance-low', title: 'Баланс', cooldownMs: day })).toBe(
      true,
    );

    expect(delivered).toHaveLength(2);
    expect(ttls[0]).toBe(day);
  });

  it('память недоступна — оповещение всё равно уходит: лучше повтор, чем тишина об аварии', async () => {
    const { sink, delivered } = collectingSink();
    const warnings: string[] = [];
    const broken: AlertMemory = {
      last: () => Promise.reject(new Error('Redis недоступен')),
      remember: () => Promise.reject(new Error('Redis недоступен')),
      forget: () => Promise.reject(new Error('Redis недоступен')),
    };
    const monitor = new Monitor({
      sink,
      memory: broken,
      now: () => 0,
      warn: (why) => warnings.push(why),
    });

    expect(await monitor.alert({ key: 'bot-down', title: 'Бот не отвечает' })).toBe(true);
    await monitor.forget('bot-down');

    expect(delivered).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('забытое оповещение уходит снова сразу — и в другом процессе тоже', async () => {
    const { sink, delivered } = collectingSink();
    const { memory } = sharedMemory();
    let now = 0;
    const before = new Monitor({ sink, memory, now: () => now });
    const after = new Monitor({ sink, memory, now: () => now });

    await before.alert({ key: 'yandex-balance-low', title: 'Баланс' });
    await before.forget('yandex-balance-low');
    now = 60_000;

    expect(await before.alert({ key: 'yandex-balance-low', title: 'Баланс' })).toBe(true);
    await before.forget('yandex-balance-low');
    expect(await after.alert({ key: 'yandex-balance-low', title: 'Баланс' })).toBe(true);
    expect(delivered).toHaveLength(3);
  });
});

describe('formatAlert', () => {
  it('собирает заголовок и подробности', () => {
    expect(
      formatAlert({
        key: 'error-rate',
        title: 'Выросла доля ошибок обработки',
        details: { доля: '50%', наблюдений: 20 },
      }),
    ).toBe('⚠️ Выросла доля ошибок обработки\nдоля: 50%\nнаблюдений: 20');
  });

  it('работает без подробностей', () => {
    expect(formatAlert({ key: 'k', title: 'Сервис перезапущен' })).toBe('⚠️ Сервис перезапущен');
  });
});
