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

const item = (text: string): Item => ({ text }) as Item;

const all = (): string[] => [
  morningText(defaultTexts, []),
  morningText(defaultTexts, [item('Позвонить в садик'), item('Забрать посылку')]),
  eveningText(defaultTexts, 0),
  eveningText(defaultTexts, 3),
  deadlineText(defaultTexts, { item: item('Оплатить квитанцию'), onDay: true }),
  deadlineText(defaultTexts, { item: item('Оплатить квитанцию'), onDay: false }),
  projectText(defaultTexts, { title: 'День рождения сына', step: 'выбрать кафе' }),
];

describe('утро', () => {
  it('без дел — только приглашение, одной строкой', () => {
    const text = morningText(defaultTexts, []);

    expect(text.split('\n')).toHaveLength(1);
    expect(text).toMatch(/наговори|скажи|разложу/iu);
  });

  it('с делами — приглашение и список', () => {
    const text = morningText(defaultTexts, [item('Позвонить в садик')]);

    expect(text).toContain('Позвонить в садик');
  });

  it('список урезан до лимита выдачи', () => {
    // Иначе утро приносит стену дел — ровно ту гору, ради которой
    // человек и пришёл к продукту (§13.2).
    const many = Array.from({ length: 10 }, (_value, index) => item(`Дело ${String(index)}`));
    const text = morningText(defaultTexts, many);

    expect(text).toContain('Дело 0');
    expect(text).not.toContain(`Дело ${String(MORNING_ACTIONS_LIMIT)}`);
  });

  it('не считает, сколько всего осталось', () => {
    // «И ещё 47» утром — это счёт несделанного, запрещённый §13.6.
    const many = Array.from({ length: 50 }, (_value, index) => item(`Дело ${String(index)}`));

    expect(morningText(defaultTexts, many)).not.toMatch(/\d{2}/u);
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
     */
    expect(morningText).toHaveLength(2);
    expect(eveningText).toHaveLength(2);
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
