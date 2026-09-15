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
  buildActionsReply,
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
  const batchId = '22222222-2222-4222-8222-222222222222';

  it('после разбора — признание, вопрос «оставить или выбрать» и две кнопки (решение заказчицы 15.09.2026)', () => {
    /**
     * §13.2 её ТЗ показывал под признанием до трёх дел и спрашивал «с
     * чего начнём». 15.09.2026 она решила иначе: «после разбора действия
     * автоматически не показываем; сначала результат разбора и кнопки
     * „Оставить как есть“ / „Выбрать главное“; только по „Выбрать
     * главное“ — 2–3 пункта». Результат разбора — само признание: оно
     * называет состав выгрузки.
     */
    const reply = buildReply({ texts, acknowledgement: ack, batchId });

    expect(reply.text).toBe(`${ack}\n\n${texts.answer.keepOrPick}`);
    expect(reply.text).not.toContain(texts.answer.actionsLead);
    expect(countQuestions(reply.text)).toBe(1);
    expect(reply.buttons.map((button) => button.label)).toEqual([
      texts.answer.buttonKeep,
      texts.answer.buttonPick,
    ]);
  });

  it('«Выбрать главное» несёт код выгрузки: сказанное в ней идёт первым', () => {
    // По коду обработчик восстанавливает «упомянутое в выгрузке» — очередь
    // выдачи ставит его вперёд (задача 3.24).
    const reply = buildReply({ texts, acknowledgement: ack, batchId });

    expect(reply.buttons[1]?.action).toBe(`${ANSWER_ACTION.pick}:${toShortId(batchId)}`);
    expect(reply.buttons[0]?.action).toBe(ANSWER_ACTION.keep);
  });

  it('без кода выгрузки — общее действие, а не пустой код', () => {
    const reply = buildReply({ texts, acknowledgement: ack });

    expect(reply.buttons[1]?.action).toBe(ANSWER_ACTION.pick);
  });

  it('впереди вопрос опроса — своей строки с вопросом нет, кнопки остаются', () => {
    // §13.9: один открытый вопрос на обмен. Кнопки — не вопрос, а выход
    // к делам, и без них первая выгрузка осталась бы без «Выбрать главное».
    const reply = buildReply({ texts, acknowledgement: ack, batchId, omitQuestion: true });

    expect(reply.text).toBe(ack);
    expect(countQuestions(reply.text)).toBe(0);
    expect(reply.buttons).toHaveLength(2);
  });

  it('одни чувства при непустом бэклоге: только признание — без дел, вопроса и кнопок', () => {
    /**
     * Решение заказчицы 13.09.2026 (ответ 1.4) и правка 14.09.2026
     * (п. 1.5): поделилась состоянием — в ответ не выдают задачи и не
     * превращают сказанное в продуктивность; «отвечаем коротко и
     * спокойно» — ни вопроса, ни кнопок к делам.
     */
    const reply = buildReply({ texts, acknowledgement: ack, batchId, feelingsOnly: true });

    expect(reply.text).toBe(ack);
    expect(countQuestions(reply.text)).toBe(0);
    expect(reply.buttons).toEqual([]);
  });

  it('ни при каком сочетании не бывает двух вопросов', () => {
    // Инвариант 10. Проверяется перебором, а не примером: правило легко
    // нарушить, добавив фразу с вопросительным знаком в словарь.
    for (const omitQuestion of [false, true]) {
      for (const feelingsOnly of [false, true]) {
        for (const profile of Object.keys(profiles)) {
          const reply = buildReply({
            texts: textsFor(profile),
            acknowledgement: ack,
            batchId,
            omitQuestion,
            feelingsOnly,
          });

          expect(countQuestions(reply.text)).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('buildActionsReply — по кнопке «Выбрать главное»', () => {
  it('собирает список по §13.2: подводка, пункты, сохранённое — без вопроса', () => {
    const reply = buildActionsReply({
      texts,
      actions: ['Записать сына к врачу', 'Позвонить маме'],
      hidden: 5,
    });

    expect(reply.text).toContain(texts.answer.actionsLead);
    expect(reply.text).toContain('— Записать сына к врачу');
    expect(reply.text).toContain('— Позвонить маме');
    expect(reply.text).toContain(texts.answer.restSaved);
    // Вопрос уже был задан кнопками; здесь человек получил ответ.
    expect(countQuestions(reply.text)).toBe(0);
  });

  it('«Сделать сейчас» ведёт к первому показанному делу, а не к «первому на сегодня» (ревизия этапа 3, E2)', () => {
    const reply = buildActionsReply({
      texts,
      actions: ['Позвонить маме', 'Купить хлеб'],
      firstItemId: '11111111-1111-4111-8111-111111111111',
      hidden: 0,
    });

    expect(reply.buttons[0]?.action).toBe(
      `${ANSWER_ACTION.now}:${toShortId('11111111-1111-4111-8111-111111111111')}`,
    );
  });

  it('три кнопки из §13.2 в заданном порядке', () => {
    const reply = buildActionsReply({ texts, actions: ['Одно'], hidden: 2 });

    expect(reply.buttons.map((button) => button.label)).toEqual([
      texts.answer.buttonDoNow,
      texts.answer.buttonShowAll,
      texts.answer.buttonLater,
    ]);
  });

  it('одно дело — другая подводка', () => {
    const reply = buildActionsReply({ texts, actions: ['Одно'], hidden: 0 });

    expect(reply.text).toContain(texts.answer.actionsLeadSingle);
    expect(reply.text).not.toContain(texts.answer.actionsLead);
  });

  it('нечего скрывать — фраза о сохранённом не врёт', () => {
    const reply = buildActionsReply({ texts, actions: ['Одно', 'Два'], hidden: 0 });

    expect(reply.text).toContain(texts.answer.nothingHidden);
    expect(reply.text).not.toContain(texts.answer.restSaved);
  });

  it('выбирать не из чего — короткий ответ без кнопок', () => {
    const reply = buildActionsReply({ texts, actions: [], hidden: 0 });

    expect(reply.text).toBe(texts.answer.nothingToPick);
    expect(reply.buttons).toEqual([]);
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

    // Ответ на выгрузку: признание (словарная замена при молчании модели)
    // и вопрос «оставить или выбрать».
    for (const tired of [false, true]) {
      const acknowledgement = sanitizeAcknowledgement('', texts, { tired }).text;
      const built = buildReply({ texts, acknowledgement, batchId: undefined });

      most = Math.max(most, countQuestions(built.text));
    }

    // Список по кнопке «Выбрать главное» — своего вопроса не несёт.
    for (const actions of [[], ['Одно'], ['Одно', 'Два'], ['Одно', 'Два', 'Три']]) {
      for (const hidden of [0, 1, 7]) {
        const built = buildActionsReply({ texts, actions, hidden });

        most = Math.max(most, countQuestions(built.text));
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

    // Перебор не пустой: реплика, стоящая рядом с вопросом, в нём есть.
    // Прежде это была `restSaved` (дефект ревизии второго этапа); с
    // решением заказчицы 15.09.2026 рядом с вопросом стоит признание.
    expect(checked).toContain('answer.acknowledgementFallback');
  });

  it('правка без вопроса проходит запись и в ответе остаётся один вопрос', () => {
    // Обратная сторона: правило, которое не пропускает ничего, кончается
    // тем, что его снимают целиком.
    const said = 'Я тебя услышала, всё записала.';

    expect(refusalFor(said, 0, 'answer.acknowledgementFallback')).toBeUndefined();

    applyOverrides(new Map([['answer.acknowledgementFallback', said]]));

    const texts = textsFor();
    const built = buildReply({
      texts,
      acknowledgement: sanitizeAcknowledgement('', texts, { tired: false }).text,
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
