import { describe, expect, it } from 'vitest';

import { profiles } from '../../texts/index.js';
import { detectByMarkers, detectCrisis } from './crisis.js';

/**
 * Контур острого кризиса (задача 2.12).
 *
 * §13.7 ТЗ описывает этот случай мягче остальных требований, а цена
 * ошибки здесь выше денег. Отсюда таблица случаев в обе стороны: и на
 * срабатывание, и на молчание там, где кризиса нет.
 */

describe('первый контур: маркеры', () => {
  it.each([
    'я больше не хочу жить',
    'мне не хочется жить',
    'иногда хочу умереть',
    'лучше бы меня не было',
    'думаю покончить с собой',
    'я режу себя когда совсем плохо',
    'хочу наглотаться таблеток',
  ])('срабатывает: %s', (text) => {
    const outcome = detectByMarkers(text);

    expect(outcome.detected).toBe(true);
    expect(outcome.contour).toBe('markers');
    expect(outcome.marker).toBeTypeOf('string');
  });

  it.each([
    'я вообще ничего не успеваю',
    'я устала',
    'я на нуле',
    'всё валится из рук',
    'я плохая мать',
    'надо купить продукты и записать сына к врачу',
    'умереть можно от этой жары',
    'готова себя убить, что забыла про садик',
    'хоть убей не помню, куда положила',
  ])('молчит: %s', (text) => {
    // Ложное срабатывание не безобидно: человек вместо своего списка дел
    // получает реплику про специалиста, а разбор не случается.
    expect(detectByMarkers(text).detected).toBe(false);
  });

  it('«ё» не мешает', () => {
    expect(detectByMarkers('хочу свести счёты с жизнью').detected).toBe(true);
  });

  it('регистр не мешает', () => {
    expect(detectByMarkers('НЕ ХОЧУ ЖИТЬ').detected).toBe(true);
  });

  it('маркер посреди длинной выгрузки находится', () => {
    // Настоящая выгрузка — это поток на минуту, и признак может быть в
    // середине, между продуктами и химчисткой.
    const text = [
      'так, надо купить продукты, потом химчистка',
      'и вообще я не хочу жить',
      'ещё записать сына к врачу',
    ].join(' ');

    expect(detectByMarkers(text).detected).toBe(true);
  });
});

describe('оба контура', () => {
  it('признак модели срабатывает там, где маркеров нет', () => {
    // Человек может сказать так, как в списке не написано. За это и
    // отвечает второй контур.
    const outcome = detectCrisis('всё это больше не имеет смысла для меня', true);

    expect(outcome.detected).toBe(true);
    expect(outcome.contour).toBe('model');
  });

  it('маркеры срабатывают, даже если модель промолчала', () => {
    const outcome = detectCrisis('я не хочу жить', false);

    expect(outcome.detected).toBe(true);
    expect(outcome.contour).toBe('markers');
  });

  it('маркеры важнее: по ним видно, что именно сработало', () => {
    expect(detectCrisis('хочу умереть', true).contour).toBe('markers');
  });

  it('отсутствие признака у модели не считается срабатыванием', () => {
    expect(detectCrisis('надо купить продукты', undefined).detected).toBe(false);
    expect(detectCrisis('надо купить продукты', false).detected).toBe(false);
  });
});

describe('ответ на кризис', () => {
  it('есть в каждом профиле и не пустой', () => {
    for (const profile of Object.values(profiles)) {
      expect(profile.safety.crisis.trim().length).toBeGreaterThan(0);
    }
  });

  it('не содержит вопроса', () => {
    // §13.9: вопрос предполагает продолжение разговора, а §13.7 требует
    // из него выйти. Ответ на кризис — не приглашение поговорить.
    for (const profile of Object.values(profiles)) {
      expect(profile.safety.crisis).not.toContain('?');
    }
  });

  it('короткий: §13.9 отводит на реплику вне разбора одно-два предложения', () => {
    for (const profile of Object.values(profiles)) {
      expect(profile.safety.crisis.length).toBeLessThanOrEqual(200);
    }
  });
});
