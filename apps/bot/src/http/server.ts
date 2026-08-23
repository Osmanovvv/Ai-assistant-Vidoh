import express, { type Express, type Request, type RequestHandler, type Response } from 'express';

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
}

export interface ReadinessReport {
  readonly ok: boolean;
  readonly checks: Record<string, string>;
}

export async function runHealthChecks(checks: readonly HealthCheck[]): Promise<ReadinessReport> {
  const entries = await Promise.all(
    checks.map(async ({ name, check }): Promise<readonly [string, string]> => {
      try {
        await check();
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
    void runHealthChecks(deps.healthChecks).then(
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

  return app;
}
