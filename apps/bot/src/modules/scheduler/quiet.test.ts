import { describe, expect, it } from 'vitest';

import { effectiveQuiet, inQuietHours, quietWindow } from './quiet.js';

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

describe('тишина ужимается под выбор человека', () => {
  /**
   * Найдено на приёмке этапа 3, на живом пользователе: он выбрал утро в
   * 07:00, а тишина по умолчанию 22:00–08:00 накрыла его выбор целиком.
   * Утреннее напоминание не пришло бы никогда, и понять почему было бы
   * нечем: настройки по умолчанию, к которым он не прикасался, отменяли
   * то, о чём он попросил прямо.
   */
  it('утро в 07:00 обрывает ночную тишину на 07:00', () => {
    const shrunk = effectiveQuiet(night, { morning: at(7), evening: at(20) });

    expect(shrunk).toEqual({ from: at(22), to: at(7) });
    expect(inQuietHours(at(7), shrunk!)).toBe(false);
  });

  it('ночь при этом закрыта по-прежнему', () => {
    const shrunk = effectiveQuiet(night, { morning: at(7), evening: at(20) });

    expect(inQuietHours(at(3), shrunk!)).toBe(true);
    expect(inQuietHours(at(23), shrunk!)).toBe(true);
    expect(inQuietHours(at(6, 59), shrunk!)).toBe(true);
  });

  it('поздний вечер сдвигает начало тишины', () => {
    const shrunk = effectiveQuiet(night, { morning: at(8, 30), evening: at(23) });

    expect(shrunk?.from).toBe(at(23) + 1);
    expect(inQuietHours(at(23), shrunk!)).toBe(false);
  });

  it('времена вне окна ничего не меняют', () => {
    expect(effectiveQuiet(night, { morning: at(8, 30), evening: at(21) })).toEqual(night);
  });

  it('оба времени внутри — окно ужимается с двух сторон', () => {
    const shrunk = effectiveQuiet(night, { morning: at(6), evening: at(23) });

    expect(shrunk).toEqual({ from: at(23) + 1, to: at(6) });
  });

  it('если от окна ничего не осталось — тишины нет', () => {
    // Человек выбрал вечер ровно на минуту раньше своего утра: закрывать
    // нечего, и притворяться, что закрываем, не надо.
    const narrow = quietWindow('22:00', '22:30');

    expect(effectiveQuiet(narrow, { morning: at(22, 30), evening: at(22, 29) })).toBeUndefined();
  });
});
