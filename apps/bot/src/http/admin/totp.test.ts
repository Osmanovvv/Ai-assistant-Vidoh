import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { codeAt, codeMatches, decodeBase32, encodeBase32, STEP_SECONDS } from './totp.js';

/**
 * Одноразовый код второго шага (§15 ТЗ, задача 4.5).
 *
 * **Проверяется официальными векторами RFC 6238, а не своими примерами.**
 * Алгоритм написан у нас (тридцать строк вместо зависимости в цепочке
 * поставки того, что охраняет доступ к чужим выгрузкам), и право так
 * делать даёт ровно одно обстоятельство: у алгоритма есть эталонные
 * значения, опубликованные в самом стандарте. Свои придуманные примеры
 * проверяли бы код против него же.
 *
 * Векторы взяты из RFC 6238, приложение B, строки для HMAC-SHA1:
 * секрет — ASCII «12345678901234567890».
 */

/** Секрет из RFC, тот же двадцатибайтовый, но в base32. */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('разбор секрета', () => {
  it('секрет из RFC читается в те же двадцать байт', () => {
    // Проверка самой раскодировки: если она врёт, врут и все коды, а
    // векторы ниже совпасть уже не смогут.
    expect(decodeBase32(RFC_SECRET)?.toString('ascii')).toBe('12345678901234567890');
  });

  it('чужой знак делает секрет негодным, а не искажает его молча', () => {
    // Молчаливое искажение дало бы вход, который «почему-то не
    // работает», вместо внятного отказа при настройке.
    expect(decodeBase32('GEZDGNBV1')).toBeUndefined();
    expect(decodeBase32('')).toBeUndefined();
    expect(decodeBase32('   ')).toBeUndefined();
  });

  it('пробелы и заполнитель не мешают: приложения выдают секрет по-разному', () => {
    expect(decodeBase32('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')?.toString('ascii')).toBe(
      '12345678901234567890',
    );
    expect(decodeBase32('gezdgnbvgy3tqojqgezdgnbvgy3tqojq')?.toString('ascii')).toBe(
      '12345678901234567890',
    );
  });
});

describe('коды совпадают с эталоном RFC 6238', () => {
  const secret = decodeBase32(RFC_SECRET);
  if (secret === undefined) throw new Error('секрет из RFC не разобрался');

  /** Время в секундах и ожидаемый код — приложение B стандарта. */
  const vectors: readonly [number, string][] = [
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
    [20_000_000_000, '353130'],
  ];

  it.each(vectors)('на %i секундах код %s', (seconds, expected) => {
    expect(codeAt(secret, Math.floor(seconds / STEP_SECONDS))).toBe(expected);
  });

  it('последний вектор проверяет счётчик за границей 32 бит', () => {
    /**
     * 20 000 000 000 секунд — это 2033 год по номеру шага больше
     * 666 миллионов, но сам вектор здесь ради другого: он ловит ошибку
     * в записи 64-битного счётчика. Первая версия писала только младшие
     * четыре байта, и на больших числах код разошёлся бы с телефоном.
     */
    expect(codeAt(secret, Math.floor(20_000_000_000 / STEP_SECONDS))).toBe('353130');
  });
});

describe('сверка введённого кода', () => {
  /** Момент, на котором RFC ждёт код 050471. */
  const at = new Date(1_111_111_111 * 1000);

  it('верный код сходится', () => {
    expect(codeMatches({ secret: RFC_SECRET, code: '050471', now: at })).toBe(true);
  });

  it('пробелы внутри кода не мешают: их вставляют приложения', () => {
    expect(codeMatches({ secret: RFC_SECRET, code: '050 471', now: at })).toBe(true);
  });

  it('чужой код не сходится', () => {
    expect(codeMatches({ secret: RFC_SECRET, code: '050472', now: at })).toBe(false);
  });

  it('не шесть знаков — сразу нет, без обращения к алгоритму', () => {
    for (const code of ['', '5', '05047', '0504711', 'абвгде', '05047a']) {
      expect(codeMatches({ secret: RFC_SECRET, code, now: at })).toBe(false);
    }
  });

  it('код соседнего шага принимается: часы расходятся, человек набирает не мгновенно', () => {
    const before = new Date(at.getTime() - STEP_SECONDS * 1000);
    const after = new Date(at.getTime() + STEP_SECONDS * 1000);

    expect(codeMatches({ secret: RFC_SECRET, code: '050471', now: before })).toBe(true);
    expect(codeMatches({ secret: RFC_SECRET, code: '050471', now: after })).toBe(true);
  });

  it('но не через два шага — иначе код живёт полторы минуты без нужды', () => {
    const far = new Date(at.getTime() + 2 * STEP_SECONDS * 1000);

    expect(codeMatches({ secret: RFC_SECRET, code: '050471', now: far })).toBe(false);
  });

  it('негодный секрет не пускает никого', () => {
    // Опечатка в настройке не должна открывать панель — ни на одном коде.
    for (const code of ['000000', '050471', '999999']) {
      expect(codeMatches({ secret: 'не-base32-вовсе', code, now: at })).toBe(false);
      expect(codeMatches({ secret: '', code, now: at })).toBe(false);
    }
  });
});

describe('сборка base32', () => {
  /**
   * Проверяется обратимостью, а не своими примерами: сборка и разбор
   * живут рядом ровно для того, чтобы одну сторону нельзя было
   * поправить, забыв другую.
   */
  it('секрет из RFC собирается обратно знак в знак', () => {
    expect(encodeBase32(Buffer.from('12345678901234567890', 'ascii'))).toBe(RFC_SECRET);
  });

  it('двадцать случайных байт проходят круг без потерь', () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const raw = randomBytes(20);

      expect(decodeBase32(encodeBase32(raw))?.equals(raw)).toBe(true);
    }
  });

  it('длина, не кратная пяти байтам, тоже проходит круг', () => {
    // Хвостовые биты — единственное место, где такая сборка обычно врёт.
    for (const length of [1, 2, 3, 4, 6, 7, 9, 11, 16, 19]) {
      const raw = randomBytes(length);

      expect(decodeBase32(encodeBase32(raw))?.equals(raw), `длина ${String(length)}`).toBe(true);
    }
  });

  it('заполнителя не ставит: приложения читают секрет без него', () => {
    expect(encodeBase32(randomBytes(20))).not.toContain('=');
  });
});
