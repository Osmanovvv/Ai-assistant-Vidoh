import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { documents, documentVersions } from '../db/schema.js';
import { saveDocument } from '../modules/documents/documents.service.js';
import { testDb } from '../test/db.js';
import { dateText, documentsRouter } from './documents.js';
import { createServer } from './server.js';

/**
 * Публичные страницы документов: то, что увидит человек по ссылке из
 * бота и что проверит модерация Робокассы.
 */
const running: Server[] = [];

beforeEach(async () => {
  await testDb().delete(documentVersions);
  await testDb().delete(documents);
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
 * Условный запрос «сырым» http: `fetch` в Node 24 сам разбирает ответ
 * 304 и отдаёт 200, так что через него не видно, что ответил сервер.
 */
function conditional(url: string, etag: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request(url, { headers: { 'If-None-Match': etag } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    })
      .on('error', reject)
      .end();
  });
}

function stand(): Promise<string> {
  return listen(
    createServer({ healthChecks: [], documentsRouter: documentsRouter({ db: testDb() }) }),
  );
}

describe('страница документа', () => {
  it('отдаёт сохранённый документ: название, редакция, разметка, ссылки на остальные', async () => {
    await saveDocument(testDb(), {
      slug: 'oferta',
      html: '<h2>1. Термины</h2><p>Исполнитель — <strong>самозанятая</strong>.</p>',
      editionDate: '2026-10-01',
      by: 'nikita',
    });
    const base = await stand();

    const answer = await fetch(`${base}/docs/oferta`);
    const html = await answer.text();

    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<title>Публичная оферта — ВЫДОХ</title>');
    expect(html).toContain('Редакция от 1 октября 2026');
    expect(html).toContain('<h2>1. Термины</h2><p>Исполнитель — <strong>самозанятая</strong>.</p>');
    expect(html).toContain('href="/docs/politika"');
    // Ни скриптов, ни внешних ресурсов: странице нечего грузить.
    expect(html).not.toMatch(/<script|<link|src=/u);
  });

  it('без даты редакции строки про редакцию нет', async () => {
    await saveDocument(testDb(), {
      slug: 'politika',
      html: '<p>Текст.</p>',
      editionDate: null,
      by: 'n',
    });
    const base = await stand();

    const html = await (await fetch(`${base}/docs/politika`)).text();

    expect(html).not.toContain('Редакция от');
    expect(html).toContain('<p>Текст.</p>');
  });

  it('несохранённый документ — 404 словами, чужой адрес — тоже 404', async () => {
    const base = await stand();

    const missing = await fetch(`${base}/docs/soglasie`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('Такого документа нет');

    const alien = await fetch(`${base}/docs/admin`);
    expect(alien.status).toBe(404);
  });

  it('список показывает только опубликованное', async () => {
    await saveDocument(testDb(), {
      slug: 'oferta',
      html: '<p>а</p>',
      editionDate: '2026-10-01',
      by: 'n',
    });
    const base = await stand();

    const html = await (await fetch(`${base}/docs`)).text();

    expect(html).toContain('href="/docs/oferta"');
    expect(html).toContain('редакция от 1 октября 2026');
    expect(html).not.toContain('href="/docs/politika"');
  });

  it('после сохранения страница сразу новая: браузер обязан перепроверять, а не хранить минуту', async () => {
    await saveDocument(testDb(), {
      slug: 'oferta',
      html: '<p>первая</p>',
      editionDate: null,
      by: 'n',
    });
    const base = await stand();

    const first = await fetch(`${base}/docs/oferta`);
    const tag = first.headers.get('etag') ?? '';
    expect(first.headers.get('cache-control')).toBe('no-cache');
    expect(tag).not.toBe('');

    // Ничего не менялось — «не изменилось», тела нет.
    const same = await conditional(`${base}/docs/oferta`, tag);
    expect(same.status).toBe(304);

    await saveDocument(testDb(), {
      slug: 'oferta',
      html: '<p>вторая</p>',
      editionDate: null,
      by: 'n',
    });
    const changed = await conditional(`${base}/docs/oferta`, tag);
    expect(changed.status).toBe(200);
    expect(changed.body).toContain('<p>вторая</p>');
  });

  it('дата — по-русски, без сдвига суток', () => {
    expect(dateText('2026-10-01')).toBe('1 октября 2026 г.');
    expect(dateText('2026-12-31')).toBe('31 декабря 2026 г.');
    expect(dateText('кривая')).toBe('кривая');
  });
});
