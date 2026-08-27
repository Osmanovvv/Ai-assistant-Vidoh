import { describe, expect, it } from 'vitest';

import { resolveDeadline } from './dates.js';
import { hasTimeWord, weekdayIn } from './time-words.js';

/**
 * Проверка сроков словами человека (задача 2.7).
 *
 * Замер контрольного набора 27.08.2026 показал десять выдуманных сроков
 * из сорока трёх дел. Промпт уже просил «не выдумывай сроки» — просьба не
 * помогла, поэтому правило переехало в код.
 *
 * Цена ошибки не в самом сроке, а в выдаче: фильтр ставит дела «на
 * сегодня» впереди всех, и мелочь с придуманной датой вытесняет важное
 * дело без срока. На живой выгрузке в ответе оказались пуфики, капсулы и
 * кофе, а ортопед со стоматологом — нет.
 */

/** Четверг, 27 августа 2026, полдень по Москве. */
const NOW = new Date('2026-08-27T09:00:00.000Z');
const ZONE = 'Europe/Moscow';

describe('слова о времени', () => {
  const withTime = [
    'записаться к врачу в четверг',
    'купить продукты сегодня',
    'сдать отчёт до конца недели',
    'поездка на 5 7 сентября',
    'позвонить через два дня',
    'поздравить с днём рождения',
    'начну ходить с 15 сентября',
  ];

  for (const text of withTime) {
    it(`видит время в «${text}»`, () => {
      expect(hasTimeWord(text)).toBe(true);
    });
  }

  const withoutTime = [
    'купить пуфики',
    'записаться к ортопеду',
    'проверить список продуктов',
    'сделать маникюр',
    'почистить корзину',
    'сверить кассу',
  ];

  for (const text of withoutTime) {
    it(`не видит времени в «${text}»`, () => {
      expect(hasTimeWord(text)).toBe(false);
    });
  }

  it('«ё» и регистр не мешают', () => {
    expect(hasTimeWord('В ЧЕТВЕРГ')).toBe(true);
    expect(hasTimeWord('сдать в третьем квартале')).toBe(true);
  });
});

describe('день недели в тексте', () => {
  it('узнаёт названный день', () => {
    expect(weekdayIn('записаться к стоматологу в четверг')).toBe(4);
    expect(weekdayIn('в воскресенье к маме')).toBe(0);
  });

  it('два дня — не выбор за человека', () => {
    // «Каждый вторник и четверг» — составное; выбрать один за него
    // значило бы напоминать не в тот день.
    expect(weekdayIn('каждый вторник и четверг возить к репетитору')).toBeUndefined();
  });

  it('нет дня — нет и ответа', () => {
    expect(weekdayIn('купить пуфики')).toBeUndefined();
  });
});

describe('срок принимается только со словами человека', () => {
  it('срок без слов о времени отбрасывается', () => {
    // Ровно случай живой выгрузки: «купить пуфики» с датой на сегодня.
    const outcome = resolveDeadline(
      { deadline: '2026-08-27', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'купить пуфики' },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('не назван');
  });

  it('проверяется только текст самого дела, а не вся выгрузка', () => {
    // Сначала проверялась и выгрузка целиком — и это оказалось дырой:
    // одного «успеть» или одной цифры «1968 года» в потоке хватало,
    // чтобы пропустить выдуманные сроки у двадцати других дел. Замер
    // поймал сразу: семь придуманных сроков вернулись.
    const outcome = resolveDeadline(
      { deadline: '2026-09-05', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'запланировать поездку' },
    );

    expect(outcome.ok).toBe(false);
  });

  it('дата в тексте дела срок сохраняет', () => {
    const outcome = resolveDeadline(
      { deadline: '2026-09-05', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'запланировать поездку на 5 7 сентября' },
    );

    expect(outcome.ok).toBe(true);
  });

  it('без слов человека проверка не работает и срок принимается', () => {
    // Обратная совместимость: старые вызовы без `said` ведут себя как
    // раньше. Молча менять поведение вызывающего кода нельзя.
    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      { now: NOW, timeZone: ZONE },
    );

    expect(outcome.ok).toBe(true);
  });
});

describe('день недели считает код, а не модель', () => {
  it('неверный день недели пересчитывается', () => {
    // Замер 27.08.2026: на «в четверг» модель вернула среду 2 сентября.
    const outcome = resolveDeadline(
      { deadline: '2026-09-02', accuracy: 'day' },
      {
        now: NOW,
        timeZone: ZONE,
        said: 'записаться к стоматологу в четверг',
      },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      // Ближайший четверг от четверга — это сегодня: человек говорит о
      // ближайшем, иначе сказал бы «в следующий».
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-26');
      expect(outcome.corrected).toBe('weekday');
    }
  });

  it('верный день недели не трогается', () => {
    // Пятница, 28 августа.
    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'сдать отчёт в пятницу' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.deadline) {
      expect(outcome.corrected).toBeUndefined();
      expect(outcome.deadline.at.toISOString().slice(0, 10)).toBe('2026-08-27');
    }
  });
});
