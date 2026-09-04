import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REDACTION_PLACEHOLDER, createLogger, currentRequestId, withRequestId } from './logger.js';

interface LogRecord {
  readonly level: number;
  readonly msg?: string;
  readonly requestId?: string;
  readonly service?: string;
  readonly [key: string]: unknown;
}

/** Логгер, пишущий в память, чтобы проверять то, что реально попало в поток. */
function loggerWithSink() {
  const records: LogRecord[] = [];

  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() !== '') {
          records.push(JSON.parse(line) as LogRecord);
        }
      }
      callback();
    },
  });

  return { logger: createLogger({ level: 'trace' }, sink), records };
}

describe('createLogger', () => {
  it('пишет структурный JSON, а не строку', () => {
    const { logger, records } = loggerWithSink();

    logger.info({ userId: 42 }, 'сообщение принято');

    expect(records).toHaveLength(1);
    expect(records[0]?.msg).toBe('сообщение принято');
    expect(records[0]?.['userId']).toBe(42);
  });

  it('помечает записи именем сервиса', () => {
    const { logger, records } = loggerWithSink();

    logger.info('старт');

    expect(records[0]?.service).toBe('vydoh-bot');
  });

  it('уважает уровень логирования', () => {
    const records: LogRecord[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        records.push(JSON.parse(chunk.toString('utf8')) as LogRecord);
        callback();
      },
    });
    const logger = createLogger({ level: 'warn' }, sink);

    logger.info('не должно попасть');
    logger.warn('должно попасть');

    expect(records).toHaveLength(1);
    expect(records[0]?.msg).toBe('должно попасть');
  });
});

describe('редактирование пользовательского содержимого', () => {
  it('скрывает текст сообщения на верхнем уровне', () => {
    const { logger, records } = loggerWithSink();

    logger.info({ text: 'записать сына к врачу в четверг' }, 'разбор');

    expect(records[0]?.['text']).toBe(REDACTION_PLACEHOLDER);
  });

  it('скрывает расшифровку вложенным объектом', () => {
    const { logger, records } = loggerWithSink();

    logger.info({ message: { transcript: 'я сегодня вообще без сил' } }, 'расшифровка');

    const message = records[0]?.['message'] as Record<string, unknown>;
    expect(message['transcript']).toBe(REDACTION_PLACEHOLDER);
  });

  it('скрывает секреты и токены', () => {
    const { logger, records } = loggerWithSink();

    logger.info({ token: 'секретное значение', nested: { secret: 'тоже' } }, 'конфигурация');

    expect(records[0]?.['token']).toBe(REDACTION_PLACEHOLDER);
    expect((records[0]?.['nested'] as Record<string, unknown>)['secret']).toBe(
      REDACTION_PLACEHOLDER,
    );
  });

  it('не трогает служебные поля', () => {
    const { logger, records } = loggerWithSink();

    logger.info({ userId: 7, batchId: 'b-1', durationMs: 120 }, 'готово');

    expect(records[0]?.['userId']).toBe(7);
    expect(records[0]?.['batchId']).toBe('b-1');
    expect(records[0]?.['durationMs']).toBe(120);
  });
});

describe('сквозной идентификатор запроса', () => {
  it('добавляется ко всем записям внутри контекста', () => {
    const { logger, records } = loggerWithSink();

    withRequestId(() => {
      logger.info('первая');
      logger.info('вторая');
    }, 'req-1');

    expect(records.map((r) => r.requestId)).toEqual(['req-1', 'req-1']);
  });

  it('отсутствует за пределами контекста', () => {
    const { logger, records } = loggerWithSink();

    logger.info('вне контекста');

    expect(records[0]?.requestId).toBeUndefined();
  });

  it('переживает границу async и подхватывается вложенными вызовами', async () => {
    const { logger, records } = loggerWithSink();

    // Модуль, который ничего не знает про идентификатор и просто пишет лог.
    async function nestedModule(): Promise<void> {
      await delay(1);
      logger.info('из вложенного модуля');
    }

    await withRequestId(async () => {
      logger.info('до await');
      await nestedModule();
    }, 'req-async');

    expect(records).toHaveLength(2);
    expect(records.every((r) => r.requestId === 'req-async')).toBe(true);
  });

  it('не смешивает идентификаторы параллельных запросов', async () => {
    const { logger, records } = loggerWithSink();

    await Promise.all([
      withRequestId(async () => {
        await delay(5);
        logger.info('первый');
      }, 'req-a'),
      withRequestId(async () => {
        await delay(1);
        logger.info('второй');
      }, 'req-b'),
    ]);

    const byMessage = new Map(records.map((r) => [r.msg, r.requestId]));
    expect(byMessage.get('первый')).toBe('req-a');
    expect(byMessage.get('второй')).toBe('req-b');
  });

  it('генерирует идентификатор, если он не задан', () => {
    const { logger, records } = loggerWithSink();

    withRequestId(() => {
      logger.info('без явного идентификатора');
    });

    expect(records[0]?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe('currentRequestId', () => {
  it('возвращает идентификатор внутри контекста', () => {
    expect(withRequestId(() => currentRequestId(), 'req-x')).toBe('req-x');
  });

  it('возвращает undefined вне контекста', () => {
    expect(currentRequestId()).toBeUndefined();
  });
});

describe('журнал в файл (задача 3.51)', () => {
  /**
   * `docker logs` живёт вместе с контейнером: выкладка пересоздаёт его и
   * стирает всё сказанное до неё. 04.09.2026 из-за этого не удалось
   * выяснить, кто удалил данные пользователя — событие было в тот час, а
   * контейнер к тому времени сменился дважды.
   */

  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vydoh-log-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Ждём, пока pino допишет: поток асинхронный. */
  async function contentsOf(file: string): Promise<string> {
    for (let attempt = 0; attempt < 40; attempt++) {
      await delay(25);
      try {
        const text = await readFile(file, 'utf8');
        if (text.trim() !== '') return text;
      } catch {
        // Файла ещё нет — это нормально, ждём.
      }
    }

    return '';
  }

  it('пишет записи в указанный файл', async () => {
    const file = join(dir, 'vydoh.log');
    const logger = createLogger({ level: 'info', file });

    logger.info({ batchId: 'b-1' }, 'Выгрузка разобрана');

    const written = await contentsOf(file);
    const record = JSON.parse(written.trim().split('\n')[0] ?? '{}') as LogRecord;

    expect(record.msg).toBe('Выгрузка разобрана');
    expect(record.service).toBe('vydoh-bot');
    expect(record['batchId']).toBe('b-1');
  });

  it('создаёт папку, если её ещё нет', async () => {
    // На чистом сервере тома нет до первого запуска.
    const file = join(dir, 'глубже', 'ещё', 'vydoh.log');
    const logger = createLogger({ level: 'info', file });

    logger.warn('Папки не было');

    expect((await contentsOf(file)).trim()).toContain('Папки не было');
  });

  it('в файле работает то же скрытие содержимого, что в выводе (§16)', async () => {
    // Иначе файл на диске стал бы дырой в том, что redact закрывает.
    const file = join(dir, 'redact.log');
    const logger = createLogger({ level: 'info', file });

    logger.info({ text: 'купить хлеб', token: 'секрет' }, 'Сохранено');

    const record = JSON.parse((await contentsOf(file)).trim()) as LogRecord;
    expect(record['text']).toBe(REDACTION_PLACEHOLDER);
    expect(record['token']).toBe(REDACTION_PLACEHOLDER);
  });

  it('уровень уважается и в файле', async () => {
    const file = join(dir, 'level.log');
    const logger = createLogger({ level: 'warn', file });

    logger.debug('этого быть не должно');
    logger.warn('а это должно');

    const written = await contentsOf(file);
    expect(written).toContain('а это должно');
    expect(written).not.toContain('этого быть не должно');
  });

  it('без файла ведёт себя как прежде', () => {
    // Ни один служебный скрипт не должен от настройки зависеть.
    const logger = createLogger({ level: 'info' });

    expect(() => {
      logger.info('в вывод');
    }).not.toThrow();
  });
});
