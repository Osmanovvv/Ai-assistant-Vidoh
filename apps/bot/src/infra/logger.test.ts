import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

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
