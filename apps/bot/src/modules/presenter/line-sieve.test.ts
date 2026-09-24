import { describe, expect, it } from 'vitest';

import type { ContextPack } from './context-pack.js';
import { hooksOf, siftLine } from './line-sieve.js';

/**
 * Сито живой строки (Никита 25.09.2026: «нам нельзя, чтобы фиговые фразы
 * были»). Страж по чёрному списку ловит только то, что уже встречалось;
 * сито пропускает только слова фактов и словаря бота — и только строку о
 * поводе. Хорошие строки — со стенда и из примеров промпта; плохие — с
 * боя 24.09.2026 и со стенда.
 */
const base: ContextPack = {
  name: 'Оля',
  partOfDay: 'вечер',
  daysSinceLast: 0,
  recorded: [{ title: 'купить хлеб', topic: 'покупки', due: undefined }],
  alreadyKnown: [],
  overdue: [],
  today: [],
  projects: [],
  doneRecently: [],
  openTotal: 14,
};

const overdue: ContextPack = {
  ...base,
  overdue: [{ title: 'забрать справку из поликлиники', daysLate: 6 }],
};

/** Вход трёх строк с боя 24.09.2026 18:59–19:01 — собран боевым `packContext`. */
const battle: ContextPack = {
  ...base,
  name: 'Лера',
  recorded: [{ title: 'Поехать за ребёнком', topic: 'семья', due: 'завтра' }],
  projects: ['Наладить жизнь', 'За осень сделать ремонт в спальне: обои, потолок, шторы'],
  openTotal: 79,
};

const passes = (line: string, pack: ContextPack): void => {
  expect(siftLine(line, pack), line).toEqual({ ok: true });
};
const fails = (line: string, pack: ContextPack): string => {
  const sifted = siftLine(line, pack);
  expect(sifted.ok, line).toBe(false);
  return sifted.ok ? '' : sifted.why;
};

describe('поводы строки — семь, как в промпте презентера', () => {
  it('каждый повод виден по фактам', () => {
    expect(hooksOf(base)).toEqual([]);
    expect(hooksOf({ ...base, alreadyKnown: ['купить хлеб'] })).toEqual(['known']);
    expect(hooksOf(overdue)).toEqual(['overdue']);
    expect(hooksOf({ ...base, today: [{ title: 'сдать отчёт' }] })).toEqual(['today']);
    expect(hooksOf({ ...base, doneRecently: ['найти няню'] })).toEqual(['done']);
    expect(hooksOf({ ...base, projects: ['сделать ремонт'] })).toEqual(['goals']);
    expect(hooksOf({ ...base, daysSinceLast: 3 })).toEqual(['silence']);
    expect(hooksOf({ ...base, daysSinceLast: 2 })).toEqual([]);
    expect(hooksOf({ ...base, daysSinceLast: undefined })).toEqual(['first']);
  });
});

describe('сито живой строки: только слова фактов и словаря бота, и только о поводе', () => {
  it('хорошие строки стенда и примеры промпта проходят', () => {
    passes('Про справку из поликлиники помню — запись на месте, никуда не делась.', overdue);
    passes('Справка из поликлиники всё ещё ждёт — помню про неё.', overdue);
    passes('Справка всё ещё ждёт — уже 6 дней.', overdue);
    passes('Про справку из поликлиники помню — она всё ещё не закрыта.', overdue);

    const kindergarten: ContextPack = {
      ...base,
      overdue: [{ title: 'оплатить садик', daysLate: 3 }],
      mood: 'heavy',
    };
    passes('Садик ждёт оплаты уже три дня — помню про него.', kindergarten);
    passes('Про оплату садика помню — запись никуда не делась.', kindergarten);

    passes('Стоматолога ты уже записывала — запись одна, вторую не завела.', {
      ...base,
      recorded: [{ title: 'записаться к стоматологу', topic: 'здоровье', due: undefined }],
      alreadyKnown: ['записаться к стоматологу'],
    });
    passes(
      'Про справку из поликлиники помню — запись никуда не делась. Про звонок в банк ты уже записывала — повторной записи не завела.',
      {
        ...overdue,
        recorded: [{ title: 'позвонить в банк', topic: 'финансы', due: undefined }],
        alreadyKnown: ['позвонить в банк'],
      },
    );

    passes('Про отчёт к 21:00 помню.', {
      ...base,
      today: [{ title: 'сдать отчёт', time: '21:00' }],
    });
    passes('Про отчёт и заказ помню.', {
      ...base,
      today: [{ title: 'сдать отчёт' }, { title: 'забрать заказ' }],
    });
    passes('Няню ты нашла — тот вопрос закрыт.', { ...base, doneRecently: ['найти няню'] });
    passes('Обои и шторы — это к ремонту спальни, помню про него.', {
      ...base,
      recorded: [
        { title: 'купить обои', topic: 'дом', due: undefined },
        { title: 'купить шторы', topic: 'дом', due: undefined },
      ],
      projects: ['сделать ремонт в спальне'],
    });
    passes('Про справку и учительницу помню — записи на месте.', {
      ...overdue,
      overdue: [...overdue.overdue, { title: 'написать учительнице', daysLate: 2 }],
    });

    const silence = { ...base, daysSinceLast: 5 };
    passes('Пять дней тишины — теперь всё здесь.', silence);
    passes('Пять дней тишины — теперь все твои дела здесь.', silence);
    passes('Несколько дней тишины — значит, голова была занята другим. Теперь это здесь.', silence);
    passes('Первый раз — дальше можно просто скидывать сюда, как приходит в голову.', {
      ...base,
      daysSinceLast: undefined,
    });
  });

  it('её слова о характере бота — тоже словарь: «держу в голове», «лежит у меня»', () => {
    passes('Про справку помню — держу в голове.', overdue);
    passes('Справка лежит у меня, никуда не делась.', overdue);
  });

  it('строки с боя 24.09.2026 отсекаются', () => {
    expect(fails('Ряженка — хорошее дополнение к осеннему вечеру.', battle)).toMatch(
      /^слово не из фактов/u,
    );
    expect(fails('Поняла, что поездка за ребёнком запланирована на завтра.', battle)).toMatch(
      /^слово не из фактов/u,
    );
    fails('Забрать ребёнка завтра — важное дело, помню про него.', battle);
    fails(
      'Записала, что завтра забрать ребёнка в семь. Это к налаженной жизни, помню про неё.',
      battle,
    );
    fails('Ряженка — к осеннему вечеру, помню про твои большие цели.', battle);
  });

  it('строка «ради строки» — её слов нет в словаре: «снова ты со мной», «всё на виду»', () => {
    fails('Вчерашняя выгрузка была — сегодня снова ты со мной.', overdue);
    fails('Сегодня снова всё на виду.', overdue);
    fails('Вижу, что ты вернулась.', overdue);
  });

  it('выдуманная подробность её жизни — слова нет в фактах', () => {
    expect(fails('Про справку помню — к ужину успеешь.', overdue)).toMatch(/^слово не из фактов/u);
    expect(fails('Справка для детей всё ещё ждёт.', overdue)).toMatch(/^слово не из фактов/u);
  });

  it('строка только о записанном сейчас — пересказ, а не повод; даже при тишине', () => {
    expect(fails('Хлеб купить — помню.', overdue)).toBe('не о поводе');
    expect(
      fails('Поехать за ребёнком — завтра, помню.', { ...battle, projects: [], daysSinceLast: 5 }),
    ).toBe('не о поводе');
  });

  it('при одних больших целях строка обязана назвать цель', () => {
    expect(fails('Про ребёнка помню — завтра.', battle)).toBe('не о поводе');
    passes('Про ремонт в спальне помню — запись на месте.', battle);
  });

  it('служебное слово из названия дела не открывает всё, что с него начинается', () => {
    const shortWords: ContextPack = {
      ...base,
      overdue: [{ title: 'сдать ремонт под ключ', daysLate: 2 }],
    };
    passes('Про ремонт под ключ помню.', shortWords);
    expect(fails('Про ремонт помню — подарок подождёт.', shortWords)).toMatch(
      /^слово не из фактов: подарок/u,
    );
  });

  it('«закрыт» без закрытых дел в фактах — неправда; «не закрыта» — можно', () => {
    fails('Справка закрыта — помню.', overdue);
    passes('Про справку помню — она всё ещё не закрыта.', overdue);
    passes('Справку ты забрала — тот вопрос закрыт.', {
      ...base,
      doneRecently: ['забрать справку'],
    });
  });
});
