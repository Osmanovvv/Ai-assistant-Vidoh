import { describe, expect, it } from 'vitest';

import { summarizeDump } from './summary.js';

/**
 * Компактный итог разбора (заказчица, 16.09.2026, п. 3): раскладка дел по
 * сферам с числами и что на сегодня / на завтра — одним сообщением, а не
 * серией служебных.
 */
const NOW = new Date('2026-09-15T14:00:00.000Z'); // вторник 15.09, 17:00 по Москве
const MOSCOW = 'Europe/Moscow';

const at = (iso: string) => new Date(iso);

describe('summarizeDump', () => {
  it('считает дела и желания по сферам, больше — выше, при равенстве — по имени', () => {
    // Желания — в счёте с 17.09.2026 (решение Никиты): признание называет
    // «6 дел и 3 желания», и у желаний должно быть своё место в сферах.
    // Состояние — по-прежнему нет: это не запись, которую разложили.
    const summary = summarizeDump(
      [
        { text: 'Съездить в офис', type: 'TASK', topic: 'работа' },
        { text: 'Отправить заявление', type: 'TASK', topic: 'работа' },
        { text: 'Заказать цветы', type: 'TASK', topic: 'покупки' },
        { text: 'Написать список мужу', type: 'TASK', topic: 'покупки' },
        { text: 'Обговорить условия', type: 'TASK', topic: 'работа' },
        { text: 'Позвонить няне', type: 'TASK', topic: 'семья' },
        { text: 'Устала', type: 'EMOTION', topic: 'личное' },
        { text: 'Хочу на море', type: 'DESIRE', topic: 'личное' },
      ],
      { now: NOW, timeZone: MOSCOW },
    );

    expect(summary.spheres).toEqual([
      { name: 'работа', icon: '💼', count: 3 },
      { name: 'покупки', icon: '🛒', count: 2 },
      // 🤍 у «личного» — из примеров ТЗ проджекта 17.09.2026 (2.4).
      { name: 'личное', icon: '🤍', count: 1 },
      { name: 'семья', icon: '👨‍👩‍👧', count: 1 },
    ]);
  });

  it('на сегодня и на завтра — только дела с дневным сроком, в поясе человека', () => {
    const summary = summarizeDump(
      [
        {
          text: 'Съездить в офис распечатать документы',
          type: 'TASK',
          topic: 'работа',
          // Среда 16.09, начало суток по Москве.
          deadline: { at: at('2026-09-15T21:00:00.000Z'), accuracy: 'day' },
        },
        {
          text: 'Позвонить в банк',
          type: 'TASK',
          topic: 'личное',
          // Вторник 15.09 — сегодня.
          deadline: { at: at('2026-09-14T21:00:00.000Z'), accuracy: 'day' },
        },
        {
          text: 'Записаться к стоматологу',
          type: 'TASK',
          topic: 'здоровье',
          // Неделя с 21.09 — не сегодня и не завтра.
          deadline: { at: at('2026-09-20T21:00:00.000Z'), accuracy: 'week' },
        },
        { text: 'Заказать цветы', type: 'TASK', topic: 'покупки' },
      ],
      { now: NOW, timeZone: MOSCOW },
    );

    expect(summary.today).toEqual(['Позвонить в банк']);
    expect(summary.tomorrow).toEqual(['Съездить в офис распечатать документы']);
  });

  it('под «На сегодня» день из заголовка срезается, как в списке ветки (прогон 18.09.2026, шаг 29)', () => {
    /**
     * Бой: «по учёбе надо сдать курсовую до пятницы» в пятницу → итог
     * «На сегодня: — Сдать курсовую до пятницы», а ветка — «Сдать
     * курсовую · 18.09». Под заголовком дня хвост «до пятницы» — эхо, и
     * два экрана называли одно дело по-разному.
     */
    const summary = summarizeDump(
      [
        {
          text: 'Сдать курсовую до пятницы',
          type: 'TASK',
          topic: 'работа',
          deadline: { at: at('2026-09-14T21:00:00.000Z'), accuracy: 'day' },
        },
        {
          text: 'позвонить в банк завтра',
          type: 'TASK',
          topic: 'личное',
          deadline: { at: at('2026-09-15T21:00:00.000Z'), accuracy: 'day' },
        },
      ],
      { now: NOW, timeZone: MOSCOW },
    );

    expect(summary.today).toEqual(['Сдать курсовую']);
    expect(summary.tomorrow).toEqual(['Позвонить в банк']);
  });

  it('сфера без своей иконки — без иконки, пустая выгрузка — пустой итог', () => {
    const summary = summarizeDump([{ text: 'Сдать курсовую', type: 'TASK', topic: 'учёба' }], {
      now: NOW,
      timeZone: MOSCOW,
    });
    expect(summary.spheres).toEqual([{ name: 'учёба', icon: '📚', count: 1 }]);

    const odd = summarizeDump([{ text: 'Полить цветы', type: 'TASK', topic: 'дача' }], {
      now: NOW,
      timeZone: MOSCOW,
    });
    expect(odd.spheres).toEqual([{ name: 'дача', icon: undefined, count: 1 }]);

    expect(summarizeDump([], { now: NOW, timeZone: MOSCOW })).toEqual({
      spheres: [],
      today: [],
      tomorrow: [],
    });
  });
});
