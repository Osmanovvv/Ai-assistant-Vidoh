import { readFileSync } from 'node:fs';

import type { ModelEnv } from '../../../config/env.js';
import { CassettePlayer, CassetteRecorder, saveCassette, type CassetteFile } from './store.js';

/**
 * Сеанс записи — один на процесс (задача 3.80).
 *
 * **Один, потому что запись общая.** Ответы модели и вектора ложатся в
 * один файл, а провайдеров создают в разных местах и в разное время.
 * Два сеанса писали бы каждый своё и затирали друг друга при сохранении.
 *
 * **Файл читается синхронно, и это осознанно.** Провайдеры создаются
 * синхронной развилкой (`createLlmProvider`), переделывать её в
 * асинхронную ради воспроизведения значило бы тронуть боевой путь ради
 * тестового. Чтение случается один раз при старте, а запись в бою
 * запрещена схемой окружения — то есть в бою этого кода нет вовсе.
 *
 * **Сохранение — в конце прогона, а не на каждый ответ.** Иначе двести
 * записей файла за прогон; а терять всё при падении прогона нельзя —
 * перезапись стоит денег.
 */

interface Session {
  readonly path: string;
  readonly mode: 'record' | 'replay';
  readonly recorder?: CassetteRecorder | undefined;
  readonly player?: CassettePlayer | undefined;
}

let session: Session | undefined;

/**
 * Сеанс для текущей настройки. Второй вызов возвращает тот же.
 *
 * Ошибку чтения не глушит: воспроизведение без файла — это прогон без
 * ответов, и узнать об этом надо сразу, а не на первом промахе.
 */
export function cassetteSession(env: ModelEnv): Session {
  if (session !== undefined) return session;

  const path = env.CASSETTE_PATH;
  if (path === undefined) {
    throw new Error('AI_PROVIDER=cassette, но CASSETTE_PATH не задан');
  }

  if (env.CASSETTE_MODE === 'record') {
    session = {
      path,
      mode: 'record',
      recorder: new CassetteRecorder(new Date(), env.YANDEX_LLM_MODEL),
    };

    return session;
  }

  let file: CassetteFile;

  try {
    const raw = readFileSync(path, 'utf8');
    file = JSON.parse(raw) as CassetteFile;
  } catch (error) {
    throw new Error(
      `не удалось прочитать запись ответов модели ${path}. ` +
        'Запишите её живым прогоном: CASSETTE_MODE=record',
      { cause: error },
    );
  }

  if (!Array.isArray(file.entries) || typeof file.recordedAt !== 'string') {
    throw new Error(`файл ${path} не похож на запись ответов модели`);
  }

  session = { path, mode: 'replay', player: new CassettePlayer(file) };

  return session;
}

export interface CassetteSummary {
  readonly path: string;
  readonly mode: 'record' | 'replay';
  readonly answers: number;
  readonly vectors: number;
  /** Один запрос с двумя разными ответами: прогон недетерминирован. */
  readonly collisions: number;
  /** Запросов, которых в записи не нашлось. */
  readonly misses: number;
}

/** Сохраняет запись, если писали. Возвращает итог для журнала. */
export async function flushCassette(): Promise<CassetteSummary | undefined> {
  const active = session;
  if (active === undefined) return undefined;

  if (active.mode === 'replay') {
    return {
      path: active.path,
      mode: 'replay',
      answers: active.player?.size ?? 0,
      vectors: 0,
      collisions: 0,
      misses: active.player?.missCount ?? 0,
    };
  }

  const recorder = active.recorder;
  if (recorder === undefined) return undefined;

  await saveCassette(active.path, recorder.toFile());

  return {
    path: active.path,
    mode: 'record',
    answers: recorder.size,
    vectors: recorder.vectorCount,
    collisions: recorder.collisionCount,
    misses: 0,
  };
}

/** Только для тестов: забыть сеанс, чтобы следующий создался заново. */
export function resetCassetteSession(): void {
  session = undefined;
}
