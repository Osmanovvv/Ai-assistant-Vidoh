import { describe, expect, it } from 'vitest';

import { defaultTexts, profiles } from '../../texts/index.js';
import {
  firstStep,
  questionFor,
  timezoneQuestion,
  ACTION,
  MORNING_TIMES,
  EVENING_TIMES,
  STEP,
  TIMEZONES,
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

    expect(questionFor(STEP.done, { texts, name })).toBeUndefined();
    expect(questionFor(0, { texts, name })).toBeUndefined();
  });

  it('вечер — последний шаг: вопроса про сферы нет (правка заказчицы 14.09.2026, п. 1.1)', () => {
    // Шагов ровно четыре, «закончен» — пятый; шестого, где раньше жили
    // сферы, нет. Прежние значения 5 и 6 в базе переводит миграция 0053.
    expect(STEP).toEqual({ name: 1, timezone: 2, morning: 3, evening: 4, done: 5 });
    expect(questionFor(STEP.evening + 1, { texts, name })).toBeUndefined();
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
