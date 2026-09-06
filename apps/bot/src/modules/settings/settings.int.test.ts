import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';

import { appSettings } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { SETTINGS, SettingsRegistry, putSetting } from './settings.repo.js';

/**
 * Системные значения продукта (§14 и §15 ТЗ, задача 4.3).
 *
 * §14 требует, чтобы размер пробного периода менялся «в админ-панели без
 * выкладки новой версии». Проверяется именно это: значение из базы
 * подхватывается, пустая таблица оставляет поведение прежним, а мусор в
 * поле не роняет бота — потому что править таблицу будет человек, и
 * однажды он напишет в поле числа слово.
 */

const logger = createLogger({ level: 'silent' });

/** Часы, которыми управляет тест: без них истечение кэша не проверить. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;

  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

beforeEach(async () => {
  await testDb().delete(appSettings);
});

describe('чтение системных значений', () => {
  it('пустая таблица оставляет умолчание из кода', async () => {
    /**
     * Выкладка не должна зависеть от того, успел ли кто-то заполнить
     * настройки: пустая таблица означает «работаем как работали».
     */
    const settings = new SettingsRegistry({ db: testDb(), logger });

    expect(await settings.number('trialDumps')).toBe(SETTINGS.trialDumps.fallback);
  });

  it('значение из базы подхватывается — §14 «без выкладки»', async () => {
    await putSetting(testDb(), { name: 'trialDumps', value: '3' });

    const settings = new SettingsRegistry({ db: testDb(), logger });

    expect(await settings.number('trialDumps')).toBe(3);
  });

  it('ноль — законное значение, а не «настройки нет»', async () => {
    // Ноль означает «пробного периода нет вовсе». Если бы код принимал
    // его за пустоту, выключить пробный период было бы нечем.
    await putSetting(testDb(), { name: 'trialDumps', value: '0' });

    expect(await new SettingsRegistry({ db: testDb(), logger }).number('trialDumps')).toBe(0);
  });

  it('пробелы вокруг числа не мешают', async () => {
    await putSetting(testDb(), { name: 'trialDumps', value: '  7  ' });

    expect(await new SettingsRegistry({ db: testDb(), logger }).number('trialDumps')).toBe(7);
  });

  it('правка перезаписывает, а не заводит вторую строку', async () => {
    await putSetting(testDb(), { name: 'trialDumps', value: '3' });
    await putSetting(testDb(), { name: 'trialDumps', value: '5' });

    const rows = await testDb()
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS.trialDumps.key));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('5');
  });
});

describe('мусор в значении не роняет бота', () => {
  /**
   * Эту таблицу правит человек из админки, и однажды в поле числа
   * окажется «десять», минус или дробь. Падать на этом нельзя:
   * настройка правится на живом продукте, и цена опечатки не должна
   * равняться простою. Поэтому непонятное значение — умолчание.
   */
  const garbage = ['десять', '', '   ', '-1', '10.5', '1e3', 'NaN', '10 выгрузок'];

  it.each(garbage)('«%s» откатывается к умолчанию', async (value) => {
    await testDb().insert(appSettings).values({ key: SETTINGS.trialDumps.key, value });

    const settings = new SettingsRegistry({ db: testDb(), logger });

    expect(await settings.number('trialDumps')).toBe(SETTINGS.trialDumps.fallback);
  });

  it('и об этом остаётся строка в журнале, а не тишина', async () => {
    /**
     * Тихий откат к умолчанию — это настройка, которая «не работает» и
     * никак этого не показывает: в админке стоит одно число, бот живёт
     * по другому, и разойтись они могут на месяцы.
     */
    const warned: { key?: unknown; raw?: unknown }[] = [];
    const noisy = {
      warn: (payload: { key?: unknown; raw?: unknown }) => warned.push(payload),
    } as unknown as Logger;

    await testDb().insert(appSettings).values({ key: SETTINGS.trialDumps.key, value: 'десять' });

    await new SettingsRegistry({ db: testDb(), logger: noisy }).number('trialDumps');

    expect(warned).toHaveLength(1);
    // В строке видно и ключ, и то, что в нём лежало: без этого искать
    // опечатку пришлось бы по всей таблице.
    expect(warned[0]?.key).toBe(SETTINGS.trialDumps.key);
    expect(warned[0]?.raw).toBe('десять');
  });
});

describe('кэш', () => {
  it('в пределах срока база не перечитывается', async () => {
    await putSetting(testDb(), { name: 'trialDumps', value: '3' });

    const time = clock();
    const settings = new SettingsRegistry({ db: testDb(), logger, ttlMs: 60_000, now: time.now });

    expect(await settings.number('trialDumps')).toBe(3);

    // Правка в базе мимо реестра: в пределах срока он её не видит.
    await putSetting(testDb(), { name: 'trialDumps', value: '9' });

    expect(await settings.number('trialDumps')).toBe(3);
  });

  it('по истечении срока правка подхватывается сама', async () => {
    await putSetting(testDb(), { name: 'trialDumps', value: '3' });

    const time = clock();
    const settings = new SettingsRegistry({ db: testDb(), logger, ttlMs: 60_000, now: time.now });

    expect(await settings.number('trialDumps')).toBe(3);

    await putSetting(testDb(), { name: 'trialDumps', value: '9' });
    time.advance(60_001);

    // §14 «без выкладки»: правка из админки доходит сама, без
    // перезапуска процесса.
    expect(await settings.number('trialDumps')).toBe(9);
  });

  it('отсутствие строки кэшируется тоже', async () => {
    /**
     * Иначе до первой правки из админки каждое сообщение человека
     * стоило бы запроса в базу — а размер пробного периода спрашивается
     * на каждом входящем.
     */
    const time = clock();
    const settings = new SettingsRegistry({ db: testDb(), logger, ttlMs: 60_000, now: time.now });

    expect(await settings.number('trialDumps')).toBe(SETTINGS.trialDumps.fallback);

    await putSetting(testDb(), { name: 'trialDumps', value: '2' });

    expect(await settings.number('trialDumps')).toBe(SETTINGS.trialDumps.fallback);

    time.advance(60_001);
    expect(await settings.number('trialDumps')).toBe(2);
  });

  it('forget сбрасывает накопленное — этим воспользуется админка', async () => {
    await putSetting(testDb(), { name: 'trialDumps', value: '3' });

    const settings = new SettingsRegistry({ db: testDb(), logger });
    expect(await settings.number('trialDumps')).toBe(3);

    await putSetting(testDb(), { name: 'trialDumps', value: '9' });
    settings.forget();

    expect(await settings.number('trialDumps')).toBe(9);
  });
});
