import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { broadcastDeliveries, broadcasts, users } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import {
  createBroadcast,
  requestStop,
  startBroadcast,
  TELEGRAM_MESSAGE_LIMIT,
} from '../../modules/broadcast/broadcast.repo.js';
import { SettingsRegistry } from '../../modules/settings/settings.repo.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { createServer } from '../server.js';
import { SESSION_COOKIE, type AdminAuthConfig } from './index.js';
import { hashPassword } from './password.js';
import { issuePass } from './token.js';

/**
 * Пути рассылки — уровень HTTP (§15, задача 4.10; ревизия панели).
 *
 * **Логика рассылки покрыта плотно, экран проверен браузером, а слой
 * между ними не проверялся ничем.** `broadcast.int.test.ts` зовёт
 * репозиторий и службу напрямую; браузерные проверки не знают ни одного
 * отказа сервера; сплошной обход в `admin.test.ts` убеждается лишь, что
 * без пропуска каждый путь отвечает 401. Значит ветки «нет такого
 * сегмента», «нужны text и segment», «слишком длинно», двойной старт,
 * продолжение незостановленной и повтор незаконченной не проверял никто
 * — и находка про **отброшенную причину отказа** могла жить
 * незамеченной: сервер её называет, панель выбрасывала, и покраснеть от
 * этого было нечему.
 *
 * Поэтому проверяется не только код ответа, но и то, что причина едет в
 * теле: панель показывает человеку именно её («слишком длинно: 4200
 * знаков» он исправит, «не удалось составить рассылку» — нет).
 *
 * Ни одного настоящего письма здесь не уходит: очередь — заглушка,
 * запомнившая идентификаторы, отправителя нет вовсе.
 */

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';
const SESSION_SECRET = 'секрет-подписи-пропусков-для-рассылки';

let passwordHash = '';

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 30_000);

const running: Server[] = [];

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

/** Готовый пропуск: сам вход проверен своими проверками. */
function pass(): string {
  return issuePass({ secret: SESSION_SECRET, kind: 'session', login: LOGIN });
}

/** Что попало в очередь. Настоящего воркера здесь нет и быть не должно. */
let queued: string[] = [];

async function panel(): Promise<string> {
  return await listen(
    createServer({
      healthChecks: [],
      admin: configOf(),
      adminDb: testDb(),
      adminSettings: new SettingsRegistry({ db: testDb(), ttlMs: 0 }),
      adminEnqueueBroadcast: async (broadcastId: string) => {
        queued.push(broadcastId);
        await Promise.resolve();
      },
    }),
  );
}

async function ask(
  base: string,
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${base}/admin${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      cookie: `${SESSION_COOKIE}=${pass()}`,
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeEach(async () => {
  queued = [];
  await testDb().delete(broadcastDeliveries);
  await testDb().delete(broadcasts);
  await testDb().delete(users);
});

describe('отказы путей рассылки доходят до панели названными', () => {
  it('текст длиннее предела Telegram — 400, и число знаков в теле', async () => {
    /**
     * Причина поправимая, и человек правит по ней поле: «слишком длинно:
     * 4097 знаков, Telegram принимает 4096». Склей её в «не удалось
     * составить рассылку» — и он будет искать причину в коде.
     */
    const base = await panel();
    const tooLong = 'я'.repeat(TELEGRAM_MESSAGE_LIMIT + 1);

    const answer = await ask(base, '/api/broadcast', {
      method: 'POST',
      body: { text: tooLong, segment: 'all' },
    });

    expect(answer.status).toBe(400);
    expect(String(answer.body['error'])).toContain(String(TELEGRAM_MESSAGE_LIMIT + 1));
    expect(String(answer.body['error'])).toContain(String(TELEGRAM_MESSAGE_LIMIT));

    // И черновика не осталось: отказ не заводит рассылку.
    expect(await testDb().select().from(broadcasts)).toEqual([]);
  });

  it('без текста и сегмента — 400 со сказанным, чего не хватает', async () => {
    const base = await panel();

    const answer = await ask(base, '/api/broadcast', { method: 'POST', body: {} });

    expect(answer.status).toBe(400);
    expect(answer.body['error']).toBe('нужны text и segment');
  });

  it('незнакомый сегмент в предпросмотре — 400, а не пустое число', async () => {
    /**
     * Ноль получателей и «нет такого сегмента» — разные ответы. Первый
     * человек прочтёт как «писать некому» и закроет раздел.
     */
    const base = await panel();

    const answer = await ask(base, '/api/broadcast/preview?segment=кому-нибудь');

    expect(answer.status).toBe(400);
    expect(answer.body['error']).toBe('нет такого сегмента');
  });

  it('второе подтверждение — 409, и в очередь ничего не уходит вторично', async () => {
    /**
     * Две нажатые кнопки не должны дать двух воркеров на одной
     * рассылке: это второе письмо каждому, кого первый воркер ещё не
     * успел отметить.
     */
    await upsertUser(testDb(), { tgId: 4_101, firstName: 'Аня' });

    const base = await panel();
    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: LOGIN,
      trialLimit: 10,
    });

    const first = await ask(base, `/api/broadcast/${made.id}/start`, { method: 'POST' });
    const second = await ask(base, `/api/broadcast/${made.id}/start`, { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(String(second.body['error'])).toContain('уже запущена');
    expect(queued).toEqual([made.id]);
  });

  it('повтор у остановленной — 409 с причиной, названной сервером', async () => {
    /**
     * Самая дорогая ветка: повтор у остановленной рассылки досылал бы
     * **всех** оставшихся, а человек просил остановиться. Отказ есть в
     * репозитории; здесь проверяется, что его причина доезжает до панели
     * — иначе человек читает «Не удалось повторить» и идёт искать
     * поломку.
     */
    await upsertUser(testDb(), { tgId: 4_102, firstName: 'Оля' });

    const base = await panel();
    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: LOGIN,
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);
    await requestStop(testDb(), made.id);

    const answer = await ask(base, `/api/broadcast/${made.id}/retry`, { method: 'POST' });

    expect(answer.status).toBe(409);
    expect(answer.body['error']).toBe('повторять можно только законченную рассылку');
    expect(queued).toEqual([]);
  });

  it('продолжение неостановленной — 409 с причиной', async () => {
    await upsertUser(testDb(), { tgId: 4_103, firstName: 'Вера' });

    const base = await panel();
    const made = await createBroadcast(testDb(), {
      text: 'Привет.',
      segment: 'all',
      by: LOGIN,
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const answer = await ask(base, `/api/broadcast/${made.id}/resume`, { method: 'POST' });

    expect(answer.status).toBe(409);
    expect(answer.body['error']).toBe('рассылка не остановлена');
    expect(queued).toEqual([]);
  });

  it('отмена не черновика — 409, а не 404: письмо не потерялось', async () => {
    await upsertUser(testDb(), { tgId: 4_104, firstName: 'Галя' });

    const base = await panel();
    const made = await createBroadcast(testDb(), {
      text: 'Уже пошла.',
      segment: 'all',
      by: LOGIN,
      trialLimit: 10,
    });

    await startBroadcast(testDb(), made.id);

    const answer = await ask(base, `/api/broadcast/${made.id}/cancel`, { method: 'POST' });

    expect(answer.status).toBe(409);
    expect(String(answer.body['error'])).toContain('только черновик');
  });
});

describe('список рассылок говорит, что показано не всё', () => {
  it('отдаёт последние двадцать и общее число рядом', async () => {
    /**
     * Двадцать строк без итога читаются как полный список: после
     * двадцать первой рассылки предыдущие исчезают молча — вместе с
     * единственным путём к «Повторить неудачные». Число обязано приехать
     * из того же ответа, по которому панель рисует список, а не считаться
     * в браузере по длине списка.
     */
    for (let index = 0; index < 21; index++) {
      await createBroadcast(testDb(), {
        text: `Письмо ${String(index)}.`,
        segment: 'all',
        by: LOGIN,
        trialLimit: 10,
      });
    }

    const base = await panel();
    const answer = await ask(base, '/api/broadcast');

    expect(answer.status).toBe(200);
    expect((answer.body['rows'] as readonly unknown[]).length).toBe(20);
    expect(answer.body['total']).toBe(21);
  });
});
