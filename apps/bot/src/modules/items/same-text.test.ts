import { describe, expect, it } from 'vitest';

import type { Item } from '../../db/schema.js';
import { knownByText, sameTextKey, splitKnown } from './same-text.js';

/**
 * Отсев повторной выгрузки (случай с боевого 31.08.2026, задача 3.22).
 *
 * Проверок «это не повтор» здесь больше, чем «это повтор», и так и надо:
 * пропущенный повтор даёт лишнюю строку в списке, а ложное совпадение
 * **молча съедает сказанное**. Второе — ровно то, чего продукт обещает
 * не делать.
 */

let counter = 0;

function item(text: string, createdAt = '2026-08-31T08:07:00.000Z'): Item {
  counter += 1;

  return {
    id: `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`,
    userId: 'user',
    sourceBatchId: null,
    sourceOrder: null,
    recurrenceRule: null,
    recurrenceText: null,
    recurrenceSource: null,
    text,
    body: null,
    type: 'TASK',
    priority: 'SOON',
    topic: 'личное',
    topicId: null,
    completedAt: null,
    status: 'new',
    isProject: false,
    backgroundedAt: null,
    assignee: null,
    deadlineAt: null,
    deadlineAccuracy: null,
    embedding: null,
    isDraft: false,
    draftReason: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

describe('что считается тем же самым', () => {
  it.each([
    ['съездить в магазин', 'Съездить в магазин'],
    ['купить ещё хлеба', 'купить еще хлеба'],
    ['позвонить  заказчику', 'позвонить заказчику'],
    ['заплатить по учёбе.', 'заплатить по учёбе'],
    [' отправить ссылки на сайт ', 'отправить ссылки на сайт'],
  ])('«%s» и «%s»', (left, right) => {
    expect(sameTextKey(left)).toBe(sameTextKey(right));
  });
});

describe('что тем же самым не считается', () => {
  it.each([
    // Соседи по смыслу и по вектору — но это разные дела.
    ['позвонить маме', 'позвонить папе'],
    ['купить хлеб', 'купить хлеба'],
    ['оплатить садик', 'оплатить садик за август'],
    ['записать к врачу в четверг', 'записаться к врачу в пятницу'],
  ])('«%s» и «%s»', (left, right) => {
    expect(sameTextKey(left)).not.toBe(sameTextKey(right));
  });
});

describe('повторная выгрузка не заводит вторую запись', () => {
  const open = [item('съездить в магазин'), item('оплатить бухгалтеру налоги')];

  it('всё сказанное уже есть — заводить нечего', () => {
    const split = splitKnown(
      [{ text: 'Съездить в магазин' }, { text: 'оплатить бухгалтеру налоги' }],
      knownByText(open),
    );

    expect(split.fresh).toEqual([]);
    expect(split.known.map((one) => one.text)).toEqual([
      'съездить в магазин',
      'оплатить бухгалтеру налоги',
    ]);
  });

  it('новое среди повторов заводится', () => {
    const split = splitKnown(
      [{ text: 'съездить в магазин' }, { text: 'позвонить заказчику' }],
      knownByText(open),
    );

    expect(split.fresh.map((one) => one.text)).toEqual(['позвонить заказчику']);
    expect(split.known).toHaveLength(1);
  });

  it('человек дважды сказал одно и то же в одной речи', () => {
    // «надо хлеба… и ещё хлеба купить» — запись должна быть одна.
    const split = splitKnown([{ text: 'купить хлеб' }, { text: 'купить хлеб' }], knownByText([]));

    expect(split.fresh).toHaveLength(1);
  });

  it('повтор присоединяется к самой ранней записи, а не к последней копии', () => {
    /**
     * В бою дубли уже есть — три копии за 31.08. Пока их не убрали,
     * повтор обязан находить первую: иначе выдача показывала бы копию, а
     * человек правил бы не ту запись.
     */
    const first = item('съездить в магазин', '2026-08-31T08:07:00.000Z');
    const second = item('съездить в магазин', '2026-08-31T09:04:00.000Z');
    const third = item('съездить в магазин', '2026-08-31T09:12:00.000Z');

    const split = splitKnown([{ text: 'съездить в магазин' }], knownByText([third, first, second]));

    expect(split.known[0]?.id).toBe(first.id);
  });

  it('пустой список открытых записей ничего не ломает', () => {
    const split = splitKnown([{ text: 'купить хлеб' }], knownByText([]));

    expect(split.fresh).toHaveLength(1);
    expect(split.known).toEqual([]);
  });
});
