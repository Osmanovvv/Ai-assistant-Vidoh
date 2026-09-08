import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { appSettings } from '../../db/schema.js';
import { SettingsRegistry } from '../../modules/settings/settings.repo.js';
import { testDb } from '../../test/db.js';
import { createServer } from '../server.js';
import { SESSION_COOKIE, type AdminAuthConfig } from './index.js';
import { hashPassword } from './password.js';
import { issuePass } from './token.js';

/**
 * Запись настройки через настоящий путь HTTP (§15, задачи 4.9 и ревизия 4).
 *
 * **Ревизия четвёртого этапа нашла путь записи непроверенным и без
 * единой проверки значения.** Нестроковое значение молча превращалось в
 * пустую строку, ноль принимался с «Сохранено», верхнего предела не было
 * ни у одной настройки. Ноль в суточном потолке выключает разбор **всем**
 * людям — потолок сверяется на каждом сообщении, — и увидеть это в панели
 * было нечем: строка в базе есть, значит пометки «(из кода)» не будет.
 *
 * Проверки в `admin.test.ts` до записи не доходили нарочно: там база
 * `NEVER_TOUCHED`, и оба обращения упираются в 400 и 413.
 */

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';
const SESSION_SECRET = 'секрет-подписи-пропусков-для-настроек';

let passwordHash = '';
const running: Server[] = [];

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 30_000);

beforeEach(async () => {
  await testDb().delete(appSettings);
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

/**
 * Стенд с **боевым** сроком кэша, а не с нулевым.
 *
 * Ревизия: браузерный стенд собран с `ttlMs: 0`, и при нулевом сроке кэш
 * мёртв по построению — `forget()` поведения не меняет. Значит снятие
 * сброса кэша на маршруте не покраснело бы ни в одной проверке, хотя без
 * него правка доезжает до людей минутой позже, а панель уже сказала
 * «Сохранено». Здесь срок настоящий, и сброс проверяется по-настоящему.
 */
function stand(): { readonly base: Promise<string>; readonly settings: SettingsRegistry } {
  const settings = new SettingsRegistry({ db: testDb(), ttlMs: 60_000 });

  return {
    base: listen(
      createServer({
        healthChecks: [],
        admin: configOf(),
        adminDb: testDb(),
        adminSettings: settings,
      }),
    ),
    settings,
  };
}

async function write(base: string, body: unknown): Promise<Response> {
  return await fetch(`${base}/admin/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${pass()}` },
    body: JSON.stringify(body),
  });
}

describe('запись настройки проверяется до базы', () => {
  it('годное значение записывается и сразу читается через реестр', async () => {
    /**
     * **Главная проверка задачи 4.9** — и она же ловит потерю сброса
     * кэша: срок здесь боевой, минута, и без `forget()` реестр отдал бы
     * прежнее значение.
     */
    const { base, settings } = stand();
    const at = await base;

    // Прогреваем кэш — иначе проверять сброс было бы нечего.
    expect(await settings.number('dumpsPerDay')).toBe(30);

    const response = await write(at, { name: 'dumpsPerDay', value: '7' });

    expect(response.status).toBe(200);
    expect(await settings.number('dumpsPerDay')).toBe(7);
  });

  it('ноль в суточном потолке отвергается: он выключил бы разбор всем', async () => {
    const { base } = stand();
    const at = await base;

    const response = await write(at, { name: 'dumpsPerDay', value: '0' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('допустимо от 1');

    // И в базе ничего не появилось: отказ, а не отказ на словах.
    expect(await testDb().select().from(appSettings)).toEqual([]);
  });

  it('значение выше предела отвергается', async () => {
    const { base } = stand();
    const at = await base;

    const response = await write(at, { name: 'silenceWindowMs', value: '99999999' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('до 600000');
  });

  it('мусор отвергается, а не превращается в пустую строку', async () => {
    const { base } = stand();
    const at = await base;

    // Пробелы по краям **не** мусор: их снимает и чтение, и запись —
    // одно правило на обоих концах. Мусор — это всё остальное.
    for (const value of ['', ' ', '1e3', '10.5', '-1', 'десять', '0x10', '7,5']) {
      const response = await write(at, { name: 'trialDumps', value });

      expect(response.status, `значение «${value}»`).toBe(400);
    }

    expect(await testDb().select().from(appSettings)).toEqual([]);
  });

  it('нестроковое значение отвергается, а не читается как пустая строка', async () => {
    const { base } = stand();
    const at = await base;

    const response = await write(at, { name: 'trialDumps', value: 7 });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('строкой из цифр');
  });

  it('ноль в пробном периоде проходит: «пробного периода нет» — законно', async () => {
    const { base, settings } = stand();
    const at = await base;

    expect((await write(at, { name: 'trialDumps', value: '0' })).status).toBe(200);
    expect(await settings.number('trialDumps')).toBe(0);
  });

  it('панель говорит, каких настроек ещё никто не читает', async () => {
    /**
     * Прежде здесь стоял литерал `missing: []` — панель утверждала
     * фактом, что таких настроек нет. Их было четыре.
     */
    const { base } = stand();
    const at = await base;

    const response = await fetch(`${at}/admin/api/settings`, {
      headers: { cookie: `${SESSION_COOKIE}=${pass()}` },
    });

    const view = (await response.json()) as { readonly missing: readonly string[] };

    // Сегодня читатель есть у всех — и это утверждение считается, а не
    // зашито: появится настройка без читателя, и она попадёт в список.
    expect(view.missing).toEqual([]);
  });
});
