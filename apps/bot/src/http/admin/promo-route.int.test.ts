import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { promoCodes } from '../../db/schema.js';
import { SettingsRegistry } from '../../modules/settings/settings.repo.js';
import { testDb } from '../../test/db.js';
import { createServer } from '../server.js';
import { SESSION_COOKIE, type AdminAuthConfig } from './index.js';
import { hashPassword } from './password.js';
import { issuePass } from './token.js';

/**
 * Заведение промокода через настоящий путь HTTP (§14, задача 4.4).
 *
 * **Ревизия панели, находка 10.** Числа кода не проверялись, а
 * зажимались: `boundedNumber` превращал «0 раз» в квоту 1, а цену сверх
 * миллиона рублей — в миллион. Ответ был 200, в таблице стояло другое
 * число, чем ввёл человек, и ни одного слова о подмене. Поправить
 * заведённый код нельзя, значит неверная квота лечится только новым
 * кодом и просьбой к блогеру переписать пост.
 *
 * **И находка 3:** срок действия бот соблюдает, а панель его не посылала.
 * Здесь проверяется серверная половина пути — что присланный срок доходит
 * до базы, а неразобранная дата отвергается словами, а не превращается
 * молча в «бессрочно».
 */

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';
const SESSION_SECRET = 'секрет-подписи-пропусков-для-промокодов';

let passwordHash = '';
const running: Server[] = [];

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 30_000);

beforeEach(async () => {
  await testDb().delete(promoCodes);
});

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

function pass(): string {
  return issuePass({ secret: SESSION_SECRET, kind: 'session', login: LOGIN });
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

async function stand(): Promise<string> {
  return await listen(
    createServer({
      healthChecks: [],
      admin: configOf(),
      adminDb: testDb(),
      adminSettings: new SettingsRegistry({ db: testDb(), ttlMs: 60_000 }),
    }),
  );
}

/** Годное тело: цены обязательны, остальное по случаю. */
function newCode(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: 'BLOGGER7', plan: 'monthly', priceRubMinor: 9_900, priceStars: 40, ...extra };
}

async function save(base: string, body: unknown): Promise<Response> {
  return await fetch(`${base}/admin/api/promo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${pass()}` },
    body: JSON.stringify(body),
  });
}

async function refusalOf(response: Response): Promise<string> {
  return ((await response.json()) as { readonly error?: string }).error ?? '';
}

async function row(code = 'BLOGGER7'): Promise<typeof promoCodes.$inferSelect | undefined> {
  const [found] = await testDb().select().from(promoCodes).where(eq(promoCodes.code, code));

  return found;
}

describe('числа промокода отвергаются, а не приводятся к пределам', () => {
  it('годный код заводится целиком: цены, квота, примечание', async () => {
    const at = await stand();

    const response = await save(at, newCode({ maxRedemptions: 50, note: 'Марина' }));

    expect(response.status).toBe(200);

    const saved = await row();

    expect(saved?.priceRubMinor).toBe(9_900);
    expect(saved?.priceStars).toBe(40);
    expect(saved?.maxRedemptions).toBe(50);
    expect(saved?.note).toBe('Марина');
  });

  it('«0 раз» — отказ со словами, а не тихая квота 1', async () => {
    /**
     * Главная проверка находки 10. Прежде ответ был 200, а в базе стояла
     * единица: код блогера с тысячей подписчиков умирал после первой
     * оплаты, и увидеть подмену было нечем.
     */
    const at = await stand();

    const response = await save(at, newCode({ maxRedemptions: 0 }));

    expect(response.status).toBe(400);
    expect(await refusalOf(response)).toContain('допустимо от 1');

    // И кода в базе нет: отказ, а не отказ на словах.
    expect(await row()).toBeUndefined();
  });

  it('квоту снимает только пустое поле — тогда её нет вовсе', async () => {
    // Единственный способ сказать «без ограничения» — не посылать поля.
    const at = await stand();

    expect((await save(at, newCode())).status).toBe(200);
    expect((await row())?.maxRedemptions).toBeNull();
  });

  it('цена сверх предела отвергается, а не становится пределом', async () => {
    // Прежде 200 000 000 копеек молча превращались в 100 000 000 — два
    // миллиона рублей в тарифе за миллион.
    const at = await stand();

    const response = await save(at, newCode({ priceRubMinor: 200_000_000 }));

    expect(response.status).toBe(400);
    expect(await refusalOf(response)).toContain('до 100000000');
    expect(await row()).toBeUndefined();
  });

  it('звёзды сверх предела отвергаются тоже', async () => {
    const at = await stand();

    const response = await save(at, newCode({ priceStars: 9_000_000 }));

    expect(response.status).toBe(400);
    expect(await refusalOf(response)).toContain('до 1000000');
  });

  it('нечисло в цене — отказ, а не нуль', async () => {
    /**
     * Прежде «дорого» доходило нулём и отвергалось как «цена должна быть
     * больше нуля»: причина названа, но не та, и заказчица правила бы не
     * то поле.
     */
    const at = await stand();

    for (const bad of ['дорого', '9 900', '99.00', true, {}, [1]]) {
      const response = await save(at, newCode({ priceRubMinor: bad }));

      expect(response.status, `цена «${JSON.stringify(bad)}»`).toBe(400);
      expect(await refusalOf(response)).toContain('целое число');
    }

    expect(await row()).toBeUndefined();
  });

  it('нулевая цена остаётся за службой: правило про деньги живёт там, где деньги', async () => {
    // Ноль — законное число, но не цена: счёт на нуль выставить нельзя ни
    // на одном рельсе. Слова те же, что видит человек в панели.
    const at = await stand();

    const response = await save(at, newCode({ priceRubMinor: 0 }));

    expect(response.status).toBe(400);
    expect(await refusalOf(response)).toContain('больше нуля');
  });
});

describe('срок действия кода доходит до базы', () => {
  it('присланный срок сохраняется как есть', async () => {
    /**
     * Находка 3: срок бот соблюдает, а панель его не посылала — форма
     * поля не имела. Серверная половина пути обязана быть проверенной до
     * того, как поле появится.
     */
    const at = await stand();
    const until = '2026-09-30T20:59:59.999Z';

    expect((await save(at, newCode({ validUntil: until }))).status).toBe(200);
    expect((await row())?.validUntil?.toISOString()).toBe(until);
  });

  it('нет поля — нет срока: код бессрочный', async () => {
    const at = await stand();

    expect((await save(at, newCode())).status).toBe(200);
    expect((await row())?.validUntil).toBeNull();
  });

  it('неразобранная дата — отказ, а не молчаливое «бессрочно»', async () => {
    /**
     * Прежде такая строка превращалась в код без срока. Пока поля в форме
     * не было, случай был недостижим; с полем «завела до конца сентября»
     * молча означало бы «навсегда», и заметить это можно было бы только
     * по выручке через месяц.
     */
    const at = await stand();

    const response = await save(at, newCode({ validUntil: '30 сентября' }));

    expect(response.status).toBe(400);
    expect(await refusalOf(response)).toContain('не разобрали дату');
    expect(await row()).toBeUndefined();
  });
});
