import { asc } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, promptVersions } from '../../db/schema.js';
import { SpendCeilingError, TransientError } from '../../infra/failures.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { requestStructured } from './client.js';
import { PromptRegistry } from './prompts/registry.js';
import { activatePrompt, seedPrompt } from './prompts/seed.js';
import { MockLlmProvider } from './providers/mock.js';
import { PermanentLlmError, TransientLlmError } from './providers/types.js';
import { EXTRACTOR_SCHEMA_NAME, type ExtractedUnits } from './schemas/index.js';

/**
 * Обращение к модели со строгой схемой, на живой базе.
 *
 * Проверяется поведение, от которого зависит, потеряется ли текст
 * человека: недоступность модели, ответ не по схеме, учёт расхода.
 * Провайдер подменён — живой вызов недетерминирован и стоит денег.
 */

const logger = createLogger({ level: 'silent' });

const PROMPT = 'Разбери поток мыслей на отдельные дела.';
const INPUT = 'надо записаться к врачу и купить продукты';

const VALID = JSON.stringify({
  units: [
    { text: 'записаться к врачу', isProject: false, isEmotion: false },
    { text: 'купить продукты', isProject: false, isEmotion: false },
  ],
});

async function prepare(): Promise<PromptRegistry> {
  await seedPrompt(testDb(), {
    stage: 'extractor',
    version: 'extractor@1',
    prompt: PROMPT,
    schemaName: EXTRACTOR_SCHEMA_NAME,
  });
  await activatePrompt(testDb(), 'extractor', 'extractor@1');

  return new PromptRegistry(testDb(), 60_000);
}

function deps(provider: MockLlmProvider, prompts: PromptRegistry) {
  return {
    db: testDb(),
    provider,
    prompts,
    logger,
    // Паузы в тестах не нужны: проверяется логика, а не терпение.
    retry: { attempts: 2, sleep: () => Promise.resolve() },
  };
}

beforeEach(async () => {
  await testDb().delete(promptVersions);
  await testDb().delete(aiCalls);
});

describe('успешный разбор', () => {
  it('возвращает разобранное значение и версию промпта', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [VALID] });

    const outcome = await requestStructured<ExtractedUnits>(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.units).toHaveLength(2);
    expect(outcome.value.units[0]?.text).toBe('записаться к врачу');
    expect(outcome.promptVersion).toBe('extractor@1');
    expect(outcome.attempts).toBe(1);
  });

  it('отправляет модели активный промпт и схему из него же', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [VALID] });

    await requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT });

    const sent = provider.requests[0];
    expect(sent?.prompt).toBe(PROMPT);
    expect(sent?.input).toBe(INPUT);
    expect(sent?.jsonSchema).toMatchObject({ type: 'object' });
    // Этап доезжает до провайдера от вызывающего: запись ответов ставит
    // его в файл, а угадать по схеме нельзя — схема имени не несёт.
    expect(sent?.stage).toBe('extractor');
  });

  it('снимает обрамление в кодовый блок', async () => {
    // Тройные кавычки вокруг JSON — частая привычка моделей. Содержимое
    // при этом верное, и терять годный разбор из-за оформления глупо.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: ['```json\n' + VALID + '\n```'] });

    const outcome = await requestStructured<ExtractedUnits>(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(true);
    expect(provider.callCount).toBe(1);
  });
});

describe('ответ не по схеме', () => {
  it('повторяет один раз с усиленной инструкцией', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: ['{"units":"не массив"}', VALID] });

    const outcome = await requestStructured<ExtractedUnits>(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(2);

    // Во второй заход промпт усилен, а не повторён дословно.
    expect(provider.requests[1]?.prompt).toContain(PROMPT);
    expect(provider.requests[1]?.prompt).toContain('строго JSON');
    expect(provider.requests[1]?.prompt.length).toBeGreaterThan(
      provider.requests[0]?.prompt.length ?? 0,
    );
  });

  it('после двух неудач возвращает отказ, а не бросает исключение', async () => {
    // §17 ТЗ: терять текст нельзя. Запись сохранится черновиком без
    // классификации, и это решает вызывающий код — поэтому здесь отказ,
    // а не исключение.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: ['мусор', 'снова мусор'] });

    const outcome = await requestStructured<ExtractedUnits>(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    expect(outcome.attempts).toBe(2);
    // Сырой ответ отдаётся наружу: он пойдёт в черновик для разбора руками.
    expect(outcome.raw).toBe('снова мусор');
    expect(outcome.problem).toContain('JSON');
    expect(outcome.promptVersion).toBe('extractor@1');
  });

  it('третьего захода не делает: он стоил бы денег и дал бы то же', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ respond: () => 'мусор' });

    await requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT });

    expect(provider.callCount).toBe(2);
  });

  it('объясняет, чем именно ответ не подошёл', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      respond: () => JSON.stringify({ units: [{ text: 'дело', isProject: 'да' }] }),
    });

    const outcome = await requestStructured(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toContain('схеме');
  });
});

describe('модель недоступна', () => {
  it('пробрасывает временную ошибку наружу', async () => {
    // Дальше работает то, что построено на первом этапе: выгрузка
    // возвращается в очередь, текст человека не теряется.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      failFirst: { times: 10, error: new TransientLlmError('модель занята') },
    });

    await expect(
      requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT }),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it('повторяет временный сбой и доводит дело до конца', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: ['', VALID],
      failFirst: { times: 1, error: new TransientLlmError('сеть моргнула') },
    });

    const outcome = await requestStructured<ExtractedUnits>(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(true);
    expect(provider.callCount).toBe(2);
  });

  it('постоянную ошибку не повторяет', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      failFirst: { times: 10, error: new PermanentLlmError('ключ не тот') },
    });

    await expect(
      requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT }),
    ).rejects.toThrow(/ключ не тот/u);

    expect(provider.callCount).toBe(1);
  });
});

describe('учёт расхода', () => {
  it('помечает вызов версией промпта (§10.3 ТЗ)', async () => {
    // Без этого жалобу «бот стал хуже» не с чем сопоставить.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [VALID], tokensIn: 247, tokensOut: 582 });

    await requestStructured(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
      batchId: undefined,
    });

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.stage).toBe('extractor');
    expect(call?.promptVersion).toBe('extractor@1');
    expect(call?.model).toBe('mock-llm');
    expect(call?.tokensIn).toBe(247);
    expect(call?.tokensOut).toBe(582);
    expect(call?.ok).toBe(true);
  });

  it('каждый заход — отдельная строка: он потрачен и оплачен', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: ['мусор', VALID] });

    await requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT });

    const calls = await testDb().select().from(aiCalls).orderBy(asc(aiCalls.createdAt));
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.ok)).toBe(true);
  });

  it('сорвавшаяся отправка внутри повтора тоже попадает в учёт', async () => {
    /**
     * §10.5 ТЗ дословно: «Таблица обращений к моделям заполняется на
     * каждом вызове, **включая неуспешные**: … задержка, признак успеха,
     * текст ошибки».
     *
     * Учёт стоял снаружи повтора, и внутри одной записи жило до трёх
     * отправок: сорвалась первая, удалась вторая — в таблицу ложилась
     * одна строка с «успех». Неуспешной отправки не было ни в учёте, ни
     * в журнале (`onRetry` не задан нигде), и доля отказов модели в
     * отчёте оказывалась заниженной.
     *
     * Денег это не искажало: 429 и пятисотые не тарифицируются. Но
     * отчёт о качестве работы модели строится ровно на этом числе.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [VALID, VALID],
      failFirst: { times: 1, error: new TransientLlmError('модель занята') },
    });

    await requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT });

    const calls = await testDb().select().from(aiCalls).orderBy(asc(aiCalls.createdAt));

    expect(calls).toHaveLength(2);

    // Первая — та самая, которой в учёте не было.
    expect(calls[0]?.ok).toBe(false);
    expect(calls[0]?.error).toContain('модель занята');

    expect(calls[1]?.ok).toBe(true);
  });

  it('задержка успешной отправки не включает паузу повтора', async () => {
    /**
     * Прежде задержка считалась от входа в учёт, то есть вместе с
     * паузами повтора в секунду и две. Это не задержка вызова, а время
     * ожидания человека — и в отчёте о скорости модели ему не место.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [VALID, VALID],
      failFirst: { times: 1, error: new TransientLlmError('модель занята') },
    });

    await requestStructured(
      {
        ...deps(provider, prompts),
        // Пауза настоящая и заметная: с прежним порядком обёрток она
        // попала бы в задержку успешной отправки.
        retry: {
          attempts: 2,
          sleep: (ms: number) => new Promise((done) => setTimeout(done, ms)),
          baseDelayMs: 300,
        },
      },
      { stage: 'extractor', input: INPUT },
    );

    const calls = await testDb().select().from(aiCalls).orderBy(asc(aiCalls.createdAt));
    const ok = calls.find((call) => call.ok);

    expect(ok?.latencyMs).toBeLessThan(300);
  });

  it('полный отказ модели тоже записывается', async () => {
    // §10.5 ТЗ: пишется каждый вызов, включая неуспешный.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      failFirst: { times: 10, error: new PermanentLlmError('отказ') },
    });

    await expect(
      requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT }),
    ).rejects.toThrow();

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.ok).toBe(false);
    expect(call?.error).toContain('отказ');
    expect(call?.promptVersion).toBe('extractor@1');
  });
});

describe('без активной версии промпта', () => {
  it('падает внятно и до обращения к модели', async () => {
    const provider = new MockLlmProvider({ responses: [VALID] });
    const prompts = new PromptRegistry(testDb(), 60_000);

    await expect(
      requestStructured(deps(provider, prompts), { stage: 'extractor', input: INPUT }),
    ).rejects.toThrow(/Нет активной версии/u);

    // Денег не потратили.
    expect(provider.callCount).toBe(0);
    expect(await testDb().select().from(aiCalls)).toHaveLength(0);
  });
});

/**
 * Потолок расхода на пути модели (задача 3.79).
 *
 * **Здесь проверяется самое опасное место связки.** Обращение к модели
 * обёрнуто циклом повторов по схеме: не разобрался ответ — заходим
 * второй раз. Проглоти этот цикл отказ потолка — и превышение
 * превратилось бы в «модель не ответила», то есть в обычный сбой:
 * выгрузка потратила бы попытки и умерла, а слова человека пропали бы
 * из-за нашего бюджета.
 *
 * Свойство слишком дорогое, чтобы держаться на чтении кода.
 */
describe('потолок расхода', () => {
  const overCeiling = {
    beforeCall: () => Promise.reject(new SpendCeilingError('потолок расхода за сутки перейдён')),
    noteSpent: () => undefined,
    report: () => Promise.resolve([]),
  };

  it('отказ потолка проходит наружу, а не становится «моделью не по схеме»', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [VALID] });

    await expect(
      requestStructured<ExtractedUnits>(
        { ...deps(provider, prompts), spendGuard: overCeiling },
        { stage: 'extractor', input: INPUT },
      ),
    ).rejects.toBeInstanceOf(SpendCeilingError);
  });

  it('модель при этом не спрашивается и денег не тратит', async () => {
    // Если бы проверка стояла после вызова, потолок узнавал бы о
    // превышении, уже за него заплатив.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [VALID] });

    await expect(
      requestStructured<ExtractedUnits>(
        { ...deps(provider, prompts), spendGuard: overCeiling },
        { stage: 'extractor', input: INPUT },
      ),
    ).rejects.toThrow();

    expect(provider.callCount).toBe(0);
    expect(await testDb().select().from(aiCalls)).toHaveLength(0);
  });

  it('без стража всё как было', async () => {
    // Главное обещание правки: не задан потолок — поведение прежнее.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [VALID] });

    const outcome = await requestStructured<ExtractedUnits>(deps(provider, prompts), {
      stage: 'extractor',
      input: INPUT,
    });

    expect(outcome.ok).toBe(true);
    expect(await testDb().select().from(aiCalls)).toHaveLength(1);
  });

  it('страж узнаёт цену удавшегося вызова', async () => {
    /**
     * Между чтениями базы счёт ведёт страж, и цену ему брать неоткуда,
     * кроме как из учёта: без этого кэш на пятнадцать секунд пропускал бы
     * всё, что потрачено внутри окна.
     *
     * Модель названа настоящей нарочно: у выдуманной цены в прайсе нет,
     * `recordAiCall` вернул бы `null`, и проверка прошла бы вхолостую —
     * первый заход так и получилось.
     */
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [VALID],
      model: 'yandex:yandexgpt/latest',
    });
    const noted: number[] = [];

    await requestStructured<ExtractedUnits>(
      {
        ...deps(provider, prompts),
        spendGuard: {
          beforeCall: () => Promise.resolve(),
          noteSpent: (micros) => noted.push(micros),
          report: () => Promise.resolve([]),
        },
      },
      { stage: 'extractor', input: INPUT },
    );

    expect(noted).toHaveLength(1);
    expect(noted[0]).toBeGreaterThan(0);
  });

  it('цену неизвестной модели страж в счёт не берёт', async () => {
    // Иначе выдуманное число легло бы в счёт как факт: лучше знать, что
    // счёт неполон, чем считать по догадке.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ responses: [VALID], model: 'модель-без-цены' });
    const noted: number[] = [];

    await requestStructured<ExtractedUnits>(
      {
        ...deps(provider, prompts),
        spendGuard: {
          beforeCall: () => Promise.resolve(),
          noteSpent: (micros) => noted.push(micros),
          report: () => Promise.resolve([]),
        },
      },
      { stage: 'extractor', input: INPUT },
    );

    expect(noted).toEqual([]);
  });
});
