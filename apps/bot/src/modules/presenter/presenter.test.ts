import { describe, expect, it } from 'vitest';

import { defaultTexts, profiles, textsFor } from '../../texts/index.js';
import {
  buildReply,
  composeOf,
  countQuestions,
  sanitizeAcknowledgement,
} from './presenter.service.js';

/**
 * Форма ответа на выгрузку (задача 2.11).
 *
 * §13.2 ТЗ назван частью требований, а не рекомендацией по стилю, поэтому
 * проверяется таблицей случаев: признание, ограниченный список, фраза о
 * сохранённом, ровно один вопрос, кнопки.
 *
 * Главная проверка здесь — про вопросы. Инвариант 10 и §13.9: двух
 * вопросов в реплике не бывает ни при каком сочетании входных данных.
 */

const texts = defaultTexts;

const ack = 'Я тебя услышала. Три дела и одна большая цель.';

describe('buildReply', () => {
  it('собирает ответ по §13.2: признание, список, сохранённое, один вопрос', () => {
    const reply = buildReply({
      texts,
      acknowledgement: ack,
      actions: ['Записать сына к врачу', 'Позвонить маме'],
      hidden: 5,
      tired: false,
    });

    expect(reply.text.startsWith(ack)).toBe(true);
    expect(reply.text).toContain(texts.answer.actionsLead);
    expect(reply.text).toContain('— Записать сына к врачу');
    expect(reply.text).toContain('— Позвонить маме');
    expect(reply.text).toContain(texts.answer.restSaved);
    expect(reply.text.endsWith(texts.answer.question)).toBe(true);
    expect(countQuestions(reply.text)).toBe(1);
  });

  it('три кнопки из §13.2 в заданном порядке', () => {
    const reply = buildReply({
      texts,
      acknowledgement: ack,
      actions: ['Дело'],
      hidden: 1,
      tired: false,
    });

    expect(reply.buttons.map((button) => button.label)).toEqual([
      texts.answer.buttonDoNow,
      texts.answer.buttonShowAll,
      texts.answer.buttonLater,
    ]);
  });

  it('одно дело — другая подводка: §13.7 предлагает только самое главное', () => {
    const single = buildReply({
      texts,
      acknowledgement: ack,
      actions: ['Дело'],
      hidden: 0,
      tired: false,
    });
    const many = buildReply({
      texts,
      acknowledgement: ack,
      actions: ['Дело', 'Другое'],
      hidden: 0,
      tired: false,
    });

    expect(single.text).toContain(texts.answer.actionsLeadSingle);
    expect(many.text).toContain(texts.answer.actionsLead);
  });

  it('нечего скрывать — фраза о сохранённом не врёт', () => {
    // «Остальное никуда не убежит» при пустом остатке — обещание про то,
    // чего нет. Мелочь, но именно на таких мелочах доверие и теряется.
    const nothing = buildReply({
      texts,
      acknowledgement: ack,
      actions: ['Дело'],
      hidden: 0,
      tired: false,
    });
    const something = buildReply({
      texts,
      acknowledgement: ack,
      actions: ['Дело'],
      hidden: 3,
      tired: false,
    });

    expect(nothing.text).toContain(texts.answer.nothingHidden);
    expect(nothing.text).not.toContain(texts.answer.restSaved);
    expect(something.text).toContain(texts.answer.restSaved);
  });

  it('при усталости объём сокращается, а разговор закрывается без вопроса', () => {
    // §13.7: короткое признание, одно действие, выход из разговора.
    // В эталонном ответе ТЗ фразы о сохранённом нет вовсе.
    const reply = buildReply({
      texts,
      acknowledgement: texts.answer.acknowledgementTiredFallback,
      actions: ['Записать сына к врачу'],
      hidden: 9,
      tired: true,
    });

    expect(reply.text).toContain(texts.answer.closingTired);
    expect(reply.text).not.toContain(texts.answer.restSaved);
    expect(reply.text).not.toContain(texts.answer.question);
    expect(countQuestions(reply.text)).toBe(0);
    expect(reply.buttons.map((button) => button.label)).toEqual([
      texts.answer.buttonDoNow,
      texts.answer.buttonLater,
    ]);
  });

  it('действий нет — вопрос другой, но всё равно один', () => {
    const reply = buildReply({ texts, acknowledgement: ack, actions: [], hidden: 4, tired: false });

    expect(reply.text).toContain(texts.answer.nothingUrgent);
    expect(reply.text).toContain(texts.answer.questionEmotionOnly);
    expect(countQuestions(reply.text)).toBe(1);
    expect(reply.buttons.map((button) => button.label)).toEqual([
      texts.answer.buttonShowAll,
      texts.answer.buttonLater,
    ]);
  });

  it('ни дел, ни остатка — не обещает того, чего нет', () => {
    const reply = buildReply({ texts, acknowledgement: ack, actions: [], hidden: 0, tired: false });

    expect(reply.text).toContain(texts.answer.nothingHidden);
    expect(reply.text).not.toContain(texts.answer.nothingUrgent);
  });

  it('ни при каком сочетании не бывает двух вопросов', () => {
    // Инвариант 10. Проверяется перебором, а не примером: правило легко
    // нарушить, добавив фразу с вопросительным знаком в словарь.
    for (const actions of [[], ['Одно'], ['Одно', 'Два'], ['Одно', 'Два', 'Три']]) {
      for (const hidden of [0, 1, 7]) {
        for (const tired of [false, true]) {
          for (const profile of Object.keys(profiles)) {
            const reply = buildReply({
              texts: textsFor(profile),
              acknowledgement: ack,
              actions,
              hidden,
              tired,
            });

            expect(countQuestions(reply.text)).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});

describe('sanitizeAcknowledgement', () => {
  it('годное признание пропускает как есть', () => {
    const result = sanitizeAcknowledgement(`  ${ack}  `, texts, { tired: false });

    expect(result.text).toBe(ack);
    expect(result.replaced).toBe(false);
  });

  it('вопрос в признании заменяется: иначе в реплике два вопроса', () => {
    const result = sanitizeAcknowledgement('Услышала. С чего начнём?', texts, { tired: false });

    expect(result.replaced).toBe(true);
    expect(result.text).toBe(texts.answer.acknowledgementFallback);
  });

  it('при усталости подставляется своя замена', () => {
    const result = sanitizeAcknowledgement('', texts, { tired: true });

    expect(result.text).toBe(texts.answer.acknowledgementTiredFallback);
  });

  it.each([
    ['Поняла. Тебе бы отдохнуть.', 'совет отдохнуть'],
    ['Слышу. Попробуй подышать минуту.', 'совет подышать'],
    ['Это похоже на выгорание.', 'рассуждение о выгорании'],
    ['Ты слишком много на себя берёшь.', 'объяснение состояния'],
    ['Спасибо, что поделилась.', 'благодарность за откровенность'],
    ['Ты молодец.', 'похвала без повода'],
    ['Не переживай, всё будет хорошо.', 'утешение'],
  ])('запрещённое §13.7 заменяется: %s', (raw) => {
    // §13.7 — прямое требование заказчика: бот не работает терапевтом.
    // Промпт об этом просит, но промпт — просьба, а не гарантия.
    const result = sanitizeAcknowledgement(raw, texts, { tired: true });

    expect(result.replaced).toBe(true);
    expect(result.reason).toContain('§13.7');
  });

  it('несколько строк, длинное и эмодзи — тоже замена', () => {
    expect(sanitizeAcknowledgement('Первая\nвторая', texts, { tired: false }).replaced).toBe(true);
    expect(sanitizeAcknowledgement('а'.repeat(201), texts, { tired: false }).replaced).toBe(true);
    expect(sanitizeAcknowledgement('Услышала 🙂', texts, { tired: false }).replaced).toBe(true);
  });

  it('«ванна» в деле законна, «прими ванну» — нет', () => {
    // Запрет на слова вместо фраз ловил бы «купить ванну» и заменял
    // годное признание. Правило, которое врёт, потом отключают целиком.
    expect(
      sanitizeAcknowledgement('Услышала. Дела по дому и ванна.', texts, { tired: false }).replaced,
    ).toBe(false);
    expect(sanitizeAcknowledgement('Прими ванну и ложись.', texts, { tired: false }).replaced).toBe(
      true,
    );
  });
});

describe('composeOf', () => {
  it('считает состав выгрузки по типам', () => {
    const composition = composeOf([
      { type: 'TASK' },
      { type: 'TASK', isProject: true },
      { type: 'DESIRE' },
      { type: 'EMOTION' },
      { type: 'INFO' },
    ]);

    expect(composition).toEqual({
      tasks: 2,
      desires: 1,
      ideas: 0,
      infos: 1,
      emotions: 1,
      hasProject: true,
    });
  });

  it('признак проекта у не-задачи в состав не идёт', () => {
    // §5.1: проект — поле у TASK. Классификация это уже приводит в
    // согласие, но состав не должен зависеть от чужой аккуратности.
    expect(composeOf([{ type: 'IDEA', isProject: true }]).hasProject).toBe(false);
  });
});

describe('словарь', () => {
  it('в текстах ответа нет формулировок, запрещённых §13.7', () => {
    // Проверка направлена на нас, а не на модель: запрещённая фраза,
    // попавшая в словарь, прошла бы все остальные проверки.
    for (const profile of Object.values(profiles)) {
      for (const value of Object.values(profile.answer)) {
        if (typeof value !== 'string') continue;

        const result = sanitizeAcknowledgement(value, profile, { tired: false });
        // Вопросы в словаре законны — это наш единственный вопрос.
        if (value.includes('?')) continue;

        expect(result.replaced, `«${value}»`).toBe(false);
      }
    }
  });

  it('неизвестный профиль не роняет ответ', () => {
    // Человек в этот момент ждёт разбор своей выгрузки. Отказ ради
    // опечатки в настройке был бы обменом важного на неважное.
    expect(textsFor('тёплый-которого-нет')).toBe(textsFor('reserved'));
    expect(textsFor(null)).toBe(textsFor(undefined));
  });
});
