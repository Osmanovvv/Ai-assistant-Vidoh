import { describe, expect, it } from 'vitest';

import { bulkDeadlineRequest } from './bulk-deadline-reply.js';

const now = new Date('2026-10-01T09:00:00.000Z');
const context = { now, timeZone: 'Europe/Moscow' };

describe('bulkDeadlineRequest', () => {
  it.each([
    'Назначь этим задачам дату на 2.10',
    'назначить эти дела на 02/10',
    'Поставь к этим записям 2.10.2026',
  ])('узнаёт явную дату в команде: «%s»', (text) => {
    const result = bulkDeadlineRequest(text, context);
    expect(result?.kind).toBe('valid');
    if (result?.kind === 'valid') {
      expect(result.deadlineAt.toISOString()).toBe('2026-10-01T21:00:00.000Z');
    }
  });

  it.each(['Назначь этим задачам на завтра', 'Поставь эти дела на сегодня'])(
    'поддерживает относительную дату: «%s»',
    (text) => {
      expect(bulkDeadlineRequest(text, context)?.kind).toBe('valid');
    },
  );

  it('не перехватывает обычную мысль без ссылки на список', () => {
    expect(bulkDeadlineRequest('Поставить дату на 2.10', context)).toBeUndefined();
  });

  it('помечает явно начатую, но неполную команду как invalid', () => {
    expect(bulkDeadlineRequest('Назначь этим задачам дату', context)).toEqual({ kind: 'invalid' });
  });
});
