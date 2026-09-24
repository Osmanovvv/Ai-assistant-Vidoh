import { describe, expect, it } from 'vitest';

import { dialogOf, resolverCaseSchema } from './resolver-dataset.js';

/**
 * Случай стенда резолвера несёт разговор (план docs/26, задача 2).
 *
 * Минуты, а не отметки времени — как у `updatedMinutesAgo`: случай не
 * должен протухать оттого, что прошёл месяц.
 */

const base = {
  id: 'x',
  note: 'n',
  segment: 'и паспорт туда же',
  now: '2026-09-23T13:20:00.000Z',
  candidates: [],
  expected: { kind: 'create' },
};

describe('разговор в случае стенда', () => {
  it('без поля dialog разговор пуст — старые 35 случаев не меняются', () => {
    const item = resolverCaseSchema.parse(base);
    expect(item.dialog).toEqual([]);
    expect(dialogOf(item)).toEqual([]);
  });

  it('минуты назад превращаются в момент от «сейчас» случая', () => {
    const item = resolverCaseSchema.parse({
      ...base,
      dialog: [
        { role: 'person', text: 'Купить хлеб', minutesAgo: 2 },
        { role: 'bot', text: 'Через 30 минут: Забрать посылку', minutesAgo: 1 },
      ],
    });

    expect(dialogOf(item)).toEqual([
      { role: 'person', text: 'Купить хлеб', at: new Date('2026-09-23T13:18:00.000Z') },
      {
        role: 'bot',
        text: 'Через 30 минут: Забрать посылку',
        at: new Date('2026-09-23T13:19:00.000Z'),
      },
    ]);
  });

  it('чужая роль и пустая реплика — ошибка разметки', () => {
    expect(() =>
      resolverCaseSchema.parse({ ...base, dialog: [{ role: 'user', text: 'x', minutesAgo: 1 }] }),
    ).toThrow();
    expect(() =>
      resolverCaseSchema.parse({ ...base, dialog: [{ role: 'bot', text: '', minutesAgo: 1 }] }),
    ).toThrow();
  });
});
