import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { modelEnvSchema } from '../../../config/env.js';
import { createLlmProvider } from '../providers/factory.js';
import type { CompletionRequest, LlmProvider } from '../providers/types.js';
import { RecordingLlmProvider } from './provider.js';
import { resetCassetteSession } from './session.js';
import { CassetteRecorder } from './store.js';

/**
 * Связка «запись — контрольный набор» (находка 10.09.2026).
 *
 * Прогон набора платный, а вопросов к нему сейчас два, и на каждый нужно
 * сравнение «до» и «после». Запись ответов делает это одним платным
 * прогоном вместо четырёх — но только если она **дотянута до прогона
 * набора**, а не просто существует в проекте.
 *
 * До сегодняшнего дня не была: `flushCassette` звали бот и сквозной
 * прогон, а `run-eval.ts` — нет. Значит прогон набора с
 * `CASSETTE_MODE=record` списал бы деньги и **не сохранил ничего**:
 * запись копится в памяти и ложится на диск один раз в конце. Ровно тот
 * случай, о котором проект уже писал: «написано, покрыто тестами и
 * недостижимо».
 *
 * Здесь стерегутся оба конца связки: разворот дат по дню записи (иначе
 * набор мерил бы уехавшие сроки) и сам вызов сохранения в скрипте.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

afterEach(() => {
  vi.useRealTimers();
  resetCassetteSession();
});

/** Случай набора: «сегодня» у него 26 августа 2026 и не двигается. */
const REQUEST: CompletionRequest = {
  prompt: 'Сегодня среда, 26 августа 2026 г., часовой пояс Europe/Moscow.',
  input: 'Каждый вторник вожу сына на плавание.',
  jsonSchema: { title: 'classifier', type: 'object' },
};

/** Ответ модели: ближайший вторник от 26 августа — первое сентября. */
const ANSWER = '{"deadline":"2026-09-01"}';

const RECORDED = new Date('2026-09-10T12:00:00.000Z');
/** Трое суток спустя: столько живёт разбор находок между прогонами. */
const LATER = new Date('2026-09-13T12:00:00.000Z');

/** Настоящая запись на диске: записана живым путём, а не собрана руками. */
async function cassetteOnDisk(): Promise<string> {
  const live: LlmProvider = {
    name: 'yandex:yandexgpt/latest',
    complete: () =>
      Promise.resolve({
        text: ANSWER,
        model: 'yandex:yandexgpt/latest',
        tokensIn: 9,
        tokensOut: 9,
      }),
  };

  const recorder = new CassetteRecorder(RECORDED, 'yandex:yandexgpt/latest');
  await new RecordingLlmProvider({ live, recorder, recordedAt: RECORDED }).complete(REQUEST);

  const path = join(await mkdtemp(join(tmpdir(), 'vydoh-cassette-')), 'eval.json');
  await writeFile(path, JSON.stringify(recorder.toFile()), 'utf8');

  return path;
}

describe('провайдер записи для набора', () => {
  it('по дню записи ответ возвращается буква в букву и через трое суток', async () => {
    const path = await cassetteOnDisk();
    const env = modelEnvSchema.parse({ AI_PROVIDER: 'cassette', CASSETTE_PATH: path });

    vi.useFakeTimers();
    vi.setSystemTime(LATER);

    const provider = createLlmProvider(env, { clock: 'recorded' });

    expect((await provider.complete(REQUEST)).text).toBe(ANSWER);
  });

  it('без этого выбора записанный срок уезжает — и набор мерил бы не то', async () => {
    // Та самая опасность, названная прямо: ожидание набора остаётся
    // первым сентября, а разбор получает четвёртое.
    const path = await cassetteOnDisk();
    const env = modelEnvSchema.parse({ AI_PROVIDER: 'cassette', CASSETTE_PATH: path });

    vi.useFakeTimers();
    vi.setSystemTime(LATER);

    const provider = createLlmProvider(env);

    expect((await provider.complete(REQUEST)).text).toContain('2026-09-04');
  });

  it('запись живого остаётся записью живого', async () => {
    const path = await cassetteOnDisk();
    const env = modelEnvSchema.parse({
      AI_PROVIDER: 'cassette',
      CASSETTE_MODE: 'record',
      CASSETTE_PATH: path,
      YANDEX_API_KEY: 'ключ',
      YANDEX_FOLDER_ID: 'каталог',
    });

    expect(createLlmProvider(env, { clock: 'recorded' })).toBeInstanceOf(RecordingLlmProvider);
  });
});

/**
 * Код скрипта без комментариев.
 *
 * **Без этого страж зеленел на сломанном дереве, и это здесь случилось.**
 * Первая версия искала `clock: 'recorded'` во всём тексте, а рядом стоит
 * докстринг, объясняющий этот самый флаг словами и с обратными кавычками.
 * Диверсия — снять флаг с обоих вызовов — прошла незамеченной: страж
 * читал объяснение вместо кода. Проверять диверсией надо каждого стража,
 * и именно потому, что такие промахи выглядят как работающая проверка.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

describe('прогон набора дотянут до записи', () => {
  it('скрипт сохраняет запись на диск', async () => {
    /**
     * Без этого вызова прогон с `CASSETTE_MODE=record` спросил бы живую
     * модель, заплатил и не сохранил ни строки: копилка живёт в памяти.
     */
    const script = code(await readFile(resolve(root, 'src/scripts/run-eval.ts'), 'utf8'));

    expect(script, 'прогон набора не сохраняет запись ответов').toMatch(/await flushCassette\(\)/u);
  });

  it('каждый провайдер прогона разворачивает даты по дню записи', async () => {
    /**
     * У набора «сегодня» задано в самом случае и не двигается. Разверни
     * ответ по сегодняшнему дню — и записанный срок уедет, а прогон
     * покажет промах по дате, которого не было.
     *
     * Проверяются **все** вызовы, а не наличие строки где-нибудь: полная
     * модель и лёгкая создаются порознь, и забыть флаг у одной из них —
     * самый вероятный способ сломать замер наполовину.
     */
    const script = code(await readFile(resolve(root, 'src/scripts/run-eval.ts'), 'utf8'));
    const calls = [...script.matchAll(/createLlmProvider\(([^)]*)\)/gu)].map((one) => one[1] ?? '');

    expect(calls.length, 'вызовов провайдера в прогоне не нашлось вовсе').toBeGreaterThan(0);

    expect(
      calls.filter((args) => !args.includes("clock: 'recorded'")),
      'у этих вызовов даты записи развернутся по сегодняшнему дню',
    ).toEqual([]);
  });
});
