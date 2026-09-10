import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';

/**
 * Журнал в файл: отказ слышен, но не смертелен (ревизия этапов 1–2).
 *
 * Молчаливый отказ был двойным.
 *
 * **Первое.** Без `LOG_FILE` журнал живёт только в выводе контейнера, а тот
 * привязан к контейнеру и стирается каждой выкладкой. 04.09.2026 из-за
 * этого не удалось ответить, кто удалил данные: событие в журнал попало, а
 * часа с ним к моменту разбора уже не было. Отсутствие переменной ничем не
 * отличалось от нормы — бот поднимался и молчал.
 *
 * **Второе, и хуже.** Обещание «отказ файла не роняет бот» держалось на
 * `try/catch`, а поток открывается без ожидания: нехватка прав, полный
 * диск и несозданная папка приходят **событием**. Слушателя не было, и
 * EventEmitter бросал необработанное исключение — процесс умирал, а
 * `restart: unless-stopped` заводил петлю перезапусков. Ветка отката была
 * недостижима: все её проверки шли по счастливому пути.
 */

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('журнал в файл', () => {
  it('пишет и в файл, и в вывод', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vydoh-log-'));
    dirs.push(dir);

    const file = join(dir, 'nested', 'vydoh.log');
    const logger = createLogger({ level: 'info', file });

    logger.info({ проверка: 1 }, 'строка в журнал');

    // Поток без ожидания: даём ему дописать.
    await new Promise((done) => setTimeout(done, 200));

    expect(readFileSync(file, 'utf8')).toContain('строка в журнал');
  });

  it('недоступный файл не роняет бот', async () => {
    /**
     * Ровно то, чем оборачивается том, созданный от root: открыть нельзя.
     * Здесь это изображено путём, который файлом стать не может — внутри
     * обычного файла папки не бывает.
     */
    const dir = await mkdtemp(join(tmpdir(), 'vydoh-log-bad-'));
    dirs.push(dir);

    const blocker = join(dir, 'занято');
    createLogger({ level: 'info', file: blocker }).info('первая строка создаёт файл');
    await new Promise((done) => setTimeout(done, 200));

    const impossible = join(blocker, 'vydoh.log');
    const logger = createLogger({ level: 'info', file: impossible });

    logger.info('бот продолжает работать');

    // Ждём колбэк открытия: именно в нём и жила смерть процесса.
    await new Promise((done) => setTimeout(done, 300));

    /**
     * Утверждение здесь — не формальность. Отказ приходит событием, и без
     * слушателя он становится необработанным исключением: воркер набора
     * умирает вместе с процессом, и этот файл падает целиком. Значит
     * доказательство — то, что мы сюда дошли и логгер всё ещё пишет.
     */
    const after = join(dir, 'после.log');
    createLogger({ level: 'info', file: after }).info('журнал жив после отказа');
    await new Promise((done) => setTimeout(done, 200));

    expect(readFileSync(after, 'utf8')).toContain('журнал жив после отказа');
  });
});

describe('связка: отказ файла назван, а его отсутствие — предупреждено', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, 'logger.ts'), 'utf8');

  it('у потока в файл есть слушатель отказа', () => {
    /**
     * Без него отказ открытия становится необработанным исключением:
     * `uncaughtException` в боте не ставится нарочно, и процесс умирает.
     * `try/catch` этого не ловит — поток открывается без ожидания.
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '');

    expect(code, 'у потока в файл снова нет слушателя отказа').toMatch(/toFile\.on\(\s*'error'/u);
  });

  it('жалоба звучит один раз, а не на каждую строку', () => {
    // Поток отказывает на каждой записи; жалоба на каждую утопила бы сам
    // журнал — та же слепота, только громкая.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '');

    expect(code).toContain('if (told) return;');
  });
});
