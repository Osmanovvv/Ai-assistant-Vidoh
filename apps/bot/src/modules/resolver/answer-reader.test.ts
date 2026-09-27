import { describe, expect, it } from 'vitest';

import type { ReaderReading } from '../ai/schemas/index.js';
import { clockTimesIn, hourWithoutDay } from '../classifier/clock-time.js';
import { defaultTexts } from '../../texts/index.js';

import { checkReading, readerInput, readReply, type ReaderQuestion } from './answer-reader.js';
import { hourClarifyCommand } from './clarify.js';

/**
 * Чтение ответа на вопрос бота моделью (шаг 3 плана docs/28, 28.09.2026).
 *
 * Модель говорит, что человек имел в виду; код решает, верить ли: выбор
 * должен быть из предложенного, мысль — дословно из реплики и отдельной
 * частью, новое дело не может стать ответом. Не прошло — «не прочитано»,
 * и бот ведёт себя как без модели.
 */
const shoes: ReaderQuestion = {
  kind: 'time',
  command: hourClarifyCommand('Забрать туфли из ремонта', 7 * 60),
};
const parcel: ReaderQuestion = { kind: 'time', command: 'Перенеси посылку на пол 12' };
const which: ReaderQuestion = { kind: 'which', command: 'Перенеси дело на пол 4' };
const move: ReaderQuestion = { kind: 'move', title: 'Забрать посылку' };
const attach: ReaderQuestion = { kind: 'attach', title: 'Записать Мишу к стоматологу' };

const reading = (kind: ReaderReading['kind'], choice = '', thought = ''): ReaderReading => ({
  kind,
  choice,
  thought,
});

describe('час: выбор модели — из предложенного или прочитанный кодом', () => {
  it.each<[string, string, number]>([
    ['После работы', '19:00', 19 * 60],
    ['Утром не получится, вечером', '19:00', 19 * 60],
    ['До работы', '07:00', 7 * 60],
    ['Не утром', '19:00', 19 * 60],
  ])('«%s» → %s', (reply, choice, expected) => {
    const meaning = checkReading(shoes, reply, reading('answer', choice));

    expect(meaning.kind).toBe('answer');
    const command = meaning.kind === 'answer' ? (meaning.command ?? '') : '';
    expect(clockTimesIn(command)).toEqual([[expected]]);
    // Дня в команде нет — ответ меняет только час.
    expect(hourWithoutDay(command)).toBe(true);
  });

  it('у переноса — свои два варианта: «Днём, в обед почти» → 11:30', () => {
    const meaning = checkReading(parcel, 'Днём, в обед почти', reading('answer', '11:30'));
    expect(meaning.kind === 'answer' && clockTimesIn(meaning.command ?? '')).toEqual([[690]]);
  });

  it('свой час — только если код читает его в реплике: «В восемь вечера» → 20:00', () => {
    expect(checkReading(shoes, 'В восемь вечера', reading('answer', '20:00')).kind).toBe('answer');
  });

  it.each<[string, string]>([
    ['После работы', '20:00'],
    ['Вечером', '18:30'],
    ['Вечером', 'вечер'],
    ['Вечером', ''],
  ])('«%s» → «%s»: ни предложено, ни сказано — не прочитано', (reply, choice) => {
    expect(checkReading(shoes, reply, reading('answer', choice)).kind).toBe('unread');
  });
});

describe('новое дело не становится ответом', () => {
  it.each([
    'Вечером позвонить маме',
    'Позвонить в банк вечером',
    'Купить хлеб вечером',
    'Вечером надо полить цветы',
  ])('«%s» — модель сказала «ответ 19:00», код не верит', (reply) => {
    expect(checkReading(shoes, reply, reading('answer', '19:00')).kind).toBe('unread');
  });

  it('слова самого дела — не новое дело: «Вечером забрать» → 19:00', () => {
    expect(checkReading(shoes, 'Вечером забрать', reading('answer', '19:00')).kind).toBe('answer');
  });

  it('числа словами — не глаголы: «В девять вечера» не новое дело', () => {
    expect(checkReading(shoes, 'Часов в девять вечера', reading('answer', '21:00')).kind).toBe(
      'answer',
    );
  });
});

describe('ответ и новая мысль', () => {
  it.each<[string, string, string]>([
    ['Вечером. И купить хлеб', '19:00', 'И купить хлеб'],
    ['Вечером, и ещё надо позвонить маме', '19:00', 'надо позвонить маме'],
    ['Туфли вечером, а завтра к врачу записаться', '19:00', 'завтра к врачу записаться'],
    ['Утром. И отчёт не забыть сдать в пятницу', '07:00', 'И отчёт не забыть сдать в пятницу'],
  ])('«%s» → %s + «%s»', (reply, choice, thought) => {
    const meaning = checkReading(shoes, reply, reading('answer', choice, thought));
    expect(meaning).toMatchObject({ kind: 'answer', thought });
  });

  it.each<[string, string]>([
    // Мысли в реплике нет — модель её придумала.
    ['Вечером. И купить хлеб', 'купить молоко'],
    // Мысль — вся реплика: ответа не осталось.
    ['Вечером купить хлеб', 'Вечером купить хлеб'],
    // Мысль не отделена от ответа: «вечером» — её час, а не ответ.
    ['Позвонить маме вечером', 'Позвонить маме'],
  ])('«%s» + мысль «%s» — не прочитано', (reply, thought) => {
    expect(checkReading(shoes, reply, reading('answer', '19:00', thought)).kind).toBe('unread');
  });
});

describe('какое дело: слова дела — дословно из реплики', () => {
  it('«Ну про врача же» → команда с названным делом', () => {
    const meaning = checkReading(
      { kind: 'which', command: 'Перенеси дело на пол 4' },
      'Ну про посылку же',
      reading('answer', 'про посылку'),
    );
    expect(meaning).toMatchObject({
      kind: 'answer',
      command: 'Перенеси дело на пол 4 — про посылку',
    });
  });

  it.each<[string, string]>([
    ['Ну посылку же', 'хлеб'],
    ['Спасибо', 'Спасибо'],
    ['Не помню', 'Не помню'],
  ])('«%s» → «%s» — не прочитано', (reply, choice) => {
    expect(checkReading(which, reply, reading('answer', choice)).kind).toBe('unread');
  });
});

describe('перенести и прежнее-отдельное: выбор из двух', () => {
  it.each<[ReaderQuestion, string, string]>([
    [move, 'Ну давай, переноси уже', 'да'],
    [move, 'Не, это не то', 'нет'],
    [attach, 'Это тоже про Мишу', 'к прошлой'],
    [attach, 'Это про Диму вообще', 'отдельно'],
  ])('%#: «%s» → %s', (question, reply, choice) => {
    expect(checkReading(question, reply, reading('answer', choice))).toMatchObject({
      kind: 'answer',
      choice,
    });
  });

  it.each<[ReaderQuestion, string, string]>([
    [move, 'Да', 'наверное'],
    [attach, 'Да', 'да'],
    // Новое дело не может быть согласием (живой прогон 03.09.2026).
    [move, 'Добавь ещё купить чехол для зонта', 'да'],
  ])('%#: «%s» → «%s» — не прочитано', (question, reply, choice) => {
    expect(checkReading(question, reply, reading('answer', choice)).kind).toBe('unread');
  });
});

describe('встречный вопрос, не решил, двояко', () => {
  it.each(['В 7 чего', 'Какие туфли?', 'В смысле', 'Не поняла вопрос'])(
    'встречный: «%s»',
    (reply) => {
      expect(checkReading(shoes, reply, reading('counter_question')).kind).toBe('counter_question');
    },
  );

  it('встречный без вопроса в словах — не прочитано: «Купить хлеб»', () => {
    expect(checkReading(shoes, 'Купить хлеб', reading('counter_question')).kind).toBe('unread');
  });

  it.each(['Не знаю пока', 'Потом скажу', 'Без разницы'])('не решил: «%s»', (reply) => {
    expect(checkReading(shoes, reply, reading('undecided')).kind).toBe('undecided');
  });

  it('«не решил» с новым делом — не прочитано: мысль бы пропала', () => {
    expect(checkReading(shoes, 'Не знаю, надо ещё позвонить маме', reading('undecided')).kind).toBe(
      'unread',
    );
  });

  it.each(['Давай в 8', 'Пораньше'])('двояко: «%s»', (reply) => {
    expect(checkReading(shoes, reply, reading('ambiguous')).kind).toBe('ambiguous');
  });

  it('не ответ — не ответ', () => {
    expect(checkReading(shoes, 'Купить молоко', reading('not_answer')).kind).toBe('not_answer');
  });
});

describe('вход модели', () => {
  it('вопрос бота своими словами, вид с вариантами, реплика', () => {
    const input = readerInput(shoes, defaultTexts, 'После работы', 'В субботу в 7 забрать туфли.');

    expect(input).toContain('Во сколько «Забрать туфли из ремонта» — 07:00 или 19:00?');
    expect(input).toContain('Вид: час (07:00 или 19:00)');
    expect(input).toContain('До этого: В субботу в 7 забрать туфли.');
    expect(input).toContain('Ответ: После работы');
  });

  it('у переноса — «11:30 или 23:30»', () => {
    expect(readerInput(parcel, defaultTexts, 'Днём')).toContain('Вид: час (11:30 или 23:30)');
  });
});

describe('обращение к модели', () => {
  it('модель не ответила или ответила не по схеме — не прочитано, без исключения', async () => {
    const failing = await readReply(
      {} as never,
      { question: shoes, reply: 'После работы', texts: defaultTexts },
      () => Promise.reject(new Error('сеть')),
    );
    expect(failing.kind).toBe('unread');

    const bad = await readReply(
      {} as never,
      { question: shoes, reply: 'После работы', texts: defaultTexts },
      () => Promise.resolve({ ok: false, problem: 'не JSON', attempts: 2 } as never),
    );
    expect(bad.kind).toBe('unread');
  });

  it('ответ модели проходит через проверку кодом', async () => {
    const read = await readReply(
      {} as never,
      { question: shoes, reply: 'После работы', texts: defaultTexts },
      () =>
        Promise.resolve({
          ok: true,
          value: reading('answer', '19:00'),
          promptVersion: 'reader@1',
          attempts: 1,
        } as never),
    );
    expect(read.kind).toBe('answer');
  });
});

describe('«не знаю» ответом с выбором не бывает', () => {
  it.each(['Не знаю пока', 'Потом скажу', 'Без разницы', 'Да всё равно'])(
    '«%s» — модель выбрала 07:00, код не верит',
    (reply) => {
      expect(checkReading(shoes, reply, reading('answer', '07:00')).kind).toBe('unread');
    },
  );

  it('«Не знаю» на «Перенести?» — не «да»', () => {
    expect(checkReading(move, 'Не знаю даже', reading('answer', 'да')).kind).toBe('unread');
  });
});
