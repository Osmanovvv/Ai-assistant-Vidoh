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
  /**
   * Пароли Робокассы (задача 4.2).
   *
   * Их три, они разные, и каждый — доступ к деньгам магазина: первым
   * подписывается платёж, вторым проверяется уведомление. Настройки
   * провайдера легко уехать в журнал целиком — достаточно один раз
   * написать `logger.error({ deps }, …)`.
   */
  'password',
  'password1',
  'password2',
] as const;

const REDACT_PATHS = [
  ...REDACTED_FIELDS,
  ...REDACTED_FIELDS.map((field) => `*.${field}`),
  /**
   * Глубже одного уровня (задача 3.60).
   *
   * Боевое 04.09.2026, 19:28: отправка ответа на `/menu` отвалилась по
   * сети, grammY поднял `BotError`, и в журнал ушёл **весь контекст
   * апдейта** — с токеном бота в `err.ctx.api.token` и с текстом
   * сообщения человека в `err.ctx.update.message.text`. Маска `*.token`
   * достаёт на один уровень, а здесь три.
   */
  ...REDACTED_FIELDS.map((field) => `*.*.${field}`),
  ...REDACTED_FIELDS.map((field) => `*.*.*.${field}`),
  'err.ctx',
  'req.headers.authorization',
  'req.headers.cookie',
];

export const REDACTION_PLACEHOLDER = '[скрыто]';

/**
 * Токен бота, вклеенный в строку: `bot123456:AAAA…` внутри адреса запроса.
 *
 * Маска по полям до строк не достаёт, а grammY кладёт адрес запроса вместе
 * с токеном в `message` и `stack` сетевой ошибки. Токен — это доступ к
 * боту целиком; строка с ним в журнале равна строке с паролем.
 */
const BOT_TOKEN_IN_TEXT = /bot\d{6,}:[A-Za-z0-9_-]{20,}/gu;

function scrubText(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(BOT_TOKEN_IN_TEXT, 'bot[скрыто]') : value;
}

/**
 * Значения упавшего запроса, вклеенные в текст ошибки базы.
 *
 * **Найдено ревизией четвёртого этапа.** Отказ drizzle собирает своё
 * сообщение как «Failed query: … / params: …» и кладёт значения ещё и в
 * поле `params`. А значениями бывают слова человека: поиск по имени в
 * панели уходит в запрос параметром, и упавший запрос уносил это имя в
 * журнал — прямо против §16 и против того, о чём предупреждает шапка
 * этого файла.
 *
 * Хвост отрезается, а не маскируется: сам текст запроса разбирающему
 * нужен, а значения — нет, они и так есть у него в панели.
 */
const QUERY_PARAMS_TAIL = new RegExp(`${String.fromCharCode(10)}params:[\\s\\S]*$`, 'u');

/**
 * Поля отказа, которые несут значения запроса целиком.
 *
 * Выбрасываются, а не маскируются: в них нет ничего, кроме значений.
 */
const QUERY_FIELDS = new Set(['params', 'query', 'ctx']);

function scrubMessage(value: unknown): unknown {
  const text = scrubText(value);

  return typeof text === 'string'
    ? text.replace(QUERY_PARAMS_TAIL, `${String.fromCharCode(10)}params: [скрыто]`)
    : text;
}

/**
 * Ошибка в журнал — без контекста апдейта, без токена и без значений
 * упавшего запроса.
 *
 * Стандартный сериализатор pino берёт `message`, `stack` и `type`, а всё
 * остальное копирует как есть. Здесь то же, но: `ctx` (контекст grammY
 * с токеном и текстом человека) выбрасывается, вложенные причины
 * (`error`, `cause`) проходят ту же чистку, потому что токен сидит в
 * `err.error.error.message` — на третьем уровне, — а `params` и `query`
 * отказа базы выбрасываются целиком: в них лежит то, что человек искал.
 */
function scrubError(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 5) return scrubText(value);

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (value instanceof Error) {
    out['type'] = value.name;
    out['message'] = scrubMessage(value.message);
    if (value.stack !== undefined) out['stack'] = scrubMessage(value.stack);
  }

  for (const [key, field] of Object.entries(source)) {
    if (QUERY_FIELDS.has(key)) continue;
    if (key === 'message' || key === 'stack') {
      out[key] = scrubMessage(field);
      continue;
    }
    out[key] =
      typeof field === 'object' && field !== null ? scrubError(field, depth + 1) : scrubText(field);
  }

  return out;
}

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

/**
 * Чем становится поток файла после отказа: запись «принята» и выброшена,
 * сброс и закрытие — ничего не делают. `true` у записи — договор
 * sonic-boom «буфер не переполнен»: pino этот возврат не читает, но
 * сигнатура потока обещает именно его.
 */
const swallowWrite = (): boolean => true;
const doNothing = (): void => undefined;

export function createLogger(
  options: CreateLoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  const { level = 'info', pretty = false, file } = options;

  const base = {
    level,
    base: { service: 'vydoh-bot' },
    redact: { paths: REDACT_PATHS, censor: REDACTION_PLACEHOLDER },
    serializers: { err: scrubError },
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
    const toStdout = pino.destination({ dest: 1, sync: false });

    try {
      const toFile = pino.destination({ dest: file, append: true, mkdir: true, sync: false });

      /**
       * **Отказ файла обязан быть слышен, а не смертелен** (ревизия
       * этапов 1–2).
       *
       * `try/catch` ловит только синхронный бросок, а поток открыт с
       * `sync: false`: папка не создалась, кончилось место, нет прав —
       * всё это приходит **событием** `error` из колбэка открытия файла.
       * Слушателя у него не было ни одного, значит EventEmitter бросал
       * необработанное исключение, а `uncaughtException` в боте не
       * ставится нарочно. То есть ровно те три причины, ради которых
       * писался откат ниже, процесс убивали — и `restart: unless-stopped`
       * заводил петлю перезапусков.
       *
       * Случай не выдуманный: том `./logs` создаёт демон Docker от root,
       * а бот работает под непривилегированным пользователем.
       *
       * **Слушателя мало — поток надо ещё и отключить.** После отказа
       * открытия у sonic-boom остаётся `fd = -1`, и следующая же строка
       * журнала уходит в `fs.write(-1, …)`, а это **синхронный** бросок
       * `RangeError` — из самого `logger.info()`, где бы его ни вызвали:
       * из обработчика апдейта, из `bot.catch`, из ловца отказов промисов.
       * Отказ записи (полный диск) мягче, но тоже не проходит: каждая
       * строка снова бьётся в тот же кусок и копится в буфере без предела.
       * И на выходе процесса pino зовёт `flushSync()` отказавшего потока,
       * а тот бросает «sonic boom is not ready yet» из обработчика `exit`.
       *
       * Поэтому первый же отказ гасит поток целиком — так же, как сам
       * pino гасит его при EPIPE (`pino/lib/tools.js`, `filterBrokenPipe`):
       * запись, закрытие и сброс становятся пустыми, и в `multistream`
       * по-настоящему остаётся один поток. Обещание плана «нет прав,
       * кончилось место — остаётся один поток» держится на этом, а не на
       * `catch` ниже.
       *
       * Говорим один раз: pino переизлучает событие внутри своего же
       * слушателя, и без защёлки одна причина звучала бы дважды.
       */
      let told = false;

      toFile.on('error', (error: unknown) => {
        if (told) return;
        told = true;

        toFile.write = swallowWrite;
        toFile.flush = doNothing;
        toFile.flushSync = doNothing;
        toFile.end = doNothing;
        toFile.destroy = doNothing;

        pino(base, toStdout).error(
          { err: error, file },
          'Журнал в файл не пишется, остаётся только вывод: разбирать вчерашнее будет нечем',
        );
      });

      return pino(
        base,
        pino.multistream(
          [
            { level, stream: toStdout },
            { level, stream: toFile },
          ],
          { levels: pino.levels.values },
        ),
      );
    } catch (error) {
      const fallback = pino(base, toStdout);
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
