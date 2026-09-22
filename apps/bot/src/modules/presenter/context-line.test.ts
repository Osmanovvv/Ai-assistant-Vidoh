import { describe, expect, it } from 'vitest';

import type { AiClientDeps, StructuredRequest } from '../ai/client.js';
import type { ActivePrompt } from '../ai/prompts/registry.js';
import {
  PRESENTER_SCHEMA_NAME,
  PRESENTER_V2_SCHEMA_NAME,
  presenterSchema,
  presenterV2Schema,
} from '../ai/schemas/index.js';
import { askContextLine, checkContextLine, type AskStructured } from './context-line.js';
import type { ContextPack } from './context-pack.js';

/**
 * Живая строка (22.09.2026): модель пишет одну-две фразы поверх ответа,
 * собранного кодом. Промпт — просьба; правила §13 и её текст о характере
 * — здесь, кодом. Отвергнутая строка не ломает ответ: он уходит как
 * прежде, без неё.
 */
const facts = [
  'Имя: Оля',
  'Сейчас: вечер',
  'Прошлая выгрузка: 3 дня назад',
  'Записано сейчас:',
  '— записаться к стоматологу (здоровье) — уже было записано раньше',
  '— купить хлеб (покупки), срок: завтра',
  'Срок прошёл: забрать справку — 6 дней назад',
  'Ещё на сегодня: сдать отчёт в 21:00',
  'Открытых дел всего: 14',
].join('\n');

const ok = (line: string) => checkContextLine(line, facts);

describe('страж живой строки', () => {
  it('спокойная фраза о том, что помнит, проходит как есть', () => {
    expect(ok('Стоматолога ты уже записывала — оставила одну запись, срок обновила.')).toEqual({
      ok: true,
      line: 'Стоматолога ты уже записывала — оставила одну запись, срок обновила.',
    });
  });

  it('пустая строка — «сказать нечего», не ошибка', () => {
    expect(ok('')).toEqual({ ok: false, why: 'пусто' });
    expect(ok('   ')).toEqual({ ok: false, why: 'пусто' });
  });

  it('переносы строк схлопываются в пробел, края обрезаются', () => {
    expect(ok('  Справка ждёт шестой день.\nПро отчёт к 21:00 помню.  ')).toEqual({
      ok: true,
      line: 'Справка ждёт шестой день. Про отчёт к 21:00 помню.',
    });
  });

  it('вопрос — нет: в ответе свой, второго §13.9 не разрешает', () => {
    expect(ok('Справка ждёт шестой день — перенести?')).toMatchObject({ ok: false, why: 'вопрос' });
  });

  it('больше двух предложений — абзац, не строка', () => {
    expect(ok('Раз. Два. Три.')).toMatchObject({ ok: false, why: 'больше двух предложений' });
    expect(ok('Раз. Два.')).toMatchObject({ ok: true });
    expect(ok('Раз… Два!')).toMatchObject({ ok: true });
  });

  it('длиннее 240 знаков — отвергается', () => {
    expect(ok(`${'а'.repeat(241)}.`)).toMatchObject({ ok: false, why: 'длинно' });
  });

  it('запрещённые фразы §13.7 и её текста о характере', () => {
    expect(ok('Ты молодец, справка подождёт.')).toMatchObject({
      ok: false,
      why: 'запрет: ты молодец',
    });
    expect(ok('Не переживай, я помню про отчёт.')).toMatchObject({
      ok: false,
      why: 'запрет: не переживай',
    });
    expect(ok('Задача создана.')).toMatchObject({ ok: false, why: 'запрет: задача создана' });
  });

  it('советы и понукания — не её характер: «не заставляет организовывать»', () => {
    expect(ok('Попробуй сегодня закрыть справку.')).toMatchObject({ ok: false, why: 'совет' });
    expect(ok('Не забудь про отчёт в 21:00.')).toMatchObject({ ok: false, why: 'совет' });
    expect(ok('Советую начать со справки.')).toMatchObject({ ok: false, why: 'совет' });
  });

  it('канцелярит, обещания за неё и оценки «не забыла» — из прогона 22.09.2026', () => {
    expect(ok('Оплата садика просрочена на три дня — помню.')).toMatchObject({
      ok: false,
      why: 'канцелярит',
    });
    expect(ok('Про отчёт и заказ помню, разберёмся с этим сегодня.')).toMatchObject({
      ok: false,
      why: 'обещание',
    });
    expect(ok('Стоматолога не забыла — на виду.')).toMatchObject({ ok: false, why: 'оценка' });
  });

  it('«надо/нужно/пора» — понукание; «жду» от себя — давление (прогон 22.09.2026, второй проход)', () => {
    expect(ok('Стоматолога надо записать, уже 6 дней жду.')).toMatchObject({
      ok: false,
      why: 'совет',
    });
    expect(ok('Справку жду уже 6 дней.')).toMatchObject({ ok: false, why: 'давление' });
    expect(ok('Справка из поликлиники всё ещё ждёт — помню про неё.')).toMatchObject({ ok: true });
  });

  it('«помнишь», «знаешь» — за неё; помнит бот, а не она (третий проход 22.09.2026)', () => {
    expect(ok('Стоматолога помнишь, запись никуда не делась.')).toMatchObject({
      ok: false,
      why: 'за неё',
    });
    // «Записывалась» — к врачу, чего бот не знает; «записывала» — мне, это факт.
    expect(ok('Про стоматолога ты уже записывалась — запись одна.')).toMatchObject({
      ok: false,
      why: 'за неё',
    });
    expect(ok('Стоматолога ты уже записывала — запись одна.')).toMatchObject({ ok: true });
    expect(ok('Стоматолога помню — запись на месте.')).toMatchObject({ ok: true });
  });

  it('упрёк — «так и не», «до сих пор не», «опять не» — её правило «без упрёка» (стенд ответов 22.09.2026)', () => {
    expect(ok('Справку из поликлиники так и не забрала.')).toMatchObject({
      ok: false,
      why: 'упрёк',
    });
    expect(ok('Справку до сих пор не забрала.')).toMatchObject({ ok: false, why: 'упрёк' });
    expect(ok('Про справку помню — она всё ещё ждёт.')).toMatchObject({ ok: true });
  });

  it('«задача» — язык таск-менеджера, если только слово не из её же записи', () => {
    expect(ok('Стоматолог — срок был 13.09, всё ещё не закрыта эта задача.')).toMatchObject({
      ok: false,
      why: 'канцелярит',
    });
    expect(
      checkContextLine(
        'Про задачу по математике помню.',
        `${facts}
— сдать задачу по математике (дети)`,
      ),
    ).toMatchObject({ ok: true });
  });

  it('«береги силы», «побереги себя» — совет, как и «отдохни» (бой 22.09.2026)', () => {
    expect(ok('Про справку помню — береги силы.')).toMatchObject({ ok: false, why: 'совет' });
    expect(ok('Побереги себя, справка подождёт.')).toMatchObject({ ok: false });
  });

  it('просить её напомнить или подсказать нельзя: помнит бот (бой 22.09.2026)', () => {
    // «Если есть что-то срочное — напомни» на бою: бот попросил женщину
    // делать его работу. «Напомню» о себе — по-прежнему можно.
    expect(ok('Про справку помню. Если что-то срочное — напомни.')).toMatchObject({
      ok: false,
      why: 'просит её',
    });
    expect(ok('Подскажи, что из этого важнее.')).toMatchObject({ ok: false, why: 'просит её' });
    expect(ok('Про справку помню — напомню в нужный момент.')).toMatchObject({ ok: true });
  });

  it('серия восклицаний — нет', () => {
    expect(ok('Справку помню!!')).toMatchObject({ ok: false, why: 'восклицания' });
  });

  it('эмодзи в строке — ни одного: интонацию ставит код в своей строке', () => {
    expect(ok('Про отчёт помню 🙂')).toMatchObject({ ok: false, why: 'эмодзи' });
    expect(ok('Про отчёт помню 🤍')).toMatchObject({ ok: false, why: 'эмодзи' });
  });

  it('число, которого нет в фактах, — выдумка', () => {
    expect(ok('Справка ждёт 6 дней, отчёт в 21:00.')).toMatchObject({ ok: true });
    expect(ok('Справка ждёт 8 дней.')).toMatchObject({ ok: false, why: 'число не из фактов: 8' });
    expect(ok('Отчёт в 19:30.')).toMatchObject({ ok: false, why: 'число не из фактов: 19:30' });
  });

  it('число словами перед единицей времени — тоже число: проверяется по фактам', () => {
    // Прогон 22.09.2026: в фактах «5 дней назад», модель написала «Три дня
    // тишины» — скопировала пример из промпта. Цифр в строке не было, и
    // страж пропустил выдуманный срок.
    expect(ok('Пять дней тишины — теперь это здесь.')).toMatchObject({
      ok: false,
      why: 'число не из фактов: пять',
    });
    // В фактах «3 дня назад» — «три дня» законно.
    expect(ok('Три дня тишины — теперь это здесь.')).toMatchObject({ ok: true });
    expect(ok('Справка висит шестой день — помню.')).toMatchObject({ ok: true });
    expect(ok('Справка висит девятый день — помню.')).toMatchObject({
      ok: false,
      why: 'число не из фактов: девятый',
    });
    expect(ok('Отчёт через два часа.')).toMatchObject({
      ok: false,
      why: 'число не из фактов: два',
    });
    // Без единицы времени числительное — не срок: «запись одна», «первый раз».
    expect(ok('Стоматолога ты уже записывала — запись одна, вторую не завела.')).toMatchObject({
      ok: true,
    });
    expect(ok('Первый раз — дальше можно просто скидывать сюда.')).toMatchObject({ ok: true });
  });

  it('родня и звери — только те, что в фактах: «ребёнок» не становится «сыном» (бой 22.09.2026)', () => {
    // В фактах «забрать ребёнка пораньше» — бот написал «про сына помню».
    // У заказчицы такая догадка — ошибка на ровном месте.
    expect(ok('Про садик и про сына помню — запись на месте.')).toMatchObject({
      ok: false,
      why: 'человек не из фактов: сына',
    });
    expect(
      checkContextLine(
        'Про ребёнка помню — запись на месте.',
        `${facts}
— забрать ребёнка пораньше (дети)`,
      ),
    ).toMatchObject({ ok: true });
    expect(
      checkContextLine(
        'Про кота помню.',
        `${facts}
— записать кота к ветеринару (дом)`,
      ),
    ).toMatchObject({
      ok: true,
    });
    expect(ok('Про кота помню.')).toMatchObject({ ok: false, why: 'человек не из фактов: кота' });
    // Похожие слова — не родня: «который», «брать», «мужчина», «другой».
    expect(ok('Справка, которую надо было брать, — помню.')).not.toMatchObject({
      why: expect.stringContaining('человек') as string,
    });
    expect(ok('Мужчина в другой очереди.')).not.toMatchObject({
      why: expect.stringContaining('человек') as string,
    });
  });

  it('день недели, которого нет в фактах, — выдумка', () => {
    expect(ok('Стоматолог теперь в четверг.')).toMatchObject({
      ok: false,
      why: 'день недели не из фактов',
    });
  });

  it('счёт дел и сфер — уже в ответе, повтор отвергается', () => {
    expect(ok('Записала 2 дела.')).toMatchObject({ ok: false });
    expect(ok('Два дела и одно желание разложены.')).toMatchObject({ ok: true });
    expect(ok('У тебя 14 открытых дел.')).toMatchObject({ ok: false, why: 'повторяет счёт' });
  });

  it('начало словами открытия — повтор кода, не живая строка', () => {
    expect(ok('Всё, забрала. Справку помню.')).toMatchObject({
      ok: false,
      why: 'повторяет открытие',
    });
    expect(ok('Записала. Справку помню.')).toMatchObject({ ok: false, why: 'повторяет открытие' });
  });

  it('обращение на «вы» и мужской род о себе — не её бот', () => {
    expect(ok('Про справку у вас помню.')).toMatchObject({ ok: false, why: 'на вы' });
    expect(ok('Понял, справку помню.')).toMatchObject({ ok: false, why: 'мужской род' });
  });
});

describe('обращение к модели', () => {
  const pack: ContextPack = {
    name: 'Оля',
    partOfDay: 'вечер',
    daysSinceLast: 3,
    recorded: [{ title: 'купить хлеб', topic: 'покупки', due: 'завтра' }],
    alreadyKnown: [],
    overdue: [{ title: 'забрать справку', daysLate: 6 }],
    today: [],
    projects: [],
    doneRecently: [],
    openTotal: 14,
  };

  function prompts(schemaName: string): { get: () => Promise<ActivePrompt> } {
    return {
      get: () =>
        Promise.resolve({
          stage: 'presenter',
          version: schemaName === PRESENTER_V2_SCHEMA_NAME ? 'presenter@2' : 'presenter@1',
          prompt: 'ЖИВАЯ СТРОКА',
          schemaName,
          jsonSchema: {},
          schema: schemaName === PRESENTER_V2_SCHEMA_NAME ? presenterV2Schema : presenterSchema,
        }),
    };
  }

  const recorded = (): { warns: string[]; infos: string[]; logger: object } => {
    const warns: string[] = [];
    const infos: string[] = [];
    return {
      warns,
      infos,
      logger: {
        warn: (_: object, message: string) => warns.push(message),
        info: (_: object, message: string) => infos.push(message),
      },
    };
  };

  /** Подмена обращения к модели: запоминает запрос, отвечает заданным. */
  function asking(answer: { line: string } | Error): {
    seen: StructuredRequest[];
    ask: AskStructured;
  } {
    const seen: StructuredRequest[] = [];
    return {
      seen,
      ask: (_deps, request) => {
        seen.push(request);
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve({
          ok: true,
          value: answer,
          promptVersion: 'presenter@2',
          attempts: 1,
        });
      },
    };
  }

  const deps = (schemaName: string, logger: object): AiClientDeps =>
    ({ prompts: prompts(schemaName), logger }) as unknown as AiClientDeps;

  it('факты уходят входом на этап презентера, строка возвращается проверенной', async () => {
    const model = asking({ line: 'Справка ждёт шестой день — помню.' });
    const log = recorded();

    const outcome = await askContextLine(
      deps(PRESENTER_V2_SCHEMA_NAME, log.logger),
      { pack, userId: 'u1', batchId: 'b1' },
      model.ask,
    );

    expect(outcome).toEqual({ line: 'Справка ждёт шестой день — помню.' });
    expect(model.seen[0]?.stage).toBe('presenter');
    expect(model.seen[0]?.input).toContain('Срок прошёл: забрать справку — 6 дней назад');
    expect(model.seen[0]).toMatchObject({ userId: 'u1', batchId: 'b1' });
  });

  it('строка не прошла стража — ответ без неё, причина в журнале', async () => {
    const model = asking({ line: 'Не переживай, справку помню.' });
    const log = recorded();

    const outcome = await askContextLine(
      deps(PRESENTER_V2_SCHEMA_NAME, log.logger),
      { pack, userId: 'u1', batchId: 'b1' },
      model.ask,
    );

    expect(outcome).toEqual({
      why: 'запрет: не переживай',
      rejected: 'Не переживай, справку помню.',
    });
    expect(log.infos.some((message) => message.includes('отвергнута'))).toBe(true);
  });

  it('модель ответила пусто — «сказать нечего», без шума в журнале', async () => {
    const model = asking({ line: '' });
    const log = recorded();

    const outcome = await askContextLine(
      deps(PRESENTER_V2_SCHEMA_NAME, log.logger),
      { pack, userId: 'u1', batchId: 'b1' },
      model.ask,
    );

    expect(outcome).toEqual({ why: 'пусто' });
    expect(log.infos).toEqual([]);
    expect(log.warns).toEqual([]);
  });

  it('активен промпт первой версии — модель не зовётся вовсе: платить за чужую схему нельзя', async () => {
    const model = asking({ line: 'что-то' });
    const log = recorded();

    const outcome = await askContextLine(
      deps(PRESENTER_SCHEMA_NAME, log.logger),
      { pack, userId: 'u1', batchId: 'b1' },
      model.ask,
    );

    expect(outcome).toEqual({ why: 'промпт презентера не второй версии' });
    expect(model.seen).toHaveLength(0);
    expect(log.warns).toHaveLength(1);
  });

  it('модель упала — ответ без строки, не исключение', async () => {
    const model = asking(new Error('сеть'));
    const log = recorded();

    const outcome = await askContextLine(
      deps(PRESENTER_V2_SCHEMA_NAME, log.logger),
      { pack, userId: 'u1', batchId: 'b1' },
      model.ask,
    );

    expect(outcome.line).toBeUndefined();
    expect(outcome.why).toContain('сеть');
    expect(log.warns).toHaveLength(1);
  });
});
