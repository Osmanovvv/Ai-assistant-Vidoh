import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

/**
 * HTTP-слой (задача 1.6).
 *
 * Зависимости передаются снаружи, а не импортируются: так сервер
 * тестируется без живых Postgres и Redis, а проверки готовности можно
 * подменить на заведомо падающие.
 */

export interface HealthCheck {
  readonly name: string;
  readonly check: () => Promise<void>;
}

export interface ServerDeps {
  /** Проверки, от которых зависит готовность принимать нагрузку. */
  readonly healthChecks: readonly HealthCheck[];
  /** Обработчик вебхука Telegram. Появляется на задаче 1.7. */
  readonly webhookPath?: string;
  readonly webhookHandler?: RequestHandler;
  /** Куда сообщать о сбое обработки. Без него ошибка уйдёт в никуда. */
  readonly onError?: (error: unknown) => void;
  /** Срок ответа одной проверки готовности. */
  readonly healthCheckTimeoutMs?: number;
}

export interface ReadinessReport {
  readonly ok: boolean;
  readonly checks: Record<string, string>;
}

/**
 * Сколько ждать одну проверку, прежде чем считать её проваленной.
 *
 * Без срока проверка готовности бесполезна ровно тогда, когда нужна.
 * Клиент ioredis при недоступном сервере не отвечает отказом, а копит
 * команды до восстановления связи, и `ping` просто не возвращается —
 * запрос к /health/ready висел пять минут вместо честного 503.
 * Проверено остановкой Redis на боевом сервере.
 */
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000;

/** Тот же промис, но с обязательным сроком ответа. */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`не ответил за ${String(timeoutMs)} мс`));
    }, timeoutMs);
    // Зависшая проверка не должна удерживать процесс при остановке.
    timer.unref();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function runHealthChecks(
  checks: readonly HealthCheck[],
  timeoutMs: number = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const entries = await Promise.all(
    checks.map(async ({ name, check }): Promise<readonly [string, string]> => {
      try {
        await withDeadline(check(), timeoutMs);
        return [name, 'ok'] as const;
      } catch (error) {
        return [name, error instanceof Error ? error.message : String(error)] as const;
      }
    }),
  );

  const report: Record<string, string> = Object.fromEntries(entries);
  return { ok: entries.every(([, status]) => status === 'ok'), checks: report };
}

export function createServer(deps: ServerDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  /** Жив ли процесс. Намеренно не трогает зависимости: используется рестартером. */
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  /** Готов ли принимать нагрузку. Проверяет зависимости и честно отвечает 503. */
  app.get('/health/ready', (_req: Request, res: Response) => {
    void runHealthChecks(deps.healthChecks, deps.healthCheckTimeoutMs).then(
      (report) => {
        res.status(report.ok ? 200 : 503).json(report);
      },
      (error: unknown) => {
        res.status(503).json({
          ok: false,
          checks: { internal: error instanceof Error ? error.message : String(error) },
        });
      },
    );
  });

  if (deps.webhookPath && deps.webhookHandler) {
    // Тело апдейта разбирается только на пути вебхука: остальным ручкам
    // JSON не нужен, а лишний парсер — лишняя поверхность.
    app.use(deps.webhookPath, express.json({ limit: '1mb' }), deps.webhookHandler);
  }

  /**
   * Последний рубеж: сбой в обработке апдейта не должен ронять процесс.
   *
   * Это не перестраховка. В режиме вебхука grammY не пропускает ошибки
   * через bot.catch — тот работает только на длинных опросах. Ошибка
   * всплывает наружу, и без этого обработчика падение на одном апдейте
   * убивало весь процесс. Проверено на боевом сервере: бот перезапускался
   * на каждом входящем сообщении.
   *
   * Отвечаем 500, а не 200: Telegram повторит доставку, а апдейт у нас
   * дедуплицируется по update_id, поэтому повтор безопасен.
   */
  app.use(((error, _req, res, next) => {
    deps.onError?.(error);

    // Заголовки уже ушли — вмешиваться поздно, доводит express.
    if (res.headersSent) {
      next(error);
      return;
    }

    res.status(500).json({ ok: false });
  }) as ErrorRequestHandler);

  return app;
}
