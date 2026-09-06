import { describe, expect, it } from 'vitest';

import { PermanentEmbeddingError } from '../../embedder/providers/types.js';
import { PermanentLlmError } from '../providers/types.js';
import {
  RecordingEmbeddingProvider,
  RecordingLlmProvider,
  ReplayEmbeddingProvider,
  ReplayLlmProvider,
  CASSETTE_LLM_MODEL,
} from './provider.js';
import { CassettePlayer, CassetteRecorder, keyOf, vectorKeyOf, parseCassette } from './store.js';
import type { CompletionRequest, CompletionResult, LlmProvider } from '../providers/types.js';
import type { EmbedResult, EmbeddingProvider } from '../../embedder/providers/types.js';

/**
 * Запись и воспроизведение ответов модели (задача 3.80).
 *
 * **Главная опасность — прогон, который проходит, ничего не проверяя.**
 * Половина проверок ниже именно про неё: промах не выдумывает ответ,
 * правка промпта делает запись негодной, воспроизведение не ходит в сеть
 * и не показывает потраченных денег.
 *
 * Прогон, зелёный по неверной причине, хуже красного: красное чинят, а
 * зелёному верят.
 */

const RECORDED = new Date('2026-09-06T12:00:00.000Z');
const SCHEMA = { title: 'extractor', type: 'object' };

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    prompt: 'Разбери поток мыслей на дела.',
    input: 'Сегодня 06.09.2026. надо записаться к врачу',
    jsonSchema: SCHEMA,
    temperature: 0,
    ...overrides,
  };
}

/** Живая модель, которую записываем: отвечает и считает вызовы. */
function liveLlm(answer: string): LlmProvider & { calls: number } {
  const provider = {
    name: 'yandex:yandexgpt/latest',
    calls: 0,
    complete: (): Promise<CompletionResult> => {
      provider.calls++;

      return Promise.resolve({
        text: answer,
        model: 'yandex:yandexgpt/latest',
        tokensIn: 100,
        tokensOut: 20,
        modelVersion: '06.09.2026',
      });
    },
  };

  return provider;
}

function liveEmbedder(): EmbeddingProvider & { calls: number } {
  const provider = {
    name: 'yandex:text-search',
    dimensions: 4,
    calls: 0,
    embed: (): Promise<EmbedResult> => {
      provider.calls++;
      return Promise.resolve({
        vector: [0.1234567, 0.2, 0.3, 0.4],
        model: 'yandex:text-search',
        tokens: 7,
      });
    },
  };

  return provider;
}

describe('запись', () => {
  it('спрашивает живую модель и складывает ответ', async () => {
    const live = liveLlm('{"units":[{"text":"записаться к врачу"}]}');
    const recorder = new CassetteRecorder(RECORDED, 'yandexgpt/latest');
    const provider = new RecordingLlmProvider({ live, recorder, recordedAt: RECORDED });

    const result = await provider.complete(request());

    // Ответ отдаётся как есть: запись не должна менять поведение.
    expect(result.text).toContain('записаться к врачу');
    expect(live.calls).toBe(1);
    expect(recorder.size).toBe(1);
  });

  it('имя провайдера остаётся живым: расход настоящий', () => {
    /**
     * За запись платят, и себестоимость должна быть видна. Подмени имя
     * на «cassette» — и деньги, которые реально ушли, исчезли бы из
     * отчёта о расходе.
     */
    const live = liveLlm('{}');
    const recorder = new CassetteRecorder(RECORDED, 'yandexgpt/latest');

    expect(new RecordingLlmProvider({ live, recorder, recordedAt: RECORDED }).name).toBe(live.name);
  });

  it('даты в ответе записываются относительными', async () => {
    const live = liveLlm('{"deadline":"2026-09-07"}');
    const recorder = new CassetteRecorder(RECORDED, 'yandexgpt/latest');

    await new RecordingLlmProvider({ live, recorder, recordedAt: RECORDED }).complete(request());

    expect(recorder.toFile().entries[0]?.answer).toBe('{"deadline":"{{день+1|iso}}"}');
  });

  it('один запрос с двумя разными ответами считается расхождением', async () => {
    /**
     * Прогон недетерминирован: писать оба ответа нельзя, а выбрать молча
     * значило бы это спрятать. Первый сохраняется, число расхождений
     * идёт в отчёт записи.
     */
    const recorder = new CassetteRecorder(RECORDED, 'yandexgpt/latest');

    await new RecordingLlmProvider({
      live: liveLlm('первый'),
      recorder,
      recordedAt: RECORDED,
    }).complete(request());

    await new RecordingLlmProvider({
      live: liveLlm('второй'),
      recorder,
      recordedAt: RECORDED,
    }).complete(request());

    expect(recorder.size).toBe(1);
    expect(recorder.collisionCount).toBe(1);
    expect(recorder.toFile().entries[0]?.answer).toBe('первый');
  });

  it('вектора округляются, но не портятся', async () => {
    const recorder = new CassetteRecorder(RECORDED, 'yandexgpt/latest');
    const live = liveEmbedder();

    const result = await new RecordingEmbeddingProvider(live, recorder).embed({
      text: 'записаться к врачу',
      purpose: 'document',
    });

    // Наружу отдаётся живой вектор, без округления.
    expect(result.vector[0]).toBe(0.1234567);
    // А в записи — округлённый до шести знаков.
    expect(recorder.toFile().vectors[0]?.vector[0]).toBe(0.123457);
  });
});

describe('воспроизведение', () => {
  const filled = (answer: string, recordedAt = RECORDED) => {
    const recorder = new CassetteRecorder(recordedAt, 'yandexgpt/latest');

    recorder.add({
      key: keyOf({
        stage: 'extractor',
        prompt: request().prompt,
        input: request().input,
        temperature: 0,
        schema: SCHEMA,
        recordedAt,
      }),
      stage: 'extractor',
      input: 'неважно',
      answer,
    });

    return new CassettePlayer(recorder.toFile());
  };

  it('отвечает из записи и в сеть не ходит', async () => {
    const player = filled('{"units":[]}');
    const provider = new ReplayLlmProvider(player, () => RECORDED);

    const result = await provider.complete(request());

    expect(result.text).toBe('{"units":[]}');
  });

  it('расхода не показывает: денег не потрачено', async () => {
    /**
     * Токены попадают в учёт и в отчёт о расходе. Покажи их у
     * воспроизведения — и отчёт назвал бы деньги, которых никто не
     * платил. После 05.09.2026 это последнее, чего хочется: отчёт,
     * завышающий расход, врёт так же, как занижающий.
     */
    const result = await new ReplayLlmProvider(filled('{}'), () => RECORDED).complete(request());

    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
    expect(result.model).toBe(CASSETTE_LLM_MODEL);
  });

  it('даты разворачиваются под сегодняшний день', async () => {
    const player = filled('{"deadline":"{{день+1|iso}}"}');
    const later = new Date('2026-12-25T09:00:00.000Z');

    const result = await new ReplayLlmProvider(player, () => later).complete(request());

    expect(result.text).toBe('{"deadline":"2026-12-26"}');
  });

  describe('чего воспроизведение делать не должно', () => {
    it('промах не выдумывает ответ, а останавливает прогон', async () => {
      /**
       * **Самая важная проверка всей задачи.** Ответ не на тот запрос
       * сделал бы прогон зелёным по неверной причине — и мы бы поверили,
       * что бот работает, когда он сломан.
       */
      const player = filled('{"units":[]}');
      const provider = new ReplayLlmProvider(player, () => RECORDED);

      await expect(
        provider.complete(request({ input: 'совсем другая выгрузка' })),
      ).rejects.toBeInstanceOf(PermanentLlmError);
    });

    it('в сообщении о промахе сказано, что делать', async () => {
      // Иначе промах читается как поломка бота, а не как устаревшая запись.
      const provider = new ReplayLlmProvider(filled('{}'), () => RECORDED);

      await expect(provider.complete(request({ input: 'другое' }))).rejects.toThrow(
        /перезапишите.*record/iu,
      );
    });

    it('правка промпта делает запись негодной', async () => {
      /**
       * Промпт входит в ключ нарочно. Воспроизводить старые ответы для
       * нового промпта значит мерить то, чего больше нет: прогон был бы
       * зелёным, а бот работал бы по другому промпту.
       */
      const provider = new ReplayLlmProvider(filled('{}'), () => RECORDED);

      await expect(
        provider.complete(request({ prompt: 'Тот же вход, но промпт поправили.' })),
      ).rejects.toBeInstanceOf(PermanentLlmError);
    });

    it('смена схемы ответа тоже делает запись негодной', async () => {
      const provider = new ReplayLlmProvider(filled('{}'), () => RECORDED);

      await expect(
        provider.complete(request({ jsonSchema: { title: 'extractor', type: 'array' } })),
      ).rejects.toBeInstanceOf(PermanentLlmError);
    });

    it('промахи считаются: их число видно в отчёте прогона', async () => {
      const player = filled('{}');
      const provider = new ReplayLlmProvider(player, () => RECORDED);

      await expect(provider.complete(request({ input: 'раз' }))).rejects.toThrow();
      await expect(provider.complete(request({ input: 'два' }))).rejects.toThrow();

      expect(player.missCount).toBe(2);
    });

    it('нет вектора — тоже остановка, а не выдуманные числа', async () => {
      /**
       * Выдуманный вектор страшнее выдуманного ответа: поиск кандидатов
       * не падает, а тихо возвращает другое — «худший вид поломки», как
       * сказано в описании самого провайдера векторов.
       */
      const player = new CassettePlayer({
        recordedAt: RECORDED.toISOString(),
        model: 'yandexgpt/latest',
        entries: [],
        vectors: [],
      });

      await expect(
        new ReplayEmbeddingProvider(player, 4).embed({ text: 'что-то', purpose: 'query' }),
      ).rejects.toBeInstanceOf(PermanentEmbeddingError);
    });
  });

  it('записанный вектор находится по тексту и назначению', async () => {
    const recorder = new CassetteRecorder(RECORDED, 'yandexgpt/latest');
    recorder.addVector({
      key: vectorKeyOf('врач', 'query'),
      text: 'врач',
      purpose: 'query',
      vector: [1, 2, 3, 4],
      model: 'yandex:text-search',
      tokens: 3,
    });

    const player = new CassettePlayer(recorder.toFile());

    const found = await new ReplayEmbeddingProvider(player, 4).embed({
      text: 'врач',
      purpose: 'query',
    });

    expect(found.vector).toEqual([1, 2, 3, 4]);

    // А то же слово с другим назначением — другой вектор, и его нет.
    await expect(
      new ReplayEmbeddingProvider(player, 4).embed({ text: 'врач', purpose: 'document' }),
    ).rejects.toBeInstanceOf(PermanentEmbeddingError);
  });
});

describe('ключ запроса', () => {
  it('одинаковые запросы дают один ключ, разные — разные', () => {
    const base = {
      stage: 'extractor',
      prompt: 'промпт',
      input: 'вход',
      temperature: 0,
      schema: SCHEMA,
      recordedAt: RECORDED,
    };

    expect(keyOf(base)).toBe(keyOf({ ...base }));
    expect(keyOf(base)).not.toBe(keyOf({ ...base, input: 'другой вход' }));
    expect(keyOf(base)).not.toBe(keyOf({ ...base, prompt: 'другой промпт' }));
    expect(keyOf(base)).not.toBe(keyOf({ ...base, temperature: 0.3 }));
  });

  it('день записи на ключ не влияет: даты в нём относительные', () => {
    /**
     * Иначе запись жила бы один день: во входе классификатора стоит
     * «Сегодня 06.09.2026, суббота», и завтра ключ бы не совпал.
     */
    const parts = {
      stage: 'classifier',
      prompt: 'промпт',
      input: 'Сегодня 06.09.2026, суббота. надо к врачу',
      schema: SCHEMA,
    };

    const today = keyOf({ ...parts, recordedAt: RECORDED });
    const shifted = keyOf({
      ...parts,
      input: 'Сегодня 07.09.2026, суббота. надо к врачу',
      recordedAt: new Date('2026-09-07T12:00:00.000Z'),
    });

    expect(shifted).toBe(today);
  });
});

describe('разбор записи', () => {
  /**
   * Один разбор на всех читателей (задача 3.82).
   *
   * До неё проверенная `loadCassette` стояла без вызовов, а сеанс
   * воспроизведения разбирал файл своей копией — без страховок. Записи
   * без поля `vectors` он ронял, а пустую модель уносил в отчёт
   * пустотой. Здесь проверяется ровно то, на чём копии расходились.
   */
  const minimal = JSON.stringify({
    recordedAt: '2026-09-06T10:00:00.000Z',
    entries: [{ key: 'a', stage: 'router', model: 'x', answer: '{}' }],
  });

  it('запись без векторов читается, а не роняет прогон', () => {
    const file = parseCassette(minimal, 'к.json');

    expect(file.vectors).toEqual([]);
    expect(file.entries).toHaveLength(1);
  });

  it('мусор вместо векторов не становится векторами', () => {
    const file = parseCassette(
      JSON.stringify({ recordedAt: '2026-09-06T10:00:00.000Z', entries: [], vectors: 'нет' }),
      'к.json',
    );

    expect(file.vectors).toEqual([]);
  });

  it('модель без имени называется словом, а не пустотой', () => {
    expect(parseCassette(minimal, 'к.json').model).toBe('неизвестно');
  });

  it('чужой файл отвергается с именем файла в отказе', () => {
    expect(() => parseCassette('{"что-то": 1}', 'чужое.json')).toThrow('чужое.json');
    expect(() => parseCassette('не json', 'битое.json')).toThrow('битое.json');
  });
});
