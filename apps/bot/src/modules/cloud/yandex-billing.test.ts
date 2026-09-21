import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Alert } from '../../infra/monitoring.js';
import {
  parseServiceAccountKey,
  signServiceAccountJwt,
  YandexBalanceWatch,
  YandexBillingClient,
} from './yandex-billing.js';

/**
 * Баланс Yandex Cloud в панели (проджект, 21.09.2026: «сколько на
 * балансе щас»).
 *
 * Ключ сервисного аккаунта заказчицы обменивается на IAM-токен (JWT,
 * PS256), токеном читается платёжный счёт. Всё без сети: обмен и счёт
 * подменяются, ключ здесь — свой, выпущенный на месте.
 */

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });

const KEY_JSON = JSON.stringify({
  id: 'ajeXXXXXXXXXXXXXXXXX',
  service_account_id: 'ajeYYYYYYYYYYYYYYYYY',
  created_at: '2026-09-21T13:35:37Z',
  key_algorithm: 'RSA_2048',
  public_key: publicPem,
  private_key: `PLEASE DO NOT REMOVE THIS LINE! Yandex.Cloud SA Key ID <ajeXXXXXXXXXXXXXXXXX>\n${privatePem}`,
});

const NOW = new Date('2026-09-21T14:00:00.000Z');

describe('файл ключа сервисного аккаунта', () => {
  it('читается: идентификаторы и ключ, без первой строки-предупреждения', () => {
    const key = parseServiceAccountKey(KEY_JSON, '/secrets/key.json');

    expect(key.id).toBe('ajeXXXXXXXXXXXXXXXXX');
    expect(key.serviceAccountId).toBe('ajeYYYYYYYYYYYYYYYYY');
    expect(key.privateKey.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
  });

  it('кривой файл — отказ с именем файла, без содержимого', () => {
    for (const text of ['не json', '{}', JSON.stringify({ id: 'x', service_account_id: 'y' })]) {
      expect(() => parseServiceAccountKey(text, '/secrets/key.json'), text).toThrow(
        /\/secrets\/key\.json/u,
      );
      try {
        parseServiceAccountKey(text, '/secrets/key.json');
      } catch (error) {
        expect(String(error)).not.toContain('service_account_id: y');
      }
    }
  });
});

describe('JWT для обмена на IAM-токен', () => {
  const key = parseServiceAccountKey(KEY_JSON, 'ключ');

  it('заголовок PS256 с kid, срок не больше часа, подпись проверяется открытым ключом', () => {
    const jwt = signServiceAccountJwt(key, NOW);
    const [header = '', payload = '', signature = ''] = jwt.split('.');

    const decode = (part: string): Record<string, unknown> =>
      JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

    expect(decode(header)).toEqual({ typ: 'JWT', alg: 'PS256', kid: key.id });
    const body = decode(payload);
    expect(body['iss']).toBe(key.serviceAccountId);
    expect(body['aud']).toBe('https://iam.api.cloud.yandex.net/iam/v1/tokens');
    expect(body['iat']).toBe(Math.floor(NOW.getTime() / 1000));
    expect((body['exp'] as number) - (body['iat'] as number)).toBeLessThanOrEqual(3600);

    const ok = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: createPublicKey(publicPem), padding: 6, saltLength: 32 },
      Buffer.from(signature, 'base64url'),
    );
    expect(ok).toBe(true);
  });
});

/** Адрес запроса словами: строка, URL или Request. */
function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** Подменённая сеть: обмен токена и список счетов, со счётчиком обращений. */
function fakeCloud(params: {
  readonly balance?: string;
  readonly expiresAt?: string;
  readonly billingStatus?: number;
  readonly accounts?: readonly Record<string, unknown>[];
}) {
  const calls = { iam: 0, billing: 0, lastAuth: '' };

  const fetcher = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes('iam.api.cloud.yandex.net')) {
      calls.iam++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            iamToken: `t0k3n-${String(calls.iam)}`,
            expiresAt: params.expiresAt ?? '2026-09-22T02:00:00.000Z',
          }),
          { status: 200 },
        ),
      );
    }
    calls.billing++;
    calls.lastAuth = String(new Headers(init?.headers).get('authorization'));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          billingAccounts: params.accounts ?? [
            {
              active: true,
              id: 'dn2XXXXXXXXXXXXXXXXX',
              name: 'account-788',
              currency: 'RUB',
              balance: params.balance ?? '1166.9196489',
            },
          ],
        }),
        { status: params.billingStatus ?? 200 },
      ),
    );
  }) as typeof fetch;

  return { fetcher, calls };
}

describe('клиент биллинга', () => {
  const key = parseServiceAccountKey(KEY_JSON, 'ключ');

  it('меняет ключ на токен, читает счёт: баланс в рублях с копейками', async () => {
    const cloud = fakeCloud({});
    const client = new YandexBillingClient({ key, fetch: cloud.fetcher, now: () => NOW });

    const balance = await client.balance();

    expect(balance).toEqual({
      accountId: 'dn2XXXXXXXXXXXXXXXXX',
      accountName: 'account-788',
      balanceRub: 1166.92,
      currency: 'RUB',
      active: true,
    });
    expect(cloud.calls.lastAuth).toBe('Bearer t0k3n-1');
  });

  it('токен живёт до срока: второй запрос счёта обмена не делает, после срока — делает', async () => {
    let now = NOW;
    const cloud = fakeCloud({ expiresAt: '2026-09-21T15:00:00.000Z' });
    const client = new YandexBillingClient({ key, fetch: cloud.fetcher, now: () => now });

    await client.balance();
    await client.balance();
    expect(cloud.calls.iam).toBe(1);

    // За пять минут до срока токен считается истёкшим — обмен заново.
    now = new Date('2026-09-21T14:56:00.000Z');
    await client.balance();
    expect(cloud.calls.iam).toBe(2);
    expect(cloud.calls.lastAuth).toBe('Bearer t0k3n-2');
  });

  it('отказ облака — ошибка со статусом, без токена в тексте', async () => {
    const cloud = fakeCloud({ billingStatus: 403 });
    const client = new YandexBillingClient({ key, fetch: cloud.fetcher, now: () => NOW });

    await expect(client.balance()).rejects.toThrow(/403/u);
    await expect(client.balance()).rejects.not.toThrow(/t0k3n/u);
  });

  it('несколько счетов — берётся активный', async () => {
    const cloud = fakeCloud({
      accounts: [
        { active: false, id: 'old', name: 'старый', currency: 'RUB', balance: '0' },
        { active: true, id: 'new', name: 'новый', currency: 'RUB', balance: '10' },
      ],
    });
    const client = new YandexBillingClient({ key, fetch: cloud.fetcher, now: () => NOW });

    expect((await client.balance()).accountId).toBe('new');
  });

  it('счетов нет — ошибка словами', async () => {
    const cloud = fakeCloud({ accounts: [] });
    const client = new YandexBillingClient({ key, fetch: cloud.fetcher, now: () => NOW });

    await expect(client.balance()).rejects.toThrow(/ни одного платёжного счёта/u);
  });
});

describe('сторож баланса', () => {
  const key = parseServiceAccountKey(KEY_JSON, 'ключ');

  function stand(params: {
    readonly balance?: string;
    readonly thresholdRub?: number;
    readonly failAfter?: number;
  }) {
    let now = NOW;
    const cloud = fakeCloud({
      ...(params.balance === undefined ? {} : { balance: params.balance }),
    });
    const alerts: Alert[] = [];
    let billingCalls = 0;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (urlOf(input).includes('billing') && params.failAfter !== undefined) {
        billingCalls++;
        if (billingCalls > params.failAfter) return new Response('{}', { status: 500 });
      }
      return await cloud.fetcher(input, init);
    }) as typeof fetch;

    const watch = new YandexBalanceWatch({
      client: new YandexBillingClient({ key, fetch: fetcher, now: () => now }),
      thresholdRub: () => Promise.resolve(params.thresholdRub ?? 300),
      alert: (alert) => {
        alerts.push(alert);
        return Promise.resolve(true);
      },
      now: () => now,
    });

    return {
      watch,
      alerts,
      cloud,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    };
  }

  it('баланс кэшируется десять минут: три запроса подряд — одно обращение к облаку', async () => {
    const { watch, cloud, advance } = stand({});

    const first = await watch.status();
    await watch.status();
    advance(9 * 60_000);
    await watch.status();
    expect(cloud.calls.billing).toBe(1);

    advance(2 * 60_000);
    await watch.status();
    expect(cloud.calls.billing).toBe(2);

    expect(first).toEqual({
      ok: true,
      balanceRub: 1166.92,
      currency: 'RUB',
      accountName: 'account-788',
      thresholdRub: 300,
      low: false,
      fetchedAt: NOW.toISOString(),
      stale: false,
    });
  });

  it('облако не ответило — прежнее число остаётся с пометкой «устарело» и причиной', async () => {
    const { watch, advance } = stand({ failAfter: 1 });

    await watch.status();
    advance(11 * 60_000);
    const status = await watch.status();

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.stale).toBe(true);
    expect(status.balanceRub).toBe(1166.92);
    expect(status.fetchedAt).toBe(NOW.toISOString());
    expect(status.why).toMatch(/500/u);
  });

  it('облако не ответило ни разу — отказ словами, без чисел', async () => {
    const { watch } = stand({ failAfter: 0 });

    const status = await watch.status();

    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.why).toMatch(/500/u);
    expect(status.thresholdRub).toBe(300);
  });

  it('ниже порога — одно оповещение, повтор через сутки, после пополнения — снова при следующем падении', async () => {
    const { watch, alerts, advance } = stand({ balance: '120.5' });

    await watch.check();
    await watch.check();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.key).toBe('yandex-balance-low');
    expect(alerts[0]?.details).toEqual({ баланс: '120.50 ₽', порог: '300 ₽' });

    advance(23 * 60 * 60_000);
    await watch.check();
    expect(alerts).toHaveLength(1);

    advance(2 * 60 * 60_000);
    await watch.check();
    expect(alerts).toHaveLength(2);
  });

  it('порог ноль — сторож выключен: ни «низко», ни оповещений', async () => {
    const { watch, alerts } = stand({ balance: '0', thresholdRub: 0 });

    const status = await watch.status();
    await watch.check();

    expect(status.ok && !status.low).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  it('выше порога — тихо', async () => {
    const { watch, alerts } = stand({});

    await watch.check();

    expect(alerts).toHaveLength(0);
  });
});
