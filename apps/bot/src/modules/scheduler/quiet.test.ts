import { describe, expect, it } from 'vitest';

import { inQuietHours, quietWindow } from './quiet.js';

/**
 * Режим тишины (задача 3.17).
 *
 * Окно почти всегда идёт через полночь, поэтому случаев «через полночь»
 * здесь больше, чем обычных: обычный случай — редкий.
 */

const night = quietWindow('22:00', '08:00');
const at = (hours: number, minutes = 0): number => hours * 60 + minutes;

describe('окно через полночь', () => {
  it('в полночь тихо', () => {
    expect(inQuietHours(at(0), night)).toBe(true);
  });

  it('в три ночи тихо', () => {
    expect(inQuietHours(at(3), night)).toBe(true);
  });

  it('в 22:00 тишина уже началась', () => {
    expect(inQuietHours(at(22), night)).toBe(true);
  });

  it('в 21:59 ещё нет', () => {
    expect(inQuietHours(at(21, 59), night)).toBe(false);
  });

  it('в 08:00 тишина уже кончилась', () => {
    // Граница включена слева и открыта справа. Иначе напоминание,
    // стоящее ровно на 08:00, не ушло бы никогда.
    expect(inQuietHours(at(8), night)).toBe(false);
  });

  it('в 07:59 ещё тихо', () => {
    expect(inQuietHours(at(7, 59), night)).toBe(true);
  });

  it('утреннее в 08:30 проходит', () => {
    expect(inQuietHours(at(8, 30), night)).toBe(false);
  });

  it('вечернее в 21:00 проходит', () => {
    expect(inQuietHours(at(21), night)).toBe(false);
  });
});

describe('окно внутри суток', () => {
  const siesta = quietWindow('13:00', '15:00');

  it('внутри тихо', () => {
    expect(inQuietHours(at(14), siesta)).toBe(true);
  });

  it('до и после — нет', () => {
    expect(inQuietHours(at(12, 59), siesta)).toBe(false);
    expect(inQuietHours(at(15), siesta)).toBe(false);
  });

  it('ночь при таком окне свободна', () => {
    expect(inQuietHours(at(3), siesta)).toBe(false);
  });
});

describe('вырожденные окна', () => {
  it('совпавшие границы — тишины нет ни минуты', () => {
    // Не «тихо круглые сутки»: человек, случайно выставивший одно и то же
    // время, остался бы без напоминаний навсегда и не понял бы почему.
    const empty = quietWindow('09:00', '09:00');

    expect(inQuietHours(at(9), empty)).toBe(false);
    expect(inQuietHours(at(3), empty)).toBe(false);
  });

  it('формат базы с секундами читается', () => {
    const fromDb = quietWindow('22:00:00', '08:00:00');

    expect(fromDb).toEqual(night);
  });
});
