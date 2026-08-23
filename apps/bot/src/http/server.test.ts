import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createServer, runHealthChecks, type HealthCheck } from './server.js';

const running: Server[] = [];

/** Поднимает приложение на свободном порту и возвращает базовый адрес. */
async function listen(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  running.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

const passing = (name: string): HealthCheck => ({ name, check: () => Promise.resolve() });
const failing = (name: string, message: string): HealthCheck => ({
  name,
  check: () => Promise.reject(new Error(message)),
});

describe('runHealthChecks', () => {
  it('считает набор готовым, когда все проверки прошли', async () => {
    const report = await runHealthChecks([passing('postgres'), passing('redis')]);

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual({ postgres: 'ok', redis: 'ok' });
  });

  it('одна упавшая проверка делает набор неготовым', async () => {
    const report = await runHealthChecks([passing('postgres'), failing('redis', 'нет связи')]);

    expect(report.ok).toBe(false);
    expect(report.checks['redis']).toBe('нет связи');
  });

  it('выполняет проверки параллельно, а не по очереди', async () => {
    const slow = (name: string): HealthCheck => ({
      name,
      check: () => new Promise<void>((resolve) => setTimeout(resolve, 40)),
    });

    const started = Date.now();
    await runHealthChecks([slow('a'), slow('b'), slow('c')]);

    expect(Date.now() - started).toBeLessThan(110);
  });

  it('не падает, если проверка бросила не Error', async () => {
    const report = await runHealthChecks([
      // Отклонение не-Error здесь намеренное: драйверы иногда так делают,
      // и проверка готовности не должна на этом разваливаться.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      { name: 'strange', check: () => Promise.reject('строка') },
    ]);

    expect(report.ok).toBe(false);
    expect(report.checks['strange']).toBe('строка');
  });
});

describe('GET /health', () => {
  it('отвечает 200 и не трогает зависимости', async () => {
    let touched = false;
    const app = createServer({
      healthChecks: [
        {
          name: 'postgres',
          check: () => {
            touched = true;
            return Promise.resolve();
          },
        },
      ],
    });

    const base = await listen(app);
    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(touched).toBe(false);
  });
});

describe('GET /health/ready', () => {
  it('отвечает 200, когда зависимости живы', async () => {
    const app = createServer({ healthChecks: [passing('postgres'), passing('redis')] });
    const base = await listen(app);

    const response = await fetch(`${base}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('отвечает 503 и называет упавшую зависимость', async () => {
    const app = createServer({
      healthChecks: [passing('postgres'), failing('redis', 'connection refused')],
    });
    const base = await listen(app);

    const response = await fetch(`${base}/health/ready`);
    const body = (await response.json()) as { ok: boolean; checks: Record<string, string> };

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks['postgres']).toBe('ok');
    expect(body.checks['redis']).toBe('connection refused');
  });
});

describe('монтирование вебхука', () => {
  it('не заводит путь вебхука, пока обработчик не передан', async () => {
    const app = createServer({ healthChecks: [] });
    const base = await listen(app);

    const response = await fetch(`${base}/telegram/webhook`, { method: 'POST' });

    expect(response.status).toBe(404);
  });

  it('передаёт запрос обработчику и разбирает тело как JSON', async () => {
    let received: unknown;
    const app = createServer({
      healthChecks: [],
      webhookPath: '/telegram/webhook',
      webhookHandler: (req, res) => {
        received = req.body;
        res.sendStatus(200);
      },
    });
    const base = await listen(app);

    const response = await fetch(`${base}/telegram/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: 1 }),
    });

    expect(response.status).toBe(200);
    expect(received).toEqual({ update_id: 1 });
  });
});
