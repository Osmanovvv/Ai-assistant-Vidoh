import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  adminAccessLog,
  batches,
  items,
  itemRevisions,
  messagesRaw,
  users,
} from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../../modules/users/users.repo.js';
import { createServer } from '../server.js';
import { recentAccess, SESSION_COOKIE, type AdminAuthConfig } from './index.js';
import { hashPassword } from './password.js';
import { issuePass } from './token.js';

/**
 * Карточка человека через настоящий путь HTTP (§15, ревизия панели).
 *
 * **Проверка появилась потому, что модуль умел то, чего путь не давал.**
 * `personCard` принимает глубину списка выгрузок и отдаёт до пятидесяти
 * с ревизии четвёртого этапа, а обработчик пути его параметр не
 * передавал и `req.query` не читал вовсе: настройка была достижима
 * только из тестов модуля. Карточка навсегда обрезалась двадцатью, и
 * панель признавалась в этом словами — «более старые выгрузки из панели
 * пока не открыть». Проверка модуля такое пропустит по построению: она
 * зовёт функцию с параметром, а потерян он между путём и функцией.
 */

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';
const SESSION_SECRET = 'секрет-подписи-пропусков-для-карточки';

let passwordHash = '';
let person = '';
const running: Server[] = [];

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 30_000);

beforeEach(async () => {
  await testDb().delete(adminAccessLog);
  await testDb().delete(itemRevisions);
  await testDb().delete(items);
  await testDb().delete(messagesRaw);
  await testDb().delete(batches);
  await testDb().delete(users);

  person = (await upsertUser(testDb(), { tgId: 7_701, firstName: 'Ната' })).id;

  /** Двадцать пять выгрузок: двадцати одной уже мало, чтобы всё влезло. */
  for (let index = 0; index < 25; index += 1) {
    await testDb()
      .insert(batches)
      .values({
        userId: person,
        status: 'done',
        openedAt: new Date(Date.now() - index * 3_600_000),
        combinedText: `выгрузка ${String(index)}`,
      });
  }
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

function stand(): Promise<string> {
  return listen(
    createServer({
      healthChecks: [],
      admin: configOf(),
      adminDb: testDb(),
    }),
  );
}

/** Карточка с пропуском: без него путь отвечает отказом, и это проверено рядом. */
async function card(base: string, query: string): Promise<{ readonly dumps: readonly unknown[] }> {
  const response = await fetch(`${base}/admin/api/people/${person}${query}`, {
    headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
  });

  expect(response.status).toBe(200);

  return (await response.json()) as { readonly dumps: readonly unknown[] };
}

describe('глубина карточки приходит с запроса, а не только из тестов', () => {
  it('без просьбы — двадцать, как было всегда', async () => {
    const at = await stand();

    expect((await card(at, '')).dumps).toHaveLength(20);
  });

  it('попросили больше — карточка открывает больше', async () => {
    /**
     * **Главная проверка находки.** Она краснеет ровно от того, что было
     * не так: обработчик зовёт `personCard(db, { userId })` и число из
     * запроса выбрасывает.
     */
    const at = await stand();

    expect((await card(at, '?dumps=50')).dumps).toHaveLength(25);
  });

  it('потолок остаётся потолком, а мусор — не число', async () => {
    /**
     * Чужое число проходит через общий ограничитель: и «тысяча», и
     * «десять» не должны превращаться ни в отказ, ни в тысячу строк.
     * Свой разбор здесь означал бы второе правило для чисел из запроса.
     */
    const at = await stand();

    expect((await card(at, '?dumps=1000')).dumps).toHaveLength(25);
    expect((await card(at, '?dumps=десять')).dumps).toHaveLength(20);
    expect((await card(at, '?dumps=0')).dumps).toHaveLength(1);
  });
});

/**
 * Имя из поиска не попадает в строку запроса (§16, ревизия этапов 1–2).
 *
 * Перед ботом стоит Caddy, и он пишет `request.uri` целиком — в журнал
 * доступа на каждый запрос и в журнал ошибок на каждый отказ прокси (502,
 * пока бот перезапускается). Поиск `GET /api/people?q=<имя>` уносил имя
 * человека туда, откуда его не вычистит ни маска логгера бота, ни удаление
 * данных. Тела запроса Caddy не пишет никогда — поэтому имя едет в теле.
 *
 * Здесь проверяется половина бота: список принимает имя в теле POST и
 * ищет по нему, а GET со строкой запроса список не отдаёт. Половина
 * панели — в `caddy-log.wiring.test.ts` и в браузерной проверке
 * `tests/admin/people.spec.ts`.
 */
describe('поиск людей несёт имя в теле, а не в строке запроса', () => {
  it('POST с именем в теле находит человека, и журнал считает выданных', async () => {
    await upsertUser(testDb(), { tgId: 7_702, firstName: 'Вера' });
    const at = await stand();

    const response = await fetch(`${at}/admin/api/people`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${pass()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 20, offset: 0, q: 'Вера' }),
    });

    expect(response.status).toBe(200);

    const page = (await response.json()) as {
      readonly total: number;
      readonly rows: readonly { readonly title: string }[];
    };

    expect(page.total).toBe(1);
    expect(page.rows.map((row) => row.title)).toEqual(['Вера']);

    // Журнал §16 живёт на том же пути и считает по строкам ответа —
    // смена метода не должна была его задеть.
    const [row] = await recentAccess(testDb());

    expect(row?.route).toBe('/api/people');
    expect(row?.subjects).toBe(1);
  });

  it('GET со строкой запроса список не отдаёт', async () => {
    /**
     * Прежний путь. Оставь его рядом с новым «для совместимости» — и имя
     * снова поедет строкой запроса, стоит панели или человеку с curl
     * позвать старый. Поэтому старого пути нет вовсе, а не «есть, но
     * панель им не пользуется».
     */
    await upsertUser(testDb(), { tgId: 7_702, firstName: 'Вера' });
    const at = await stand();

    const response = await fetch(`${at}/admin/api/people?limit=20&offset=0&q=Вера`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('rows');
    expect(await recentAccess(testDb())).toEqual([]);
  });
});
