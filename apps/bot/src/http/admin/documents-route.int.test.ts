import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { adminAccessLog, documents, documentVersions } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { documentsRouter } from '../documents.js';
import { createServer } from '../server.js';
import { SESSION_COOKIE, type AdminAuthConfig } from './index.js';
import { hashPassword } from './password.js';
import { issuePass } from './token.js';

/**
 * Раздел «Документы» панели: список, документ с историей, сохранение,
 * возврат версии. Через настоящие обработчики и настоящую базу; отказ
 * без пропуска — как у всех закрытых путей (общая проверка в admin.test).
 */
const LOGIN = 'оля';
const PASSWORD = 'очень-длинный-пароль-42';
const SESSION_SECRET = 'секрет-подписи-пропусков-для-документов';

let passwordHash = '';
const running: Server[] = [];

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
}, 30_000);

beforeEach(async () => {
  await testDb().delete(documentVersions);
  await testDb().delete(documents);
  await testDb().delete(adminAccessLog);
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
      documentsRouter: documentsRouter({ db: testDb() }),
    }),
  );
}

const cookie = () => ({ cookie: `${SESSION_COOKIE}=${pass()}` });

async function get(base: string, path: string): Promise<{ status: number; body: unknown }> {
  const answer = await fetch(`${base}${path}`, { headers: cookie() });
  return { status: answer.status, body: await answer.json() };
}

async function save(
  base: string,
  slug: string,
  body: unknown,
): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
  const answer = await fetch(`${base}/admin/api/documents/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookie() },
    body: JSON.stringify(body),
  });
  return { status: answer.status, body: (await answer.json()) as { ok?: boolean; error?: string } };
}

interface Summary {
  slug: string;
  title: string;
  editionDate: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  publicPath: string;
}

interface Detail extends Summary {
  html: string;
  versions: { id: string; savedAt: string; savedBy: string | null; editionDate: string | null }[];
}

describe('документы в панели', () => {
  it('список — все четыре, с адресом страницы; не сохранённые — без даты', async () => {
    const base = await stand();

    const { status, body: raw } = await get(base, '/admin/api/documents');
    const body = raw as { rows: Summary[] };

    expect(status).toBe(200);
    expect(body.rows.map((one) => one.slug)).toEqual([
      'oferta',
      'politika',
      'soglashenie',
      'soglasie',
    ]);
    expect(body.rows[0]?.publicPath).toBe('/docs/oferta');
    expect(body.rows.every((one) => one.updatedAt === null)).toBe(true);
  });

  it('сохранение публикует: страница отдаёт новый текст, история растёт с логином', async () => {
    const base = await stand();

    const saved = await save(base, 'oferta', {
      html: '<h2>1. Общее</h2><p>Текст оферты.</p><script>x()</script>',
      editionDate: '2026-10-01',
    });
    expect(saved).toEqual({ status: 200, body: { ok: true } });

    const body = (await get(base, '/admin/api/documents/oferta')).body as Detail;
    expect(body.title).toBe('Публичная оферта');
    expect(body.html).toBe('<h2>1. Общее</h2><p>Текст оферты.</p>');
    expect(body.editionDate).toBe('2026-10-01');
    expect(body.updatedBy).toBe(LOGIN);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]?.savedBy).toBe(LOGIN);

    // Опубликовано тут же — без выкладки.
    const page = await (await fetch(`${base}/docs/oferta`)).text();
    expect(page).toContain('<p>Текст оферты.</p>');

    // Кто правил — в самой истории версий (журнал доступа §16 ведёт
    // только чтение данных людей; документ — не данные человека).
    const log = await testDb().select().from(adminAccessLog);
    expect(log.filter((row) => row.route.includes('/api/documents'))).toEqual([]);
  });

  it('прежнюю версию можно прочесть и вернуть, сохранив её заново', async () => {
    const base = await stand();
    await save(base, 'politika', { html: '<p>первая</p>', editionDate: null });
    await save(base, 'politika', { html: '<p>вторая</p>', editionDate: null });

    const body = (await get(base, '/admin/api/documents/politika')).body as Detail;
    const old = body.versions[1]!;
    const version = (await get(base, `/admin/api/documents/politika/versions/${old.id}`)) as {
      status: number;
      body: { html: string };
    };
    expect(version).toEqual({ status: 200, body: { html: '<p>первая</p>' } });

    await save(base, 'politika', { html: version.body.html, editionDate: null });

    const after = { body: (await get(base, '/admin/api/documents/politika')).body as Detail };
    expect(after.body.html).toBe('<p>первая</p>');
    expect(after.body.versions).toHaveLength(3);
  });

  it('отказы — словами: пустой документ, кривая дата, чужой адрес, чужая версия', async () => {
    const base = await stand();

    expect(
      (await save(base, 'oferta', { html: '<p></p>', editionDate: null })).body.error,
    ).toContain('пуст');
    expect(
      (await save(base, 'oferta', { html: '<p>ок</p>', editionDate: '01.10.2026' })).body.error,
    ).toContain('дата');
    expect((await save(base, 'chuzhoy', { html: '<p>ок</p>', editionDate: null })).status).toBe(
      404,
    );
    expect((await get(base, '/admin/api/documents/oferta/versions/не-uuid')).status).toBe(404);
    expect((await get(base, '/admin/api/documents/chuzhoy')).status).toBe(404);
  });

  it('длинный документ проходит: у документов свой предел тела, а не 128 килобайт панели', async () => {
    const base = await stand();
    const long = `<p>${'Пункт оферты. '.repeat(20_000)}</p>`; // ~300 КБ

    const saved = await save(base, 'oferta', { html: long, editionDate: null });

    expect(saved.status).toBe(200);
  });
});
