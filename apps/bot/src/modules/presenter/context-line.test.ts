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

  it('оценка дела — «хорошее», «важное» (проверка Никиты 24.09.2026, 18:59–19:00)', () => {
    // Её текст о характере: бот не оценивает. На бою: «Ряженка — хорошее
    // дополнение к осеннему вечеру», «Забрать ребёнка завтра — важное
    // дело, помню про него».
    expect(ok('Ряженка — хорошее дополнение к осеннему вечеру.')).toMatchObject({
      ok: false,
      why: 'оценка',
    });
    expect(ok('Забрать ребёнка завтра — важное дело, помню про него.')).toMatchObject({
      ok: false,
      why: 'оценка',
    });
    expect(ok('Прекрасный план на завтра.')).toMatchObject({ ok: false, why: 'оценка' });
  });

  it('«надо/нужно/пора» — понукание; «жду» от себя — давление (прогон 22.09.2026, второй проход)', () => {
    expect(ok('Стоматолога надо записать, уже 6 дней жду.')).toMatchObject({
      ok: false,
      why: 'совет',
    });
    expect(ok('Справку жду уже 6 дней.')).toMatchObject({ ok: false, why: 'давление' });
    expect(ok('Справка из поликлиники всё ещё ждёт — помню про неё.')).toMatchObject({ ok: true });
  });

  it('«нужно» + её же дело — пересказ, а не совет (журнал боя 27.09.2026, docs/29)', () => {
    const dress = [
      'Сейчас: вечер',
      'Записано сейчас:',
      '— Забрать платье из ателье (дом), срок: вечером — уже было записано раньше',
      'Открытых дел всего: 5',
    ].join('\n');
    const mom = [
      'Сейчас: день',
      'Ещё на сегодня: Отвезти маме лекарства в 18:00',
      'Открытых дел всего: 5',
    ].join('\n');

    expect(
      checkContextLine('Про платье, которое нужно забрать вечером, помню.', dress),
    ).toMatchObject({ ok: true });
    expect(
      checkContextLine('Про маму помню — лекарства нужно отвезти в 18:00.', mom),
    ).toMatchObject({
      ok: true,
    });
    // Не её дело — по-прежнему понукание.
    expect(checkContextLine('Про платье помню — нужно поторопиться.', dress)).toMatchObject({
      ok: false,
      why: 'совет',
    });
    expect(checkContextLine('Про маму помню — нужно позвонить ей.', mom)).toMatchObject({
      ok: false,
      why: 'совет',
    });
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
    // Открытие «запомнила» (правка заказчицы 30.09.2026) — тоже повтор.
    expect(ok('Всё, запомнила. Справку помню.')).toMatchObject({
      ok: false,
      why: 'повторяет открытие',
    });
    expect(ok('Поняла, запомнила. Справку помню.')).toMatchObject({
      ok: false,
      why: 'повторяет открытие',
    });
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

    // Заглушка отвечает одно и то же, поэтому вторая попытка (25.09.2026)
    // тоже отвергнута: строки нет, обе причины в журнале.
    expect(outcome).toEqual({
      why: 'запрет: не переживай',
      rejected: 'Не переживай, справку помню.',
      firstTry: { line: 'Не переживай, справку помню.', why: 'запрет: не переживай' },
    });
    expect(model.seen).toHaveLength(2);
    expect(log.infos.filter((message) => message.includes('отвергнута'))).toHaveLength(2);
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

  describe('нет повода — нет строки (проверка Никиты 24.09.2026, 18:59–19:01)', () => {
    /**
     * Входы трёх строк с боя, собранные боевым кодом по базе: записано одно
     * новое дело, прошлая выгрузка сегодня, прежние поводы на паузе — и
     * только большие цели. Модель писала «Ряженка — хорошее дополнение к
     * осеннему вечеру» и «Поняла, что поездка за ребёнком запланирована на
     * завтра», хотя промпт велит при таких фактах вернуть пусто.
     */
    const plain: ContextPack = {
      name: 'Лера',
      partOfDay: 'вечер',
      daysSinceLast: 0,
      recorded: [{ title: 'Поехать за ребёнком', topic: 'семья', due: 'завтра' }],
      alreadyKnown: [],
      overdue: [],
      today: [],
      projects: [],
      doneRecently: [],
      openTotal: 79,
    };
    const goalsOnly: ContextPack = {
      ...plain,
      projects: ['Наладить жизнь', 'За осень сделать ремонт в спальне: обои, потолок, шторы'],
    };

    it('ни одного из семи поводов — модель не зовётся, строки нет и журнал молчит', async () => {
      const model = asking({ line: 'Поняла, что поездка за ребёнком запланирована на завтра.' });
      const log = recorded();

      const outcome = await askContextLine(
        deps(PRESENTER_V2_SCHEMA_NAME, log.logger),
        { pack: plain, userId: 'u1', batchId: 'b1' },
        model.ask,
      );

      expect(outcome).toEqual({ why: 'нет повода' });
      expect(model.seen).toHaveLength(0);
      expect(log.infos).toEqual([]);
      expect(log.warns).toEqual([]);
    });

    it('каждый из семи поводов по отдельности — модель зовётся', async () => {
      const hooks: readonly (readonly [string, ContextPack])[] = [
        ['уже было записано', { ...plain, alreadyKnown: ['Поехать за ребёнком'] }],
        ['срок прошёл', { ...plain, overdue: [{ title: 'забрать справку', daysLate: 6 }] }],
        ['ещё на сегодня', { ...plain, today: [{ title: 'сдать отчёт', time: '21:00' }] }],
        ['недавно закрыла', { ...plain, doneRecently: ['найти няню'] }],
        ['большие цели', goalsOnly],
        ['три дня тишины', { ...plain, daysSinceLast: 3 }],
        ['первая выгрузка', { ...plain, daysSinceLast: undefined }],
      ];

      for (const [hook, one] of hooks) {
        const model = asking({ line: '' });
        await askContextLine(
          deps(PRESENTER_V2_SCHEMA_NAME, recorded().logger),
          { pack: one, userId: 'u1', batchId: 'b1' },
          model.ask,
        );
        expect(model.seen, hook).toHaveLength(1);
      }
    });

    it('прошлая выгрузка вчера или позавчера — ещё не повод', async () => {
      for (const days of [1, 2]) {
        const model = asking({ line: 'Два дня тишины — теперь всё здесь.' });
        const outcome = await askContextLine(
          deps(PRESENTER_V2_SCHEMA_NAME, recorded().logger),
          { pack: { ...plain, daysSinceLast: days }, userId: 'u1', batchId: 'b1' },
          model.ask,
        );
        expect(model.seen, String(days)).toHaveLength(0);
        expect(outcome).toEqual({ why: 'нет повода' });
      }
    });

    it('одни большие цели, а строка не о цели — пересказ записанного отвергается (бой 24.09.2026, 19:00)', async () => {
      const model = asking({ line: 'Поняла, что поездка за ребёнком запланирована на завтра.' });
      const log = recorded();

      const outcome = await askContextLine(
        deps(PRESENTER_V2_SCHEMA_NAME, log.logger),
        { pack: goalsOnly, userId: 'u1', batchId: 'b1' },
        model.ask,
      );

      // Сито (25.09.2026): «поняла», «поездка», «запланирована» — не из
      // фактов и не из словаря бота.
      expect(outcome).toEqual({
        why: 'слово не из фактов: поняла',
        rejected: 'Поняла, что поездка за ребёнком запланирована на завтра.',
      });
      expect(log.infos.some((message) => message.includes('отвергнута'))).toBe(true);
    });

    it('слова все знакомые, но строка о записанном, а не о цели — сито отвергает (25.09.2026)', async () => {
      const model = asking({ line: 'Про ребёнка помню — завтра.' });

      const outcome = await askContextLine(
        deps(PRESENTER_V2_SCHEMA_NAME, recorded().logger),
        { pack: goalsOnly, userId: 'u1', batchId: 'b1' },
        model.ask,
      );

      expect(outcome).toEqual({ why: 'не о поводе', rejected: 'Про ребёнка помню — завтра.' });
    });

    it('одни большие цели, а строка о цели — проходит (пример промпта: обои к ремонту)', async () => {
      const model = asking({ line: 'Обои — это к ремонту спальни, помню про него.' });

      const outcome = await askContextLine(
        deps(PRESENTER_V2_SCHEMA_NAME, recorded().logger),
        {
          pack: {
            ...goalsOnly,
            recorded: [{ title: 'купить обои', topic: 'дом', due: undefined }],
          },
          userId: 'u1',
          batchId: 'b1',
        },
        model.ask,
      );

      expect(outcome).toEqual({ line: 'Обои — это к ремонту спальни, помню про него.' });
    });

    it('цели и ещё повод — строка не обязана быть о цели', async () => {
      const model = asking({ line: 'Про справку помню — запись на месте.' });

      const outcome = await askContextLine(
        deps(PRESENTER_V2_SCHEMA_NAME, recorded().logger),
        {
          pack: { ...goalsOnly, overdue: [{ title: 'забрать справку', daysLate: 6 }] },
          userId: 'u1',
          batchId: 'b1',
        },
        model.ask,
      );

      expect(outcome).toEqual({ line: 'Про справку помню — запись на месте.' });
    });
  });

  describe('вторая попытка (Никита 25.09.2026: «живость и правильность, баланс»)', () => {
    /**
     * Бой 25.09.2026 01:44, «Купить кефир»: повод — дела на сегодня, модель
     * написала «Проехать за ребёнком в 16:00 — помню.», сито отсекло, и
     * живая строка пропала. Модель почти детерминирована: тот же вход
     * вернул бы ту же строку, поэтому во второй попытке ей сказано, что
     * не подошло.
     */
    const today: ContextPack = {
      name: 'Лера',
      partOfDay: 'ночь',
      daysSinceLast: 1,
      recorded: [{ title: 'Купить кефир', topic: 'покупки', due: undefined }],
      alreadyKnown: [],
      overdue: [],
      today: [{ title: 'Поехать за ребёнком', time: '16:00' }, { title: 'Купить яйца' }],
      projects: ['Наладить жизнь'],
      doneRecently: [],
      openTotal: 80,
    };
    const crooked = 'Проехать за ребёнком в 16:00 — помню.';
    const good = 'Про ребёнка в 16:00 помню.';

    /** Подмена модели, отвечающая по очереди. */
    function answering(...lines: string[]): { seen: StructuredRequest[]; ask: AskStructured } {
      const seen: StructuredRequest[] = [];
      return {
        seen,
        ask: (_deps, request) => {
          const line = lines[seen.length] ?? '';
          seen.push(request);
          return Promise.resolve({
            ok: true,
            value: { line },
            promptVersion: 'presenter@2',
            attempts: 1,
          });
        },
      };
    }

    it('сито отсекло — модель пишет ещё раз, ей сказано, что не подошло; прошла — уходит вторая', async () => {
      const model = answering(crooked, good);

      const outcome = await askContextLine(
        deps(PRESENTER_V2_SCHEMA_NAME, recorded().logger),
        { pack: today, userId: 'u1', batchId: 'b1' },
        model.ask,
      );

      expect(outcome).toEqual({
        line: good,
        firstTry: { line: crooked, why: 'слово не из фактов: проехать' },
      });
      expect(model.seen).toHaveLength(2);
      const [first, second] = model.seen;
      // Те же факты, что в первый раз, и ниже — что не подошло.
      expect(second?.input.startsWith(first?.input ?? '?')).toBe(true);
      expect(second?.input).toContain(crooked);
      expect(second?.input).toContain('«проехать»');
      expect(second).toMatchObject({ stage: 'presenter', userId: 'u1', batchId: 'b1' });
    });

    it('вторая тоже не прошла — строки нет; третьей попытки не бывает', async () => {
      const model = answering(crooked, 'Ряженка — хорошее дополнение к вечеру.', good);
      const log = recorded();

      const outcome = await askContextLine(
        deps(PRESENTER_V2_SCHEMA_NAME, log.logger),
        { pack: today, userId: 'u1', batchId: 'b1' },
        model.ask,
      );

      expect(outcome).toEqual({
        why: 'оценка',
        rejected: 'Ряженка — хорошее дополнение к вечеру.',
        firstTry: { line: crooked, why: 'слово не из фактов: проехать' },
      });
      expect(model.seen).toHaveLength(2);
      expect(log.infos.filter((message) => message.includes('отвергнута'))).toHaveLength(2);
    });

    it('вторая вернула пусто — строки нет, это законный ответ', async () => {
      const model = answering(crooked, '');

      const outcome = await askContextLine(
        deps(PRESENTER_V2_SCHEMA_NAME, recorded().logger),
        { pack: today, userId: 'u1', batchId: 'b1' },
        model.ask,
      );

      expect(outcome).toEqual({
        why: 'пусто',
        firstTry: { line: crooked, why: 'слово не из фактов: проехать' },
      });
      expect(model.seen).toHaveLength(2);
    });

    it('первая прошла или модель сказала «пусто» — второй попытки нет: платим только за отказы', async () => {
      for (const line of [good, '']) {
        const model = answering(line, good);
        await askContextLine(
          deps(PRESENTER_V2_SCHEMA_NAME, recorded().logger),
          { pack: today, userId: 'u1', batchId: 'b1' },
          model.ask,
        );
        expect(model.seen, line).toHaveLength(1);
      }
    });

    it('при одних больших целях второй попытки нет: правильный ответ там чаще — пусто', async () => {
      const goals: ContextPack = { ...today, today: [], projects: ['Наладить жизнь'] };
      const model = answering('Про кефир помню — завтра.', 'Про жизнь помню.');

      const outcome = await askContextLine(
        deps(PRESENTER_V2_SCHEMA_NAME, recorded().logger),
        { pack: goals, userId: 'u1', batchId: 'b1' },
        model.ask,
      );

      expect(model.seen).toHaveLength(1);
      expect(outcome).toEqual({ why: 'не о поводе', rejected: 'Про кефир помню — завтра.' });
    });
  });
});
