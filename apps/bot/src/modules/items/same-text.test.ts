import { describe, expect, it } from 'vitest';

import type { Item } from '../../db/schema.js';
import { datelessTwins, knownByText, sameTextKey, splitKnown } from './same-text.js';

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
    deferredAt: null,
    offeredAt: null,
    reviewedAt: null,
    assignee: null,
    deadlineAt: null,
    deadlineAccuracy: null,
    deadlineTime: null,
    lineMentionedAt: null,
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
    // День — не часть дела, как и час (проверка Никиты 24.09.2026, 19:00):
    // «Поехать за ребёнком завтра» при записанной поездке завело второе.
    ['Поехать за ребёнком завтра', 'Поехать за ребёнком в 4 часа'],
    ['Купить яйца на завтра', 'Купить яйца'],
    ['Завтра забрать ребёнка в 7', 'Забрать ребёнка'],
    ['Сегодня позвонить маме', 'позвонить маме послезавтра'],
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
    // Названный день недели — может быть другое дело того же рода.
    ['позвонить маме в четверг', 'позвонить маме в пятницу'],
    ['приготовить завтрак', 'приготовить'],
  ])('«%s» и «%s»', (left, right) => {
    expect(sameTextKey(left)).not.toBe(sameTextKey(right));
  });
});

describe('день недели к делу без срока — то же дело (прогон Никиты 27.09.2026, 15:22)', () => {
  /**
   * «Записать Мишу к ортодонту» легло без даты: распознавание прилепило
   * «в понедельник» к соседнему предложению. Человек сказал ещё раз —
   * «Мишу записать к ортодонту в понедельник», — и бот завёл второе дело
   * вместо того, чтобы дать день первому.
   */
  it.each([
    'Записать Мишу к ортодонту в понедельник.',
    'В понедельник записать Мишу к ортодонту',
    'Записать Мишу к ортодонту во вторник',
    'Записать Мишу к ортодонту до среды',
    'Записать Мишу к ортодонту к пятнице',
    'Записать Мишу к ортодонту, в следующий четверг',
  ])('«%s» — повтор записанного без срока', (spoken) => {
    const open = item('Записать Мишу к ортодонту');

    const split = splitKnown([{ text: spoken }], knownByText([open]));

    expect(split.fresh).toEqual([]);
    expect(split.repeats.map((one) => one.item.id)).toEqual([open.id]);
  });

  describe('чего не сливать', () => {
    it('у записанного свой срок — другой день может быть другим делом, как раньше', () => {
      const dated: Item = {
        ...item('Позвонить маме'),
        deadlineAt: new Date('2026-10-01T21:00:00.000Z'),
        deadlineAccuracy: 'day',
      };

      const split = splitKnown([{ text: 'Позвонить маме в пятницу' }], knownByText([dated]));

      expect(split.fresh).toHaveLength(1);
      expect(split.repeats).toEqual([]);
    });

    it('другое дело с днём недели — новое', () => {
      const split = splitKnown(
        [{ text: 'Записать Машу к ортодонту в понедельник' }],
        knownByText([item('Записать Мишу к ортодонту')]),
      );

      expect(split.fresh).toHaveLength(1);
    });

    it('день в названии записанного — не повод сливать с другим днём', () => {
      // Срок не встал, а «в четверг» осталось в названии: пятница — другое.
      const split = splitKnown(
        [{ text: 'Позвонить маме в пятницу' }],
        knownByText([item('Позвонить маме в четверг')]),
      );

      expect(split.fresh).toHaveLength(1);
    });

    it('дословное совпадение важнее: берётся оно', () => {
      const exact = item('Записать Мишу к ортодонту в понедельник');
      const bare = item('Записать Мишу к ортодонту');

      const split = splitKnown(
        [{ text: 'Записать Мишу к ортодонту в понедельник' }],
        knownByText([bare, exact]),
      );

      expect(split.repeats.map((one) => one.item.id)).toEqual([exact.id]);
    });
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

describe('поля карточки в тексте модели (задача 3.62 против 3.22)', () => {
  /**
   * В базу текст уходит **без** полей карточки: живой прогон 05.09.2026
   * дал «Позвонить бабушке. Срок 07.09 / Статус ждет», а сохранилось
   * «Позвонить бабушке». Сверка повтора обязана мерить то же значение,
   * что хранит база, — иначе повторная выгрузка заводит второй экземпляр
   * именно тех записей, куда модель вписала мусор.
   *
   * Сохранённый текст здесь — литерал, а не вызов `withoutCardFields`:
   * что именно сохраняется, доказывает item-text.test.ts, а этот тест
   * не должен повторять реализацию, которую проверяет.
   */
  const RAW = 'Позвонить бабушке. Срок 07.09\nСтатус ждет';
  const STORED = 'Позвонить бабушке';

  it('сырой текст модели узнаёт уже сохранённую запись', () => {
    const split = splitKnown([{ text: RAW }], knownByText([item(STORED)]));

    expect(split.fresh).toEqual([]);
    expect(split.known.map((one) => one.text)).toEqual([STORED]);
  });

  it('чистый текст узнаёт запись, сохранённую до 3.62 с мусором внутри', () => {
    // Такие записи в бою есть: они заведены раньше, чем поля стали
    // отсекаться. Повтор обязан находить их, а не заводить чистую копию.
    const split = splitKnown([{ text: STORED }], knownByText([item(RAW)]));

    expect(split.fresh).toEqual([]);
    expect(split.known).toHaveLength(1);
  });

  it('два сырых текста с мусором в одной речи — одна запись', () => {
    const split = splitKnown([{ text: RAW }, { text: RAW }], knownByText([]));

    expect(split.fresh).toHaveLength(1);
  });

  it('ярлык с не карточным значением — часть дела, а не мусор', () => {
    // «Срок неизвестен» человек сказал сам: это другое дело, чем «Купить
    // хлеб», и съедать его отсевом нельзя.
    const split = splitKnown(
      [{ text: 'Купить хлеб. Срок неизвестен' }],
      knownByText([item('Купить хлеб')]),
    );

    expect(split.fresh).toHaveLength(1);
    expect(split.known).toEqual([]);
  });
});

describe('час во фразе не мешает узнать повтор (живой прогон Никиты 23.09.2026)', () => {
  /**
   * «Давай заберём посылку без 15 6» — у «без 15 6» два чтения, час не
   * стал сроком, и заголовок остался «Забрать посылку без 15 6». Сверка
   * с «Забрать посылку» не совпала — завёлся дубль.
   */
  it.each([
    ['Забрать посылку без 15 6', 'Забрать посылку'],
    ['Забрать посылку в пол 11', 'забрать посылку'],
    ['Позвонить маме в 9', 'Позвонить маме'],
  ])('«%s» и «%s» — одно дело', (left, right) => {
    expect(sameTextKey(left)).toBe(sameTextKey(right));
  });

  it('повтор отдаёт пару: что сказано и какая запись уже есть', () => {
    const parcel = item('Забрать посылку');
    const said = { text: 'Забрать посылку без 15 6' };

    const split = splitKnown([said], knownByText([parcel]));

    expect(split.fresh).toEqual([]);
    expect(split.repeats).toEqual([{ unit: said, item: parcel }]);
  });
});

describe('двойник без срока внутри одной выгрузки (прогон Никиты 27.09.2026, 18:16)', () => {
  /**
   * Два голосовых подряд — «Записать Мишу к стоматологу.» и «Записать Мишу
   * к стоматологу в среду.» — попали в одну выгрузку, и завелись два дела:
   * без даты и на среду. Отсев повтора внутри выгрузки сравнивал дословно
   * и оставлял первое — то, что без дня.
   */
  const dated = { at: new Date('2026-09-29T21:00:00.000Z'), accuracy: 'day' as const };

  it('без срока уступает сказанному с днём — в любом порядке', () => {
    expect([
      ...datelessTwins([
        { text: 'Записать Мишу к стоматологу' },
        { text: 'Записать Мишу к стоматологу в среду', deadline: dated },
      ]),
    ]).toEqual([0]);
    expect([
      ...datelessTwins([
        { text: 'Записать Мишу к стоматологу в среду', deadline: dated },
        { text: 'Записать Мишу к стоматологу.' },
      ]),
    ]).toEqual([1]);
  });

  it('«купить хлеб» и «купить хлеб завтра» — остаётся тот, что с днём', () => {
    expect([
      ...datelessTwins([{ text: 'Купить хлеб' }, { text: 'Купить хлеб завтра', deadline: dated }]),
    ]).toEqual([0]);
  });

  describe('чего не трогать', () => {
    it('оба с днями — разные дни могут быть разными делами', () => {
      expect(
        datelessTwins([
          { text: 'Позвонить маме в четверг', deadline: dated },
          { text: 'Позвонить маме в пятницу', deadline: dated },
        ]).size,
      ).toBe(0);
    });

    it('разные дела', () => {
      expect(
        datelessTwins([
          { text: 'Записать Машу к стоматологу' },
          { text: 'Записать Мишу к стоматологу в среду', deadline: dated },
        ]).size,
      ).toBe(0);
    });

    it('оба без срока — это дословный повтор, его отсеивает splitKnown', () => {
      expect(datelessTwins([{ text: 'Купить хлеб' }, { text: 'Купить хлеб' }]).size).toBe(0);
    });

    it('день в названии у того, что без срока, — не повод сливать с другим днём', () => {
      expect(
        datelessTwins([
          { text: 'Позвонить маме в четверг' },
          { text: 'Позвонить маме в пятницу', deadline: dated },
        ]).size,
      ).toBe(0);
    });
  });
});
