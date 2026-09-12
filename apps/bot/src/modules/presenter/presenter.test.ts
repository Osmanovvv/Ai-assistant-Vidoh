import { afterEach, describe, expect, it } from 'vitest';

import { applyOverrides, defaultTexts, profiles, textsFor } from '../../texts/index.js';
import {
  contentRefusal,
  editableReplies,
  refusalFor,
  type Reply as DictionaryReply,
} from '../../texts/rules.js';
import { toShortId } from '../shared/short-id.js';
import {
  ANSWER_ACTION,
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

  it('«Сделать сейчас» ведёт к первому показанному делу, а не к «первому на сегодня» (ревизия этапа 3, E2)', () => {
    /**
     * Ответ строится очередью выдачи с упомянутым в выгрузке; «Сегодня»
     * — другой очередью. Три бессрочных дела из выгрузки в ответе есть,
     * а в «Сегодня» нет — и кнопка отвечала «На сегодня ничего срочного»
     * под только что показанным списком.
     */
    const reply = buildReply({
      texts,
      acknowledgement: ack,
      actions: ['Позвонить маме', 'Купить хлеб'],
      firstItemId: '11111111-1111-4111-8111-111111111111',
      hidden: 0,
      tired: false,
    });

    expect(reply.buttons[0]?.action).toBe(
      `${ANSWER_ACTION.now}:${toShortId('11111111-1111-4111-8111-111111111111')}`,
    );
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
    const reply = buildReply({
      texts,
      acknowledgement: texts.answer.acknowledgementTiredFallback,
      actions: ['Записать сына к врачу'],
      hidden: 9,
      tired: true,
    });

    expect(reply.text).toContain(texts.answer.closingTired);
    expect(reply.text).not.toContain(texts.answer.question);
    expect(countQuestions(reply.text)).toBe(0);
  });

  it('при усталости остальное всё равно обещано и достижимо', () => {
    /**
     * Прежде эта ветка молчала о сохранённом и не давала кнопки к
     * остальным делам — по эталону §13.7, где фразы о сохранённом нет.
     * Живая выгрузка проджекта 03.09.2026 показала цену: двадцать дел
     * словами «давай всё запишем, я просто хочу выдохнуть» — и в ответ
     * одно действие без единого слова о том, что остальное записано.
     *
     * §13.9 требует безусловно: «Завершение короткое: остальное
     * сохранено, держать в голове не нужно». А в главном эталоне §13.2
     * усталость названа прямо, и фраза с кнопкой «Разобрать все» там
     * есть.
     */
    const reply = buildReply({
      texts,
      acknowledgement: texts.answer.acknowledgementTiredFallback,
      actions: ['Записать сына к врачу'],
      hidden: 16,
      tired: true,
    });

    expect(reply.text).toContain(texts.answer.restSaved);
    expect(reply.buttons.map((button) => button.label)).toEqual([
      texts.answer.buttonDoNow,
      texts.answer.buttonShowAll,
      texts.answer.buttonLater,
    ]);
    // Сокращение объёма §13.7 при этом на месте: вопроса нет.
    expect(countQuestions(reply.text)).toBe(0);
  });

  it('при усталости и пустом остатке ничего не обещает', () => {
    // Обещать нечего — значит и фразы нет, и кнопки нет.
    const reply = buildReply({
      texts,
      acknowledgement: texts.answer.acknowledgementTiredFallback,
      actions: ['Записать сына к врачу'],
      hidden: 0,
      tired: true,
    });

    expect(reply.text).not.toContain(texts.answer.restSaved);
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

describe('правка из панели и склейка §13.2', () => {
  afterEach(() => {
    // Склейка живёт в модуле: не вернёшь — соседние проверки будут мерить
    // правку вместо словаря из кода.
    applyOverrides(new Map());
  });

  /** Та же реплика, но с вопросом на конце — и со всеми её подстановками. */
  const askedVersionOf = (reply: DictionaryReply): string =>
    [
      reply.said.trim(),
      ...Array.from({ length: reply.places }, (_unused, index) => `{${String(index + 1)}}`),
      'Хорошо?',
    ].join(' ');

  /** Сколько вопросов самое большее даёт сборка на словаре с правкой. */
  const mostQuestions = (): number => {
    const texts = textsFor();
    let most = 0;

    for (const actions of [[], ['Одно'], ['Одно', 'Два'], ['Одно', 'Два', 'Три']]) {
      for (const hidden of [0, 1, 7]) {
        for (const tired of [false, true]) {
          // Признание — то, что уйдёт при молчании модели: словарная замена.
          const acknowledgement = sanitizeAcknowledgement('', texts, { tired }).text;
          const built = buildReply({ texts, acknowledgement, actions, hidden, tired });

          most = Math.max(most, countQuestions(built.text));
        }
      }
    }

    return most;
  };

  it('всё, что запись пропускает, в собранном ответе не даёт двух вопросов', () => {
    /**
     * Дефект ревизии второго этапа. Правило «один „?“ на реплику»
     * смотрело на реплику, а человек читает склейку: «Остальное никуда не
     * убежит, хорошо?» проходило запись и вместе с «С чего начнём?»
     * давало два вопроса. Перебор выше этого поймать не мог — он мерил
     * словарь из кода, а правок к нему никто не применял.
     *
     * Здесь перебор идёт по словарю **с правкой**, и он двусторонний:
     * каждой правимой реплике ответа дописывается вопрос, правка кладётся
     * в словарь **мимо** записи, и если хоть в одной сборке вопросов
     * стало два — запись обязана была эту правку отвергнуть. Так список
     * реплик, стоящих рядом с вопросом, сверяется с самой сборкой, а не с
     * памятью того, кто его составлял: появись в ответе новая реплика без
     * правила — покраснеет здесь.
     */
    const checked: string[] = [];

    for (const reply of editableReplies(defaultTexts)) {
      if (!reply.path.startsWith('answer.')) continue;

      const asked = askedVersionOf(reply);

      applyOverrides(new Map([[reply.path, asked]]));

      const most = mostQuestions();
      const refusal = refusalFor(asked, reply.places, reply.path);

      if (most > 1) {
        const blame = `${reply.path}: «${asked}» даёт ${String(most)} вопроса в ответе, а запись её пропускает`;

        expect(refusal, blame).toBeDefined();
        expect(refusal ?? '', blame).toMatch(/13\.2/u);
        checked.push(reply.path);
      }
    }

    // Перебор не пустой: та самая реплика из дефекта в нём есть.
    expect(checked).toContain('answer.restSaved');
  });

  it('правка без вопроса проходит запись и в ответе остаётся один вопрос', () => {
    // Обратная сторона: правило, которое не пропускает ничего, кончается
    // тем, что его снимают целиком.
    const said = 'Остальное пока никуда не убежит, я держу.';

    expect(refusalFor(said, 0, 'answer.restSaved')).toBeUndefined();

    applyOverrides(new Map([['answer.restSaved', said]]));

    const built = buildReply({
      texts: textsFor(),
      acknowledgement: ack,
      actions: ['Одно', 'Два'],
      hidden: 3,
      tired: false,
    });

    expect(built.text).toContain(said);
    expect(countQuestions(built.text)).toBe(1);
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

  it('серия восклицательных заменяется, один восклицательный — нет', () => {
    /**
     * Дефект ревизии второго этапа. §13.9 «восклицательные не идут
     * сериями» стерёг словарь и правку из панели, а признание — тот
     * единственный кусок ответа, который пишет модель, — нет:
     * «Услышала!! Ну и денёк.» уходило человеку. Причина названа тем же
     * параграфом, что и в отказе на записи, — так у правила один дом.
     */
    const shouted = sanitizeAcknowledgement('Услышала!! Ну и денёк.', texts, { tired: false });

    expect(shouted.replaced).toBe(true);
    expect(shouted.text).toBe(texts.answer.acknowledgementFallback);
    expect(shouted.reason).toContain('§13.9');

    // Один восклицательный законен: правило про серии, а не про знак.
    expect(sanitizeAcknowledgement('Услышала! Три дела.', texts, { tired: false }).replaced).toBe(
      false,
    );
  });

  it('общее правило §13 — то же, что судит правку в панели, слово в слово', () => {
    /**
     * Связка, а не наличие строки. Презентер обязан **звать** общее
     * правило, а не переписывать его своими словами: иначе следующее
     * правило §13 приедет в панель и не приедет сюда — ровно так
     * потерялась серия восклицательных. Если презентер заведёт свою
     * копию, причина разойдётся с панельной — и здесь покраснеет.
     */
    for (const raw of [
      'Услышала!! Ну и денёк.',
      'Поняла. Тебе бы отдохнуть.',
      'Услышала 🙂',
      'Разобрать дела? Или хватит?',
    ]) {
      const shared = contentRefusal(raw);

      expect(shared, raw).toBeDefined();
      expect(sanitizeAcknowledgement(raw, texts, { tired: false }).reason, raw).toBe(shared);
    }
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
