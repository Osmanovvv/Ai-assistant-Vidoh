import { describe, expect, it } from 'vitest';

import { defaultTexts, profiles } from '../../texts/index.js';
import {
  chosenFromLabels,
  decodeTopicOffer,
  encodeTopicOffer,
  firstStep,
  offerTopicsQuestion,
  questionFor,
  timezoneQuestion,
  topicRows,
  ACTION,
  MORNING_TIMES,
  EVENING_TIMES,
  STEP,
  TIMEZONES,
  TOPIC_CHOICES,
  type Question,
} from './onboarding.service.js';

/**
 * Онбординг (задача 2.13).
 *
 * Главное, что проверяется здесь, — два правила, которые легко нарушить
 * незаметно: один вопрос в реплике (§13.9) и предел в 64 байта на
 * `callback_data`. Второе не всплывёт на «да» и «нет», а всплывёт на
 * названии часового пояса, и уже в бою.
 */

const texts = defaultTexts;

const name = 'Аня';

/**
 * Каждая реплика онбординга по одному разу: шаги плюс список городов.
 *
 * Клавиатура сфер с отметками сюда не идёт: это та же клавиатура шага,
 * только перерисованная, и в проверке на неповторяемость она дала бы
 * ложное совпадение сама с собой.
 */
function everyQuestion(): Question[] {
  const questions: Question[] = [];

  for (const step of Object.values(STEP)) {
    const question = questionFor(step, { texts, name });
    if (question) questions.push(question);
  }

  questions.push(timezoneQuestion(texts));

  return questions;
}

describe('вопросы', () => {
  it('на каждый шаг, кроме завершения, есть вопрос', () => {
    expect(questionFor(STEP.name, { texts, name })).toBeDefined();
    expect(questionFor(STEP.timezone, { texts, name })).toBeDefined();
    expect(questionFor(STEP.morning, { texts, name })).toBeDefined();
    expect(questionFor(STEP.evening, { texts, name })).toBeDefined();
    expect(questionFor(STEP.topics, { texts, name })).toBeDefined();

    expect(questionFor(STEP.done, { texts, name })).toBeUndefined();
    expect(questionFor(0, { texts, name })).toBeUndefined();
  });

  it('перерисованная клавиатура сфер не меняет идентификаторов кнопок', () => {
    // Отметка меняет подпись, но не действие: иначе повторное нажатие
    // на уже отмеченную сферу уходило бы в никуда.
    const plain = topicRows(texts, [])
      .flat()
      .map((button) => button.action);
    const marked = topicRows(texts, ['семья', 'работа'])
      .flat()
      .map((button) => button.action);

    expect(marked).toEqual(plain);
  });

  it('в каждой реплике не больше одного вопроса', () => {
    // Инвариант 10 и §13.9. Нарушить легко: достаточно добавить в текст
    // шага пояснение с вопросительным знаком.
    for (const question of everyQuestion()) {
      const marks = (question.text.match(/\?/gu) ?? []).length;
      expect(marks, question.text).toBeLessThanOrEqual(1);
    }
  });

  it('у каждого вопроса есть кнопки: свободных ответов в онбординге нет', () => {
    // Свободный ответ пришёл бы обычным сообщением и попал в буфер
    // выгрузки — либо потерялась бы мысль, либо именем стало бы «надо
    // купить продукты».
    for (const question of everyQuestion()) {
      expect(question.rows.length, question.text).toBeGreaterThan(0);
      expect(question.rows.flat().length, question.text).toBeGreaterThan(0);
    }
  });

  it('про имя спрашивают всех, но по-разному', () => {
    /**
     * **Раньше шаг пропускался**, если в имени из профиля нет букв: вопрос
     * «Называть тебя .?» читается как сбой. Довод был верен, пока написать
     * своё имя было нельзя.
     *
     * С задачи 3.61 можно, и правило перевернулось: человек с точкой в
     * профиле стал единственным, кого не спрашивают никогда. Заказчик
     * заметил это на своём аккаунте — «вдруг человек хочет, чтобы его
     * называли „,“». Теперь спрашивают всех: с именем его подтверждают,
     * без имени спрашивают прямо.
     */
    expect(firstStep('Аня')).toBe(STEP.name);
    expect(firstStep('')).toBe(STEP.name);
    expect(firstStep('   ')).toBe(STEP.name);

    const withName = questionFor(STEP.name, { texts, name: 'Аня' });
    expect(withName?.text).toContain(texts.onboarding.nameConfirm('Аня'));

    const withoutName = questionFor(STEP.name, { texts, name: '' });
    expect(withoutName?.text).toBe(texts.onboarding.nameUnknown);

    // Непригодного имени человек не видит, а ответить ему есть чем.
    const labels = withoutName?.rows.flat().map((button) => button.label) ?? [];
    expect(labels).toEqual([texts.onboarding.buttonNameOwn, texts.onboarding.buttonNameSkip]);
    expect(labels).not.toContain(texts.onboarding.buttonNameYes);
  });

  it('имя подставляется в вопрос', () => {
    const question = questionFor(STEP.name, { texts, name: 'Марина' });
    expect(question?.text).toContain('Марина');
  });
});

describe('callback_data', () => {
  it('ни одна кнопка не превышает 64 байта', () => {
    // Предел Telegram. Правило то же, что в задаче 2.18: проверять надо
    // все клавиатуры проекта, а не те, что попались на глаза.
    const encoder = new TextEncoder();

    for (const question of everyQuestion()) {
      for (const button of question.rows.flat()) {
        const size = encoder.encode(button.action).length;
        expect(size, button.action).toBeLessThanOrEqual(64);
      }
    }
  });

  it('идентификаторы кнопок не совпадают между шагами', () => {
    // Совпадение означало бы, что нажатие на одном шаге срабатывает
    // обработчиком другого.
    const actions = everyQuestion().flatMap((question) =>
      question.rows.flat().map((button) => button.action),
    );

    expect(new Set(actions).size).toBe(actions.length);
  });

  it('префикс времени не путается с выключателем вечера', () => {
    // `onb:evening:off` начинается с `onb:evening:`, и обработчик времени
    // поймал бы его первым, если бы не проверял формат.
    expect(ACTION.eveningOff.startsWith(ACTION.eveningPrefix)).toBe(true);
    expect(/^\d{2}:\d{2}$/u.test(ACTION.eveningOff.slice(ACTION.eveningPrefix.length))).toBe(false);

    for (const time of EVENING_TIMES) {
      expect(/^\d{2}:\d{2}$/u.test(time)).toBe(true);
    }
  });
});

describe('часовые пояса', () => {
  it('все зоны известны системе', () => {
    // Своя таблица поясов была бы устаревшей копией системной. Проверяем,
    // что каждое название Intl принимает.
    for (const { zone } of TIMEZONES) {
      expect(() =>
        new Intl.DateTimeFormat('ru-RU', { timeZone: zone }).format(new Date()),
      ).not.toThrow();
    }
  });

  it('Москва есть в списке: с неё начинается быстрый путь', () => {
    expect(TIMEZONES.some((item) => item.zone === 'Europe/Moscow')).toBe(true);
  });

  it('города разложены по рядам, а не столбцом в одиннадцать кнопок', () => {
    const question = timezoneQuestion(texts);

    // Четыре ряда города плюс один — «Напишу свой город» (задача 3.70).
    expect(question.rows.length).toBeLessThanOrEqual(5);

    const labels = question.rows.flat().map((button) => button.label);
    expect(labels).toHaveLength(TIMEZONES.length + 1);
    expect(labels).toContain(texts.onboarding.buttonCityOwn);
  });

  it('«Напишу свой город» стоит последним, а не перед списком', () => {
    /**
     * Одиннадцать кнопок закрывают страну целиком, и большинству хватит
     * их. Название — путь для того, кто не нашёл себя, и первым он стоять
     * не должен: иначе человек начнёт печатать там, где хватило бы тапа.
     */
    const rows = timezoneQuestion(texts).rows;
    const last = rows[rows.length - 1] ?? [];

    expect(last.map((button) => button.label)).toEqual([texts.onboarding.buttonCityOwn]);
  });
});

describe('выбор сфер', () => {
  it('без выбора кнопки без галочек', () => {
    const rows = topicRows(texts, []);
    const labels = rows.flat().map((button) => button.label);

    expect(labels).toContain('семья');
    expect(labels).not.toContain(texts.onboarding.topicChosen('семья'));
  });

  it('отмеченное помечается галочкой', () => {
    const labels = topicRows(texts, ['семья', 'работа'])
      .flat()
      .map((button) => button.label);

    expect(labels).toContain(texts.onboarding.topicChosen('семья'));
    expect(labels).toContain(texts.onboarding.topicChosen('работа'));
    expect(labels).toContain('здоровье');
  });

  it('кнопка «Готово» всегда последняя', () => {
    const rows = topicRows(texts, []);
    const last = rows.at(-1) ?? [];

    expect(last).toHaveLength(1);
    expect(last[0]?.action).toBe(ACTION.topicsDone);
  });

  it('выбор читается обратно из подписей', () => {
    // Состояние выбора живёт в клавиатуре самой реплики, а не в базе:
    // так оно не теряется при перезапуске и не требует колонки.
    const labels = topicRows(texts, ['дети', 'деньги'])
      .flat()
      .map((button) => button.label);

    expect(chosenFromLabels(labels, texts)).toEqual(['дети', 'деньги']);
  });

  it('порядок выбора не влияет на результат', () => {
    const first = topicRows(texts, ['деньги', 'дети'])
      .flat()
      .map((button) => button.label);

    expect(chosenFromLabels(first, texts)).toEqual(['дети', 'деньги']);
  });

  it('чужие подписи не считаются выбором', () => {
    expect(chosenFromLabels(['что-то своё', '✓ несуществующая'], texts)).toEqual([]);
  });

  it('базовый набор §6.4 целиком есть среди предложений', () => {
    for (const name of ['семья', 'здоровье', 'работа', 'покупки', 'личное']) {
      expect(TOPIC_CHOICES).toContain(name);
    }
  });
});

describe('время напоминаний', () => {
  it('варианты утра и вечера не пересекаются', () => {
    // Иначе один и тот же час предлагался бы дважды и путал бы.
    for (const time of MORNING_TIMES) {
      expect(EVENING_TIMES).not.toContain(time);
    }
  });

  it('все варианты в формате часов и минут', () => {
    for (const time of [...MORNING_TIMES, ...EVENING_TIMES]) {
      expect(time).toMatch(/^\d{2}:\d{2}$/u);
    }
  });
});

describe('словарь', () => {
  it('каждый профиль заполняет все реплики онбординга', () => {
    // Второй профиль (§13.8) обязан заполнить те же поля: забыть половину
    // не выйдет, не соберётся сборка. Проверка на пустые строки.
    for (const profile of Object.values(profiles)) {
      const values = Object.values(profile.onboarding);

      /**
       * Часть реплик принимает строку, часть — список сфер, а с задачи
       * 3.70 одна принимает два довода: город и пояс. Проверяется наличие
       * текста, а не форма довода, — поэтому доводы подставляются щедро,
       * лишние функция просто не читает.
       */
      const call = (fn: (...input: never[]) => string): string => {
        try {
          return fn('проверка' as never, 'проверка' as never);
        } catch {
          return fn(['проверка'] as never);
        }
      };

      for (const value of values) {
        const text = typeof value === 'function' ? call(value) : value;
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('предложение добавить сферу (§6.4)', () => {
  /**
   * ТЗ §6.4: «Если новая запись не подходит ни к одной теме, она уходит в
   * тему по умолчанию, а бот при следующем удобном случае предлагает
   * создать новую». Требование было в ТЗ и в плане, а в коде потерянные
   * названия сфер только писались в журнал. Нашлось на живой выкладке.
   */

  it('кладёт в кнопку номера сфер, а не их названия', () => {
    // Кириллица весит два байта на знак, а callback_data ограничена 64.
    const action = encodeTopicOffer(['покупки']);

    expect(action).toBe(`${ACTION.addTopicsPrefix}3`);
    expect(Buffer.byteLength(action ?? '', 'utf8')).toBeLessThanOrEqual(64);
  });

  it('возвращает названия обратно', () => {
    const action = encodeTopicOffer(['здоровье', 'покупки']);

    expect(decodeTopicOffer(action ?? '')).toEqual(['здоровье', 'покупки']);
  });

  it('предлагает не больше двух сфер', () => {
    // Вопрос из четырёх сфер — это анкета, а разгрузка в неё не
    // превращается. Остальные предложатся, когда снова понадобятся.
    const names = decodeTopicOffer(encodeTopicOffer(['семья', 'здоровье', 'работа']) ?? '');

    expect(names).toHaveLength(2);
  });

  it('незнакомую сферу предложить нельзя', () => {
    // Закрытый список — не прихоть: номер в кнопке имеет смысл только
    // пока список в коде. Своё название человек назовёт сам, когда
    // появится такая возможность.
    expect(encodeTopicOffer(['ремонт дачи'])).toBeUndefined();
    expect(offerTopicsQuestion(defaultTexts, ['ремонт дачи'])).toBeUndefined();
  });

  it('мусор в данных даёт пустой список, а не отказ', () => {
    // callback_data приходит снаружи, подделать её можно.
    expect(decodeTopicOffer('onb:add:99')).toEqual([]);
    expect(decodeTopicOffer('onb:add:абв')).toEqual([]);
    expect(decodeTopicOffer('onb:add:no')).toEqual([]);
    expect(decodeTopicOffer('чужое')).toEqual([]);
  });

  it('вопрос называет сферы человеку и даёт два ответа', () => {
    const question = offerTopicsQuestion(defaultTexts, ['покупки']);

    expect(question?.text).toContain('покупки');
    expect(question?.rows.flat()).toHaveLength(2);
  });
});

describe('имя без букв (§12.2)', () => {
  /**
   * Имя приходит от Telegram, и там бывает что угодно. У живого человека
   * 27.08.2026 имя оказалось одной точкой, и бот спросил «Называть тебя
   * .?» — это выглядит как сбой, а не как знакомство. Проверка на пустую
   * строку такое не ловила.
   *
   * **Шаг при этом больше не пропускается** (правка заказчика 04.09.2026):
   * спрашивают всех, просто непригодное имя в вопрос не подставляют.
   */

  const letterless = ['', '   ', '.', '·', '...', '🙂', '—', '42'];

  for (const name of letterless) {
    it(`«${name}» в вопрос не подставляется, но спросить надо`, () => {
      expect(firstStep(name)).toBe(STEP.name);

      const question = questionFor(STEP.name, { texts: defaultTexts, name });
      expect(question?.text).toBe(defaultTexts.onboarding.nameUnknown);

      // Главное: своего непригодного имени человек не видит.
      if (name.trim() !== '') expect(question?.text).not.toContain(name.trim());
    });
  }

  const names = ['Аня', 'Anna', '.Аня', 'Аня 🙂'];

  for (const name of names) {
    it(`«${name}» — имя, вопрос задаётся`, () => {
      expect(firstStep(name)).toBe(STEP.name);
      expect(questionFor(STEP.name, { texts: defaultTexts, name })?.text).toContain(name);
    });
  }
});
