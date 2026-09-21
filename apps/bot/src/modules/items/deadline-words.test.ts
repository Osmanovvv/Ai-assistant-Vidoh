import { describe, expect, it } from 'vitest';

import { defaultTexts } from '../../texts/index.js';
import { deadlineWords, dueWords } from './deadline-words.js';

/**
 * Слова срока в карточке и списках (`deadline-words.ts`) — с часом
 * (ТЗ проджекта 17.09.2026, шаг 5): «21.09, 13:00», когда час назван.
 */
const MOSCOW = 'Europe/Moscow';
const monday = new Date('2026-09-20T21:00:00.000Z'); // 21.09, полночь МСК

describe('срок словами', () => {
  it('день без часа — как прежде, число', () => {
    expect(
      deadlineWords(
        { deadlineAt: monday, deadlineAccuracy: 'day', deadlineTime: null },
        MOSCOW,
        defaultTexts,
      ),
    ).toBe('21.09');
  });

  it('день с часом — число и час через запятую', () => {
    expect(
      deadlineWords(
        { deadlineAt: monday, deadlineAccuracy: 'day', deadlineTime: 13 * 60 },
        MOSCOW,
        defaultTexts,
      ),
    ).toBe('21.09, 13:00');
    expect(
      deadlineWords(
        { deadlineAt: monday, deadlineAccuracy: 'day', deadlineTime: 9 * 60 + 5 },
        MOSCOW,
        defaultTexts,
      ),
    ).toBe('21.09, 09:05');
  });

  it('у недели и месяца часа не бывает — и он не печатается, даже если попал в данные', () => {
    expect(
      deadlineWords(
        { deadlineAt: monday, deadlineAccuracy: 'week', deadlineTime: 13 * 60 },
        MOSCOW,
        defaultTexts,
      ),
    ).toBe(defaultTexts.card.deadlineWeek('21.09'));
  });

  it('в списке «на сегодня» — только час: день и так сегодня', () => {
    const now = new Date('2026-09-21T06:00:00.000Z');

    expect(
      dueWords(
        { deadlineAt: monday, deadlineAccuracy: 'day', deadlineTime: 13 * 60 },
        { now, timeZone: MOSCOW },
        defaultTexts,
      ),
    ).toBe('13:00');
    expect(
      dueWords(
        { deadlineAt: monday, deadlineAccuracy: 'day', deadlineTime: null },
        { now, timeZone: MOSCOW },
        defaultTexts,
      ),
    ).toBeUndefined();
  });

  it('завтра с часом — «завтра, 13:00»', () => {
    const now = new Date('2026-09-20T06:00:00.000Z');

    expect(
      dueWords(
        { deadlineAt: monday, deadlineAccuracy: 'day', deadlineTime: 13 * 60 },
        { now, timeZone: MOSCOW },
        defaultTexts,
      ),
    ).toBe('завтра, 13:00');
  });
});
