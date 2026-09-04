import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import pino, { type DestinationStream, type Logger } from 'pino';

/**
 * Логирование (задача 1.4).
 *
 * §18 ТЗ требует структурных логов со сквозным идентификатором запроса.
 * Идентификатор кладётся в контекст один раз на входящий апдейт и дальше
 * подхватывается всеми модулями конвейера автоматически, без проброса
 * параметром через десять слоёв.
 */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Поля, содержимое которых не должно попадать в логи (§16 ТЗ): расшифровки,
 * тексты сообщений, заголовки записей, секреты.
 *
 * Это страховка, а не основная защита. Основная — не передавать содержимое
 * пользователя в логгер вовсе: redact работает по полям объекта и не спасёт,
 * если текст вклеен в саму строку сообщения.
 */
const REDACTED_FIELDS = [
  'text',
  'transcript',
  'combinedText',
  'combined_text',
  'caption',
  'title',
  'body',
  'token',
  'secret',
] as const;

const REDACT_PATHS = [
  ...REDACTED_FIELDS,
  ...REDACTED_FIELDS.map((field) => `*.${field}`),
  'req.headers.authorization',
  'req.headers.cookie',
];

export const REDACTION_PLACEHOLDER = '[скрыто]';

export interface CreateLoggerOptions {
  readonly level?: LogLevel;
  /** Человекочитаемый вывод для разработки. В тестах и проде выключен. */
  readonly pretty?: boolean;
  /**
   * Файл журнала — вторым потоком, рядом со стандартным выводом (3.51).
   *
   * **Зачем понадобился.** Журнал жил только в `docker logs`, а он
   * привязан к контейнеру: каждая выкладка пересоздаёт контейнер, и всё
   * сказанное до неё исчезает. 04.09.2026 из-за этого не удалось
   * ответить на простой вопрос — кто удалил данные проджекта: событие
   * было в тот час, а контейнер к тому времени сменился дважды.
   *
   * Файл лежит на томе хозяина, поэтому переживает и выкладку, и
   * перезапуск. Стандартный вывод при этом остаётся: `docker logs`
   * по-прежнему показывает свежее, и ничего в привычках не меняется.
   *
   * Не задан — ведём себя как прежде. Ни один служебный скрипт от этого
   * не зависит.
   */
  readonly file?: string | undefined;
}

export function createLogger(
  options: CreateLoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  const { level = 'info', pretty = false, file } = options;

  const base = {
    level,
    base: { service: 'vydoh-bot' },
    redact: { paths: REDACT_PATHS, censor: REDACTION_PLACEHOLDER },
    mixin: (): Record<string, string> => {
      const context = storage.getStore();
      return context ? { requestId: context.requestId } : {};
    },
  };

  if (destination) {
    return pino(base, destination);
  }

  /**
   * Два потока: стандартный вывод и файл.
   *
   * **Отказ файла не роняет бот.** Не создалась папка, кончилось место,
   * нет прав — журнал должен ухудшиться, а не остановить продукт.
   * Поэтому при ошибке остаётся один поток, и об этом говорится в него
   * же: молча потерять журнал хуже, чем потерять его громко.
   */
  if (file !== undefined && file !== '') {
    try {
      const streams = [
        { level, stream: pino.destination({ dest: 1, sync: false }) },
        { level, stream: pino.destination({ dest: file, append: true, mkdir: true, sync: false }) },
      ];

      return pino(base, pino.multistream(streams, { levels: pino.levels.values }));
    } catch (error) {
      const fallback = pino(base);
      fallback.error({ err: error, file }, 'Журнал в файл не открылся, пишу только в вывод');
      return fallback;
    }
  }

  if (pretty) {
    /**
     * Читаемый вывод — удобство разработки, и его отсутствие не повод
     * падать.
     *
     * `pino-pretty` стоит в devDependencies, а в боевом образе их нет. На
     * этом сломалась заливка промптов на сервер: служебный скрипт, который
     * работает только на машине разработчика, — не служебный скрипт.
     * Поэтому здесь откат к обычному JSON, а не отказ.
     */
    try {
      return pino({
        ...base,
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service' },
        },
      });
    } catch {
      return pino(base);
    }
  }

  return pino(base);
}

/**
 * Выполняет функцию в контексте с идентификатором запроса. Все вызовы
 * логгера внутри, включая асинхронные, получат этот идентификатор.
 */
export function withRequestId<T>(fn: () => T, requestId: string = randomUUID()): T {
  return storage.run({ requestId }, fn);
}

/** Идентификатор текущего запроса, если код выполняется внутри контекста. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
