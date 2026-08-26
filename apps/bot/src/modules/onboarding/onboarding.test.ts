import { describe, expect, it } from 'vitest';

import { defaultTexts, profiles } from '../../texts/index.js';
import {
  chosenFromLabels,
  firstStep,
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

  it('без имени шаг подтверждения пропускается', () => {
    // У части аккаунтов Telegram имени нет вовсе. Вопрос «называть тебя ?»
    // хуже, чем его отсутствие.
    expect(firstStep('Аня')).toBe(STEP.name);
    expect(firstStep('')).toBe(STEP.timezone);
    expect(firstStep('   ')).toBe(STEP.timezone);
    expect(questionFor(STEP.name, { texts, name: '' })).toBeUndefined();
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

    expect(question.rows.length).toBeLessThanOrEqual(4);
    expect(question.rows.flat()).toHaveLength(TIMEZONES.length);
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

      for (const value of values) {
        const text = typeof value === 'function' ? value('проверка') : value;
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
