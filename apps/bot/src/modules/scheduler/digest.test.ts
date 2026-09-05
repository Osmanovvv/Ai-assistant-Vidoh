import { describe, expect, it } from 'vitest';

import type { Item } from '../../db/schema.js';
import { defaultTexts } from '../../texts/index.js';
import { forbiddenPhraseIn } from '../presenter/presenter.service.js';
import {
  deadlineText,
  eveningText,
  MORNING_ACTIONS_LIMIT,
  morningText,
  projectText,
} from './digest.js';

/**
 * Сводки (задача 3.15).
 *
 * План просит «проверку текстов на запрещённые формулировки». Список
 * запрещённого здесь тот же, которым проверяется ответ модели: правило
 * §13.8 одно на продукт, и раздваивать его нельзя.
 *
 * Отдельно проверяется §13.6 — просроченное не подаётся как провал, дни
 * не считаются. Эти реплики приходят без спроса, и упрёк в них стоит
 * дороже, чем в ответе на вопрос.
 */

const item = (text: string, deadlineAt: Date | null = null): Item => ({ text, deadlineAt }) as Item;

/** Полдень 5 сентября 2026 по Москве — «сегодня» для всех проверок ниже. */
const NOW = new Date('2026-09-05T09:00:00.000Z');
const MOSCOW = 'Europe/Moscow';
const TODAY = { now: NOW, timeZone: MOSCOW };

/** Полночь того же дня в поясе человека — так срок и хранится. */
const todayAt = new Date('2026-09-04T21:00:00.000Z');

/** Имена параметров функции — по ним видно, что ей вообще можно скормить. */
function paramsOf(fn: (...args: never[]) => unknown): string[] {
  const inside = /\(([^)]*)\)/u.exec(fn.toString())?.[1] ?? '';

  return inside
    .split(',')
    .map((one) => one.trim().split(/[:=?]/u)[0]?.trim() ?? '')
    .filter((one) => one.length > 0);
}

const all = (): string[] => [
  morningText(defaultTexts, [], TODAY),
  morningText(defaultTexts, [item('Позвонить в садик'), item('Забрать посылку')], TODAY),
  eveningText(defaultTexts, 0),
  eveningText(defaultTexts, 3),
  deadlineText(defaultTexts, { item: item('Оплатить квитанцию'), onDay: true }),
  deadlineText(defaultTexts, { item: item('Оплатить квитанцию'), onDay: false }),
  projectText(defaultTexts, { title: 'День рождения сына', step: 'выбрать кафе' }),
];

describe('утро', () => {
  it('без дел — только приглашение, одной строкой', () => {
    const text = morningText(defaultTexts, [], TODAY);

    expect(text.split('\n')).toHaveLength(1);
    expect(text).toMatch(/наговори|скажи|разложу/iu);
  });

  it('с делами — приглашение и список', () => {
    const text = morningText(defaultTexts, [item('Позвонить в садик')], TODAY);

    expect(text).toContain('Позвонить в садик');
  });

  it('список урезан до лимита выдачи', () => {
    // Иначе утро приносит стену дел — ровно ту гору, ради которой
    // человек и пришёл к продукту (§13.2).
    const many = Array.from({ length: 10 }, (_value, index) => item(`Дело ${String(index)}`));
    const text = morningText(defaultTexts, many, TODAY);

    expect(text).toContain('Дело 0');
    expect(text).not.toContain(`Дело ${String(MORNING_ACTIONS_LIMIT)}`);
  });

  it('вчерашнее «завтра» под шапкой «на сегодня» срезается', () => {
    /**
     * **Задача 3.78, найдено прогоном выдачи на боевых записях.** Сводка
     * проджекта читалась «На сегодня: — Позвонить стоматологу завтра»:
     * шапка про сегодня, строка про завтра. Он сказал «завтра» вчера,
     * срок встал на сегодня, а слова остались вчерашние.
     */
    const text = morningText(defaultTexts, [item('Позвонить стоматологу завтра', todayAt)], TODAY);

    expect(text).toContain('Позвонить стоматологу');
    expect(text).not.toContain('завтра');
  });

  it('после срезанной даты заголовок начинается с заглавной', () => {
    // «Завтра надо купить корм» → «надо купить корм»: строчная буква в
    // списке рядом с «Вынести мусор» читается как небрежность.
    const text = morningText(defaultTexts, [item('Завтра надо купить корм', todayAt)], TODAY);

    expect(text).toContain('Надо купить корм');
  });

  it('у дела без срока слова человека не трогает', () => {
    /**
     * «Завтра» в тексте без срока — единственное, что у человека есть
     * про день: срок либо не назывался, либо не прошёл проверку §2.7.
     * Срезать это значило бы спрятать то, чего больше нигде нет.
     */
    const text = morningText(defaultTexts, [item('Позвонить стоматологу завтра')], TODAY);

    expect(text).toContain('Позвонить стоматологу завтра');
  });

  it('у дела с чужим днём слова человека не трогает', () => {
    // Срок на послезавтра под шапкой «на сегодня» — случай не наш:
    // такие дела в список не попадают вовсе (задача 3.71).
    const later = new Date('2026-09-06T21:00:00.000Z');
    const text = morningText(defaultTexts, [item('Забрать посылку в понедельник', later)], TODAY);

    expect(text).toContain('Забрать посылку в понедельник');
  });

  it('не считает, сколько всего осталось', () => {
    // «И ещё 47» утром — это счёт несделанного, запрещённый §13.6.
    const many = Array.from({ length: 50 }, (_value, index) => item(`Дело ${String(index)}`));

    expect(morningText(defaultTexts, many, TODAY)).not.toMatch(/\d{2}/u);
  });
});

describe('вечер', () => {
  it('закрытое называет числом', () => {
    expect(eveningText(defaultTexts, 3)).toContain('3');
  });

  it('пустой день не получает упрёка и не получает нуля', () => {
    const text = eveningText(defaultTexts, 0);

    expect(text).not.toContain('0');
    expect(text).not.toMatch(/не сделал|ничего не|успел|жаль|всего лишь/iu);
  });

  it('приглашает выгрузить накопившееся', () => {
    expect(eveningText(defaultTexts, 0)).toMatch(/накопи|скажи/iu);
  });

  it('короткий: две строки, не больше', () => {
    // §11 дословно: «короткий итог дня».
    expect(eveningText(defaultTexts, 5).split('\n')).toHaveLength(2);
  });
});

describe('предложение запомнить регулярность в сводке (3.17а)', () => {
  const noticed = defaultTexts.resolver.noticed(
    'Оплатить садик',
    '6 мая, 5 июня, 6 июля и 5 августа',
    'каждый месяц',
  );

  it('едет внутри вечерней сводки, а не отдельным сообщением', () => {
    const text = eveningText(defaultTexts, 2, noticed);

    expect(text).toContain(defaultTexts.reminders.eveningInvite);
    expect(text).toContain('Оплатить садик');
  });

  it('занимает единственный вопрос сводки', () => {
    // §13.9: один вопрос на реплику. Приглашение выше — не вопрос.
    const text = eveningText(defaultTexts, 2, noticed);

    expect((text.match(/\?/gu) ?? []).length).toBe(1);
  });

  it('без предложения сводка остаётся без вопросов вовсе', () => {
    expect((eveningText(defaultTexts, 2).match(/\?/gu) ?? []).length).toBe(0);
  });

  it('пустая строка предложением не считается', () => {
    expect(eveningText(defaultTexts, 2, '')).toBe(eveningText(defaultTexts, 2));
  });

  it('предложение отделено пустой строкой от итога', () => {
    // Иначе вопрос читается как продолжение приглашения.
    expect(eveningText(defaultTexts, 2, noticed).split('\n')[2]).toBe('');
  });

  it('и с предложением тон остаётся в рамках §13.8', () => {
    expect(forbiddenPhraseIn(eveningText(defaultTexts, 0, noticed))).toBeUndefined();
  });
});

describe('§13.6: просроченное не провал', () => {
  it('ни одна реплика не говорит о просроченном', () => {
    for (const text of all()) {
      expect(text).not.toMatch(/просроч|опозда|пропусти|горит|давно/iu);
    }
  });

  it('ни одна реплика не считает дни', () => {
    for (const text of all()) {
      expect(text).not.toMatch(/дн(я|ей) назад|уже \d|\d+ (дн|недел)/iu);
    }
  });

  it('сборщику неоткуда узнать число просроченных', () => {
    /**
     * Не проверка формулировки, а проверка устройства: в сигнатурах
     * `morningText` и `eveningText` нет параметра, куда просроченное
     * можно было бы подставить. Значит, оно не появится и после правки
     * текстов чужой рукой.
     *
     * Имена, а не количество: считать параметры бесполезно, стоит кому-то
     * добавить `overdueCount` вместо чего-нибудь. Список имён падает
     * ровно на той правке, ради которой этот тест написан.
     *
     * `day` появился в задаче 3.78 и несёт ровно две вещи — «сейчас» и
     * пояс, — что и написано в его типе. Подставить в него просроченное
     * нельзя, а новое имя в этом списке потребует объяснения здесь.
     */
    expect(paramsOf(morningText)).toEqual(['texts', 'actions', 'day']);
    expect(paramsOf(eveningText)).toEqual(['texts', 'closedToday', 'suggestion']);
  });
});

describe('§13.8: запрещённые формулировки', () => {
  it.each(all().map((text, index) => [index, text] as const))(
    'реплика %i чиста',
    (_index, text) => {
      expect(forbiddenPhraseIn(text)).toBeUndefined();
    },
  );
});

describe('§13.9: один вопрос на реплику', () => {
  it.each(all().map((text, index) => [index, text] as const))(
    'в реплике %i не больше одного вопроса',
    (_index, text) => {
      expect((text.match(/\?/gu) ?? []).length).toBeLessThanOrEqual(1);
    },
  );
});

describe('сроки и проект', () => {
  it('накануне и в день срока — разные реплики', () => {
    const eve = deadlineText(defaultTexts, { item: item('Квитанция'), onDay: false });
    const day = deadlineText(defaultTexts, { item: item('Квитанция'), onDay: true });

    expect(eve).not.toBe(day);
    expect(eve).toMatch(/завтра/iu);
    expect(day).toMatch(/сегодня/iu);
  });

  it('вопрос про проект называет и цель, и шаг', () => {
    const text = projectText(defaultTexts, { title: 'Ремонт', step: 'вызвать замерщика' });

    expect(text).toContain('Ремонт');
    expect(text).toContain('вызвать замерщика');
  });
});
