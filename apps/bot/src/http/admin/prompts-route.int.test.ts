import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { promptVersions, type AiStage } from '../../db/schema.js';
import { CLASSIFIER_SCHEMA_NAME } from '../../modules/ai/schemas/index.js';
import { seedPrompt } from '../../modules/ai/prompts/seed.js';
import { testDb } from '../../test/db.js';
import { createServer } from '../server.js';
import { SESSION_COOKIE, type AdminAuthConfig } from './index.js';
import { hashPassword } from './password.js';
import { issuePass } from './token.js';

/**
 * Включение версии промпта через настоящий путь HTTP (§15, задача 4.8).
 *
 * **Ревизия четвёртого этапа нашла здесь непроверенную строку.** После
 * успешного включения роутер сбрасывает кэш реестра промптов
 * (`promptRegistry.forget`) — без этого правка доезжает до людей минутой
 * позже, а панель уже сказала «включено». Строку не покрывала ни одна
 * проверка: стенд собирал сервер без реестра, страж полноты сборки его
 * не знал, а модульные проверки включения ходят мимо роутера.
 */

const LOGIN = 'аня';
const PASSWORD = 'очень-длинный-пароль-42';
const SESSION_SECRET = 'секрет-подписи-пропусков-для-промптов';

let passwordHash = '';
let evalDir = '';

const running: Server[] = [];
const forgotten: (AiStage | undefined)[] = [];

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
  evalDir = await mkdtemp(join(tmpdir(), 'vydoh-prompts-route-'));
}, 30_000);

afterAll(async () => {
  await rm(evalDir, { recursive: true, force: true });
});

beforeEach(async () => {
  forgotten.length = 0;
  await testDb().delete(promptVersions);
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
      adminEvalDir: evalDir,
      // Реестр промптов — как в бою. Именно его забывали и здесь, и на
      // браузерном стенде.
      adminPromptRegistry: {
        forget: (stage?: AiStage) => {
          forgotten.push(stage);
        },
      },
    }),
  );
}

async function activate(base: string, body: unknown): Promise<Response> {
  return await fetch(`${base}/admin/api/prompts/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${pass()}` },
    body: JSON.stringify(body),
  });
}

describe('включение версии сбрасывает кэш реестра', () => {
  it('после успешного включения кэш сброшен именно по этому этапу', async () => {
    await seedPrompt(testDb(), {
      stage: 'classifier',
      version: 'classifier@9',
      prompt: 'Текст.',
      schemaName: CLASSIFIER_SCHEMA_NAME,
    });

    const base = await stand();

    // Прогона набора нет — включаем с признанием: заслон §10.3 проверен
    // своими проверками, здесь меряется другое.
    const response = await activate(base, {
      stage: 'classifier',
      version: 'classifier@9',
      acknowledged: true,
    });

    expect(response.status).toBe(200);
    expect(forgotten).toEqual(['classifier']);

    // И версия действительно активна: сброс кэша без включения был бы
    // сбросом впустую.
    const [row] = await testDb()
      .select({ isActive: promptVersions.isActive })
      .from(promptVersions)
      .where(eq(promptVersions.version, 'classifier@9'));

    expect(row?.isActive).toBe(true);
  });

  it('отказ заслона кэш не сбрасывает: включать нечего', async () => {
    await seedPrompt(testDb(), {
      stage: 'classifier',
      version: 'classifier@9',
      prompt: 'Текст.',
      schemaName: CLASSIFIER_SCHEMA_NAME,
    });

    const base = await stand();

    const response = await activate(base, { stage: 'classifier', version: 'classifier@9' });

    expect(response.status).toBe(409);
    expect(forgotten).toEqual([]);
  });
});
