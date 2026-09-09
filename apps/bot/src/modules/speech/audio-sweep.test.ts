import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { sweepAudioLeftovers } from './audio.service.js';

/**
 * Голос человека не переживает перезапуск (§16; ревизия первого этапа).
 *
 * §16 ТЗ дословно: «Исходный аудиофайл удаляется сразу после успешной
 * расшифровки. Хранение аудио дольше времени обработки запрещено».
 * Удаление живёт в `finally` одного вызова — и не исполняется, когда
 * процесс убит: штатная остановка ждёт задание пятнадцать секунд, а
 * расшифровка идёт минутами. То есть **любая выкладка во время разбора**
 * оставляла голос на диске, а контейнер поднимался на прежнем слое.
 *
 * Проверка работает с настоящей временной папкой, а не с подделкой:
 * подметание — про файловую систему, и подделать её значило бы проверить
 * свою же выдумку.
 */

const created: string[] = [];

/** Своя папка с нужным возрастом и приставкой. */
async function leftover(prefix: string, ageMs: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));

  created.push(dir);
  await writeFile(join(dir, 'part-1.wav'), 'звук');

  const when = new Date(Date.now() - ageMs);
  await utimes(dir, when, when);

  return dir;
}

async function exists(dir: string): Promise<boolean> {
  const parent = dirname(dir);
  const name = dir.slice(parent.length + 1);

  return (await readdir(parent)).includes(name);
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('подметание временных папок расшифровки', () => {
  it('убирает папку, оставшуюся от убитого процесса', async () => {
    const old = await leftover('vydoh-audio-', 3 * 60 * 60 * 1000);

    const swept = await sweepAudioLeftovers();

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await exists(old)).toBe(false);
  });

  it('не трогает папку идущей прямо сейчас расшифровки', async () => {
    /**
     * Главная опасность подметания, а не приятная мелочь. Выкладка
     * поднимает новый контейнер до остановки старого, а на машине
     * разработчика соседний прогон — обычное дело. Подмети без порога по
     * возрасту — и вырвешь файлы у живой расшифровки, то есть починка
     * §16 стала бы потерей выгрузки.
     */
    const fresh = await leftover('vydoh-audio-', 0);

    await sweepAudioLeftovers();

    expect(await exists(fresh)).toBe(true);
  });

  it('чужие папки не трогает вовсе', async () => {
    // Во временной папке живут не только наши файлы, и ошибиться здесь
    // значит удалить чужое у человека на машине.
    const alien = await leftover('vydoh-eval-', 3 * 60 * 60 * 1000);

    await sweepAudioLeftovers();

    expect(await exists(alien)).toBe(true);
  });

  it('порог возраста задаётся, и по нему считается', async () => {
    const hourOld = await leftover('vydoh-audio-', 60 * 60 * 1000);

    // Своё «сейчас» и свой порог: иначе проверка зависела бы от часов.
    const swept = await sweepAudioLeftovers({ olderThanMs: 10, now: Date.now() });

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await exists(hourOld)).toBe(false);
  });

  it('нечитаемая временная папка не роняет бота', async () => {
    // Подметание — про опрятность, а не про работу: отказ файловой
    // системы не должен мешать боту подняться.
    await expect(sweepAudioLeftovers({ olderThanMs: 1 })).resolves.toBeTypeOf('number');
  });
});

describe('подметание подключено к запуску', () => {
  /**
   * Страж связки, а не украшение. Урок первого этапа записан дословно:
   * «модуль может быть написан, покрыт тестами и не подключён ни к чему»
   * — так вышло со статусным сообщением, и бот не отвечал человеку
   * ничего. Здесь цена промаха тише: §16 нарушался бы молча, а проверки
   * выше оставались бы зелёными.
   */
  const start = resolve(dirname(fileURLToPath(import.meta.url)), '../../index.ts');

  it('боевая сборка зовёт подметание', () => {
    const source = readFileSync(start, 'utf8');

    expect(
      source.includes('sweepAudioLeftovers('),
      'в src/index.ts нет вызова sweepAudioLeftovers: подметание написано, покрыто проверками ' +
        'и недостижимо, а голос человека переживает перезапуск',
    ).toBe(true);
  });

  it('и правда читает запуск, а не пустоту', () => {
    // Съехавший путь дал бы пустую строку и вечно зелёную проверку выше.
    expect(readFileSync(start, 'utf8').length).toBeGreaterThan(10_000);
  });
});
