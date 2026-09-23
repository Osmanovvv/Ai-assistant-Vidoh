import { beforeEach, describe, expect, it } from 'vitest';

import { aiCalls, promptVersions } from '../../db/schema.js';
import { createLogger } from '../../infra/logger.js';
import { testDb } from '../../test/db.js';
import { PromptRegistry } from '../ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../ai/prompts/seed.js';
import { MockLlmProvider } from '../ai/providers/mock.js';
import { TransientLlmError } from '../ai/providers/types.js';
import { ROUTER_SCHEMA_NAME } from '../ai/schemas/index.js';
import { routeIntents } from './router.service.js';

/**
 * Маршрутизатор на живой базе с подменённой моделью.
 *
 * Проверяется поведение, от которого зависит, не потеряется ли мысль:
 * порядок применения намерений, замена при неразборе, учёт расхода.
 */

const logger = createLogger({ level: 'silent' });

const THREE_INTENTS = 'Продукты купила, а ещё надо к врачу записаться, и что у меня на завтра?';

async function prepare(): Promise<PromptRegistry> {
  await seedPrompt(testDb(), {
    stage: 'router',
    version: 'router@1',
    prompt: 'Определи намерения.',
    schemaName: ROUTER_SCHEMA_NAME,
  });
  await activatePrompt(testDb(), 'router', 'router@1');

  return new PromptRegistry(testDb(), 60_000);
}

function deps(provider: MockLlmProvider, prompts: PromptRegistry) {
  return {
    db: testDb(),
    provider,
    prompts,
    logger,
    retry: { attempts: 2, sleep: () => Promise.resolve() },
  };
}

beforeEach(async () => {
  await testDb().delete(promptVersions);
  await testDb().delete(aiCalls);
});

describe('разбор намерений', () => {
  it('фраза с тремя намерениями даёт три сегмента в правильном порядке', async () => {
    // Условие готовности задачи 2.4 дословно.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({
          crisis: false,
          segments: [
            { intent: 'COMPLETE', text: 'Продукты купила' },
            { intent: 'DUMP', text: 'а ещё надо к врачу записаться' },
            { intent: 'QUERY', text: 'и что у меня на завтра?' },
          ],
        }),
      ],
    });

    const result = await routeIntents(deps(provider, prompts), { input: THREE_INTENTS });

    expect(result.segments.map((item) => item.intent)).toEqual(['COMPLETE', 'DUMP', 'QUERY']);
    expect(result.fallback).toBe(false);
    expect(result.reordered).toBe(false);
    expect(result.promptVersion).toBe('router@1');
  });

  it('исправляет порядок, если модель вернула правку раньше исправляемого', async () => {
    const prompts = await prepare();
    const input = 'Записать сына к врачу в четверг, хотя нет, в пятницу.';
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({
          crisis: false,
          segments: [
            { intent: 'PATCH', text: 'хотя нет, в пятницу' },
            { intent: 'DUMP', text: 'Записать сына к врачу в четверг' },
          ],
        }),
      ],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments.map((item) => item.intent)).toEqual(['DUMP', 'PATCH']);
    expect(result.reordered).toBe(true);
  });

  it('открытый вопрос попадает в запрос к модели', async () => {
    // §7.1 плюс наше добавление: при открытом вопросе ANSWER проверяется
    // первым, иначе «в четверг» станет задачей без задачи.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({ crisis: false, segments: [{ intent: 'ANSWER', text: 'в четверг' }] }),
      ],
    });

    await routeIntents(deps(provider, prompts), {
      input: 'в четверг',
      openQuestion: 'На какой день записать к врачу?',
    });

    expect(provider.requests[0]?.input).toContain('На какой день записать');
    expect(provider.requests[0]?.input).toContain('в четверг');
  });

  it('без открытого вопроса лишнего в запрос не добавляет', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: 'надо к врачу' }] }),
      ],
    });

    await routeIntents(deps(provider, prompts), { input: 'надо к врачу' });

    expect(provider.requests[0]?.input).toBe('надо к врачу');
  });
});

describe('явное дополнение поверх ответа модели (прогон 17.09.2026)', () => {
  it('«К банку добавь: …», названное моделью вопросом, становится правкой', async () => {
    const prompts = await prepare();
    const input = 'К банку добавь: спросить про лимит по карте';
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments: [{ intent: 'QUERY', text: input }] })],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments.map((item) => item.intent)).toEqual(['PATCH']);
  });

  it('то же, если модель сочла его новой мыслью', async () => {
    const prompts = await prepare();
    const input = 'Допиши к стоматологу: взять полис';
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: input }] })],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments.map((item) => item.intent)).toEqual(['PATCH']);
  });

  it('настоящий вопрос вопросом и остаётся', async () => {
    const prompts = await prepare();
    const input = 'Что у меня добавлено на завтра?';
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments: [{ intent: 'QUERY', text: input }] })],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments.map((item) => item.intent)).toEqual(['QUERY']);
  });
});

describe('приказ о замене — правка, а не мысль (живой прогон Никиты 22.09.2026)', () => {
  /**
   * Бой 22.09.2026, 23:34. «Перенеси посылку на пятницу на 10 утра»
   * маршрутизатор назвал мыслью — и рядом с записью про посылку встала
   * третья запись «Перенести посылку на пятницу на .», а перенос не
   * случился.
   *
   * Признаки замены §7.1 перечисляет закрытым списком, и «перенеси» в
   * нём есть: `startsWithReplacement` уже живёт в коде, но её читал
   * только резолвер — то есть лишь тогда, когда модель **сама** назвала
   * отрезок правкой. На разметку маршрутизатора признак не влиял вовсе.
   *
   * Цена ошибки та же, что у остальных правил разметки: если отрезок всё
   * же новая мысль, резолвер цели не найдёт и вернёт его в обычный
   * разбор — запись появится, потеряется один вызов модели.
   */
  it('«Перенеси посылку на пятницу…», названное моделью мыслью, становится правкой', async () => {
    const prompts = await prepare();
    const input = 'Перенеси посылку на пятницу на 10 утра.';
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: input }] })],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments.map((item) => item.intent)).toEqual(['PATCH']);
  });

  it('«Вместо вторника давай в среду» — тоже правка', async () => {
    const prompts = await prepare();
    const input = 'Вместо вторника давай в среду.';
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: input }] })],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments.map((item) => item.intent)).toEqual(['PATCH']);
  });

  it('дело со словом замены не в начале мыслью и остаётся', async () => {
    // «Перенести» здесь не приказ о записи, а само дело.
    const prompts = await prepare();
    const input = 'Надо перенести цветы на балкон.';
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: input }] })],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments.map((item) => item.intent)).toEqual(['DUMP']);
  });
});

describe('сообщение из одного времени — правка, а не мысль (живой прогон Никиты 23.09.2026)', () => {
  /**
   * 14:57 «Давай в четверть 7» и 14:58 «Давай через полчаса» лёгкая модель
   * назвала мыслью: завелись «В четверть седьмого что-то запланировано» и
   * «Встретиться». Правило «дело не названо — про последнее обсуждённое»
   * стояло только на пути правок — та же дыра, что с «перенеси» ночью.
   *
   * Только для сообщения из одного отрезка: внутри выгрузки «Так завтра.
   * С 9 до 10 позвонить…» день клеится к соседней мысли, и это решает
   * разбор, а не маршрутизатор.
   */
  const routed = async (input: string, segments: { intent: string; text: string }[]) => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments })],
    });
    return (await routeIntents(deps(provider, prompts), { input })).segments.map(
      (item) => item.intent,
    );
  };

  it.each(['Давай в четверть 7.', 'Давай через полчаса', 'а лучше в пять вечера', 'на час позже'])(
    '«%s» одним сообщением — правка',
    async (text) => {
      expect(await routed(text, [{ intent: 'DUMP', text }])).toEqual(['PATCH']);
    },
  );

  it('«Так завтра.» перед мыслью — остаётся мыслью: день клеится к соседу', async () => {
    const input = 'Так завтра. С 9 до 10 не забыть позвонить Елене Михайловне.';
    expect(
      await routed(input, [
        { intent: 'DUMP', text: 'Так завтра.' },
        { intent: 'DUMP', text: 'С 9 до 10 не забыть позвонить Елене Михайловне.' },
      ]),
    ).toEqual(['DUMP', 'DUMP']);
  });

  it('«дело» или «удали это» без срока — разметка модели остаётся', async () => {
    expect(await routed('дело', [{ intent: 'DUMP', text: 'дело' }])).toEqual(['DUMP']);
    expect(await routed('удали это', [{ intent: 'CANCEL', text: 'удали это' }])).toEqual([
      'CANCEL',
    ]);
  });

  it('дело одним сообщением — мысль', async () => {
    expect(
      await routed('Купить хлеб завтра', [{ intent: 'DUMP', text: 'Купить хлеб завтра' }]),
    ).toEqual(['DUMP']);
  });
});

describe('разговор с делами внутри — мысль (бой 21.09.2026, выгрузка Никиты)', () => {
  it('хвост перечисления, названный моделью разговором, уходит в разбор мыслью', async () => {
    /**
     * Восемь дел одним голосовым; модель отдала хвост «потом надо будет
     * позвонить маме… вот в общем вроде всё» разговором, и четыре дела
     * пропали молча: разговор конвейер не разбирает.
     */
    const prompts = await prepare();
    const head = 'Мне сегодня надо будет сходить к стоматологу в 13 0 0.';
    const tail =
      'Потом надо будет позвонить маме сегодня либо завтра. Вот также сходить купить еды, продукты, вот в общем вроде все.';
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({
          crisis: false,
          segments: [
            { intent: 'DUMP', text: head },
            { intent: 'SMALLTALK', text: tail },
          ],
        }),
      ],
    });

    const result = await routeIntents(deps(provider, prompts), { input: `${head} ${tail}` });

    expect(result.segments.map((item) => item.intent)).toEqual(['DUMP', 'DUMP']);
    expect(result.segments[1]?.text).toBe(tail);
  });

  it('разговор без дел разговором и остаётся', async () => {
    const prompts = await prepare();
    const input = 'Надо купить хлеб. Вот в общем вроде все, спасибо.';
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({
          crisis: false,
          segments: [
            { intent: 'DUMP', text: 'Надо купить хлеб.' },
            { intent: 'SMALLTALK', text: 'Вот в общем вроде все, спасибо.' },
          ],
        }),
      ],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments.map((item) => item.intent)).toEqual(['DUMP', 'SMALLTALK']);
  });
});

describe('обрезанный ответ модели (бой 21.09.2026, выгрузка Никиты)', () => {
  it('хвост текста, которого нет ни в одном отрезке, возвращается в разбор мыслью', async () => {
    /**
     * Стенд 21.09 на его расшифровке: три отрезка `DUMP`, третий оборван
     * на «Её в клинику ветеринарную,» — четыре дела в хвосте пропали.
     */
    const prompts = await prepare();
    const head =
      'В общем, смотри, мне сегодня надо будет сходить к стоматологу в 13 0 0 вот также. Потом надо будет погулять с собакой, также завтра вечером надо будет отвезти. Ее в клинику ветеринарную,';
    const tail =
      'потом надо будет позвонить маме сегодня либо завтра. Вот также сходить купить еды, продукты, вот в общем вроде все.';
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({
          crisis: false,
          segments: [
            {
              intent: 'DUMP',
              text: 'В общем, смотри, мне сегодня надо будет сходить к стоматологу в 13 0 0 вот также.',
            },
            {
              intent: 'DUMP',
              text: 'Потом надо будет погулять с собакой, также завтра вечером надо будет отвезти. Её в клинику ветеринарную,',
            },
          ],
        }),
      ],
    });

    const result = await routeIntents(deps(provider, prompts), { input: `${head} ${tail}` });

    expect(result.segments.map((item) => item.intent)).toEqual(['DUMP', 'DUMP', 'DUMP']);
    expect(result.segments[2]?.text).toBe(tail);
  });
});

describe('вопрос о дне внутри мысли (серия голосовых 18.09.2026, голос 3)', () => {
  it('модель оставила всё мыслью — вопрос выделяется кодом, «и ещё …» после него остаётся мыслью', async () => {
    const prompts = await prepare();
    const input =
      'Надо позвонить в школу на счет экскурсии. Кстати, что у меня там на завтра и еще платить интернет?';
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: input }] })],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments).toEqual([
      { intent: 'DUMP', text: 'Надо позвонить в школу на счет экскурсии.' },
      { intent: 'QUERY', text: 'Кстати, что у меня там на завтра' },
      { intent: 'DUMP', text: 'и еще платить интернет?' },
    ]);
  });
});

describe('два закрытия одним отрезком (серия голосовых 18.09.2026, голос 5)', () => {
  it('отметка и отмена, склеенные моделью в один COMPLETE, режутся кодом на два отрезка', async () => {
    const prompts = await prepare();
    const input =
      'Продукты купила уже, а в школу звонить не надо. Все решилось, зато надо записаться к косметологу.';
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({
          crisis: false,
          segments: [
            {
              intent: 'COMPLETE',
              text: 'Продукты купила уже, а в школу звонить не надо. Все решилось,',
            },
            { intent: 'DUMP', text: 'зато надо записаться к косметологу.' },
          ],
        }),
      ],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments).toEqual([
      { intent: 'COMPLETE', text: 'Продукты купила уже' },
      { intent: 'CANCEL', text: 'а в школу звонить не надо. Все решилось' },
      { intent: 'DUMP', text: 'зато надо записаться к косметологу.' },
    ]);
  });
});

describe('мысль, приклеенная к правке (серия голосовых 18.09.2026, голос 10)', () => {
  it('«ещё оплатить садик…» после правки срока уходит мыслью, правка остаётся короткой', async () => {
    const prompts = await prepare();
    const input =
      'Так, во вторник надо отвести дочку к врачу, хотя нет к врачу лучше в пятницу еще оплатить садик до 20 купить подарок сестре.';
    const provider = new MockLlmProvider({
      responses: [
        JSON.stringify({
          crisis: false,
          segments: [
            { intent: 'DUMP', text: 'Так, во вторник надо отвести дочку к врачу,' },
            {
              intent: 'PATCH',
              text: 'хотя нет к врачу лучше в пятницу еще оплатить садик до 20 купить подарок сестре.',
            },
          ],
        }),
      ],
    });

    const result = await routeIntents(deps(provider, prompts), { input });

    expect(result.segments).toEqual([
      { intent: 'DUMP', text: 'Так, во вторник надо отвести дочку к врачу,' },
      { intent: 'PATCH', text: 'хотя нет к врачу лучше в пятницу' },
      { intent: 'DUMP', text: 'еще оплатить садик до 20 купить подарок сестре.' },
    ]);
  });
});

describe('когда намерения не разобрались', () => {
  it('считает всю выгрузку одной мыслью, а не теряет её', async () => {
    // DUMP — самое частое намерение, и такая замена ничего не теряет.
    // Отказ обрабатывать выгрузку оставил бы человека без ответа.
    const prompts = await prepare();
    const provider = new MockLlmProvider({ respond: () => 'мусор' });

    const result = await routeIntents(deps(provider, prompts), { input: THREE_INTENTS });

    expect(result.fallback).toBe(true);
    expect(result.segments).toEqual([{ intent: 'DUMP', text: THREE_INTENTS }]);
  });

  it('пустой список сегментов тоже становится одной мыслью', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments: [] })],
    });

    const result = await routeIntents(deps(provider, prompts), { input: 'просто мысль' });

    expect(result.fallback).toBe(true);
    expect(result.segments[0]?.text).toBe('просто мысль');
  });

  it('недоступность модели пробрасывает наружу, а не подменяет заменой', async () => {
    // Здесь замена была бы вредна: выгрузку надо вернуть в очередь и
    // разобрать позже, а не решить за человека, что он просто болтал.
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      failFirst: { times: 10, error: new TransientLlmError('модель занята') },
    });

    await expect(
      routeIntents(deps(provider, prompts), { input: THREE_INTENTS }),
    ).rejects.toBeInstanceOf(TransientLlmError);
  });
});

describe('учёт расхода', () => {
  it('вызов записан с этапом router и версией промпта', async () => {
    const prompts = await prepare();
    const provider = new MockLlmProvider({
      responses: [JSON.stringify({ crisis: false, segments: [{ intent: 'DUMP', text: 'мысль' }] })],
    });

    await routeIntents(deps(provider, prompts), { input: 'мысль' });

    const [call] = await testDb().select().from(aiCalls);
    expect(call?.stage).toBe('router');
    expect(call?.promptVersion).toBe('router@1');
    expect(call?.ok).toBe(true);
  });
});
