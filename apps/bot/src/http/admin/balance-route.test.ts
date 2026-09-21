import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { BalanceStatus } from '../../modules/cloud/yandex-billing.js';
import { createServer } from '../server.js';
import { SESSION_COOKIE, type AdminAuthConfig } from './index.js';
import { hashPassword } from './password.js';
import { issuePass } from './token.js';

/**
 * Баланс Yandex Cloud в панели (проджект, 21.09.2026).
 *
 * Путь отвечает и без ключа — «не настроено» словами, — чтобы плитка в
 * панели объясняла пустоту, а не молчала. С ключом отдаёт то, что
 * посчитал сторож: число, порог, «низко», «устарело».
 */

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';
const SESSION_SECRET = 'секрет-подписи-пропусков-для-баланса';

let passwordHash = '';
const running: Server[] = [];

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 30_000);

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

function configOf(): AdminAuthConfig {
  return {
    login: LOGIN,
    passwordHash,
    totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    sessionSecret: SESSION_SECRET,
    secureCookies: false,
  };
}

async function listen(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => {
      resolve(started);
    });
  });

  running.push(server);
  const { port } = server.address() as AddressInfo;

  return `http://127.0.0.1:${String(port)}`;
}

async function read(base: string): Promise<{ status: number; body: unknown }> {
  const pass = issuePass({ secret: SESSION_SECRET, kind: 'session', login: LOGIN });
  const response = await fetch(`${base}/admin/api/yandex-balance`, {
    headers: { cookie: `${SESSION_COOKIE}=${pass}` },
  });

  return { status: response.status, body: await response.json() };
}

describe('путь баланса Yandex Cloud', () => {
  it('без ключа — «не настроено» словами, а не пустота и не отказ', async () => {
    const base = await listen(createServer({ healthChecks: [], admin: configOf() }));

    const { status, body } = await read(base);

    expect(status).toBe(200);
    expect(body).toEqual({ configured: false });
  });

  it('с ключом — то, что посчитал сторож', async () => {
    const answer: BalanceStatus = {
      ok: true,
      balanceRub: 1166.92,
      currency: 'RUB',
      accountName: 'account-788',
      thresholdRub: 300,
      low: false,
      fetchedAt: '2026-09-21T14:00:00.000Z',
      stale: false,
    };
    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminYandexBalance: { status: () => Promise.resolve(answer) },
      }),
    );

    const { status, body } = await read(base);

    expect(status).toBe(200);
    expect(body).toEqual({ configured: true, ...answer });
  });

  it('сторож упал — 500 со словами, а не тишина', async () => {
    const base = await listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminYandexBalance: { status: () => Promise.reject(new Error('сеть')) },
      }),
    );

    const { status, body } = await read(base);

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'не удалось прочитать баланс' });
  });

  it('без пропуска — отказ', async () => {
    const base = await listen(createServer({ healthChecks: [], admin: configOf() }));

    const response = await fetch(`${base}/admin/api/yandex-balance`);

    expect(response.status).toBe(401);
  });
});
