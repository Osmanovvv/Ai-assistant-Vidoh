import { describe, expect, it } from 'vitest';

import { pageOf, PAGE_SIZE } from './backlog.service.js';
import { ToolRegistry } from './tools.js';
import { doneWindow } from './periods.js';
import {
  askedDay,
  asksAboutEverything,
  asksAboutToday,
  periodLabel,
  periodWindow,
} from './query.service.js';
import { defaultTexts } from '../../texts/index.js';

/**
 * Списки и реестр инструментов (задача 3.11).
 *
 * «Готово, когда: список из 200 записей листается без превышения лимитов
 * Telegram; реестр инструментов существует, пуст и покрыт тестом на
 * добавление фиктивного инструмента.»
 */

const many = (count: number): string[] =>
  Array.from({ length: count }, (_unused, index) => `дело ${String(index + 1)}`);

describe('постраничность', () => {
  it('двести записей листаются страницами по восемь', () => {
    const page = pageOf(many(200), 0);

    expect(page.items).toHaveLength(PAGE_SIZE);
    expect(page.pages).toBe(25);
    expect(page.total).toBe(200);
    expect(page.hasNext).toBe(true);
    expect(page.hasPrevious).toBe(false);
  });

  it('последняя страница знает, что она последняя', () => {
    const page = pageOf(many(200), 24);

    expect(page.hasNext).toBe(false);
    expect(page.hasPrevious).toBe(true);
    expect(page.items).toHaveLength(PAGE_SIZE);
  });

  it('неполная последняя страница', () => {
    const page = pageOf(many(10), 1);

    expect(page.items).toEqual(['дело 9', 'дело 10']);
    expect(page.hasNext).toBe(false);
  });

  it('номер за пределами прижимается к последней странице', () => {
    // Кнопка «дальше» могла остаться в старом сообщении, а записи с тех
    // пор закрылись. Человек увидит конец списка, а не пустоту.
    const page = pageOf(many(10), 99);

    expect(page.index).toBe(1);
    expect(page.items).toHaveLength(2);
  });

  it('отрицательный номер и дробный не ломают список', () => {
    expect(pageOf(many(10), -5).index).toBe(0);
    expect(pageOf(many(10), 1.7).index).toBe(1);
  });

  it('пустой список — одна пустая страница, а не ноль страниц', () => {
    // Ноль страниц означал бы деление на ноль в подписи «1 из 0».
    const page = pageOf([], 0);

    expect(page.pages).toBe(1);
    expect(page.items).toEqual([]);
    expect(page.hasNext).toBe(false);
  });

  it('страница влезает в предел Telegram с запасом', () => {
    // 4096 знаков на текст. Восемь строк по сто знаков — восемьсот.
    const page = pageOf(
      many(200).map((text) => text.padEnd(100, 'я')),
      0,
    );

    const rendered = page.items.join('\n');
    expect(rendered.length).toBeLessThan(4096);
  });
});

describe('реестр инструментов', () => {
  it('пуст — и это его нормальное состояние (§1.3)', () => {
    // Интеграций в первой версии нет и не будет. Реестр существует ради
    // того, чтобы однажды они не потребовали переписывать ядро.
    const registry = new ToolRegistry();

    expect(registry.size).toBe(0);
    expect(
      registry.for({
        item: { text: 'дело' } as never,
        timeZone: 'Europe/Moscow',
      }),
    ).toEqual([]);
  });

  it('фиктивный инструмент добавляется и находится', () => {
    const registry = new ToolRegistry();
    registry.add({ name: 'fake', label: 'Позвонить', suits: () => true });

    const found = registry.for({ item: { text: 'дело' } as never, timeZone: 'Europe/Moscow' });

    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('fake');
  });

  it('инструмент, которому запись не подходит, не предлагается', () => {
    const registry = new ToolRegistry();
    registry.add({
      name: 'call',
      label: 'Позвонить',
      suits: ({ item }) => item.text.includes('позвонить'),
    });

    expect(
      registry.for({ item: { text: 'купить хлеб' } as never, timeZone: 'Europe/Moscow' }),
    ).toEqual([]);
  });

  it('второй инструмент с тем же именем — ошибка, а не замена', () => {
    // Молчаливая замена означала бы, что порядок регистрации решает
    // поведение продукта.
    const registry = new ToolRegistry();
    registry.add({ name: 'call', label: 'Позвонить', suits: () => true });

    expect(() => {
      registry.add({ name: 'call', label: 'Другое', suits: () => true });
    }).toThrow('уже зарегистрирован');
  });
});

/**
 * Вопрос про предмет и вопрос про день (задача 3.66).
 *
 * **Найдено живым прогоном проджекта 04.09.2026.** Он спросил «Что у меня
 * сейчас есть по сайту и что мне нужно сделать по нему в ближайшее время?»
 * и получил список дел на сегодня, где про сайт была одна строка из
 * девяти. Слова «сейчас» и «ближайшее» стояли в списке «про сегодня», и
 * одного их присутствия было достаточно.
 *
 * Половина проверок ниже — про то, что вопрос про день по-прежнему
 * узнаётся: сломать различение легко в обе стороны.
 */
describe('вопрос про день или про предмет', () => {
  it('боевой вопрос проджекта — про предмет, а не про день', () => {
    expect(
      asksAboutToday(
        'Что у меня сейчас есть по сайту и что мне нужно сделать по нему в ближайшее время?',
      ),
    ).toBe(false);
  });

  it('вопрос про предмет со словом о времени — всё равно про предмет', () => {
    for (const text of [
      'Что у меня сейчас по информационной безопасности?',
      'Что сегодня по балкону?',
      'Что в ближайшее время с ноутбуком?',
      'Какие планы по стоматологу на сегодня?',
    ]) {
      expect(asksAboutToday(text), text).toBe(false);
    }
  });

  it('вопрос без предмета — про день, как и раньше', () => {
    for (const text of [
      'Что на сегодня?',
      'Что у меня сегодня?',
      'Что мне нужно сделать сегодня?',
      'Какие планы на сегодня?',
      'Что в ближайшее время?',
    ]) {
      expect(asksAboutToday(text), text).toBe(true);
    }
  });

  it('«сейчас» — не «сегодня»: «Что у меня сейчас есть?» — вопрос обо всём (ТЗ проджекта 17.09.2026, 2.4)', () => {
    for (const text of [
      'Что у меня сейчас есть?',
      'Что у меня сейчас?',
      'Что у меня накопилось?',
      'Покажи всё незавершённое',
      'Покажи все мои дела',
    ]) {
      expect(asksAboutToday(text), text).toBe(false);
      expect(asksAboutEverything(text), text).toBe(true);
    }
  });

  it('«напиши», «скинь», «пришли», «дай», «отправь» — слова просьбы, а не предмет (заказчица, бой 21.09.2026)', () => {
    /**
     * Бой: «Напиши мне все, что накопилось» → «Я здесь. Расскажешь, что
     * в голове?». «Напиши» не было в рамке, и вопрос обо всём не узнался.
     */
    for (const text of [
      'Напиши мне все, что накопилось',
      'скинь мои дела',
      'пришли список дел',
      'дай все задачи',
      'отправь мне всё, что записано',
    ]) {
      expect(asksAboutEverything(text), text).toBe(true);
    }

    // С предметом — вопрос про предмет, как и прежде.
    for (const text of ['напиши мне список покупок', 'скинь что там по работе']) {
      expect(asksAboutEverything(text), text).toBe(false);
    }
  });

  it('«расскажи», «ближайшую», «до конца этой недели» — рамка, а не предмет (прогон 18.09.2026)', () => {
    /**
     * Бой: «Расскажи мои задачи на ближайшую неделю» и «Расскажи мои
     * задачи до конца этой недели» → «Про это у меня ничего не
     * записано»: «расскажи», «ближайшую» и «конца» не были в рамке
     * вопроса, бот принял их за предмет и пошёл искать по смыслу.
     */
    for (const text of [
      'Расскажи мои задачи на ближайшую неделю',
      'Расскажи мои задачи до конца этой недели',
      'Расскажи, что у меня на неделе',
      'Перечисли дела на выходные',
      'Что до конца недели?',
    ]) {
      expect(askedDay(text), text).toBe(text.includes('выходные') ? 'weekend' : 'week');
    }
  });

  it('без слова о времени — не про день', () => {
    for (const text of [
      'Что там с альбомом?',
      'Напомни про день рождения',
      'Что у меня по работе?',
    ]) {
      expect(asksAboutToday(text), text).toBe(false);
    }
  });
});

describe('вопрос про отрезок дней: «на 3 дня», «на месяц», «во вторник» (21.09.2026)', () => {
  /**
   * Никита 21.09.2026: «а бот отвечает на „что у меня на эти 3 дня, 7
   * дней, месяц, какие планы на неделю"?» Отвечал только на сегодня,
   * завтра, выходные и неделю; остальное уходило в поиск предмета и
   * кончалось «не поняла». Закрытый список новых рамок: N дней,
   * «ближайшие дни», послезавтра, следующая неделя, месяц, названный
   * месяц, день недели.
   */
  it.each([
    ['что у меня на эти 3 дня', 'days:3'],
    ['что на 7 дней', 'days:7'],
    ['какие дела на ближайшие 3 дня', 'days:3'],
    ['что на три дня', 'days:3'],
    ['что у меня на пару дней', 'days:2'],
    ['что на ближайшие дни', 'days:3'],
    ['что на послезавтра', 'afterTomorrow'],
    ['что у меня послезавтра', 'afterTomorrow'],
    ['что у меня на следующей неделе', 'nextWeek'],
    ['какие планы на следующую неделю', 'nextWeek'],
    ['что у меня на месяц', 'month'],
    ['что в этом месяце', 'month'],
    ['что у меня в октябре', 'month:10'],
    ['какие планы на октябрь', 'month:10'],
    ['что у меня во вторник', 'weekday:2'],
    ['что в пятницу', 'weekday:5'],
    ['что там на воскресенье', 'weekday:0'],
    ['что в следующий вторник', 'weekday:2:next'],
  ])('«%s» → %s', (text, period) => {
    expect(askedDay(text)).toBe(period);
  });

  it('время суток — сегодня: «что вечером», «что утром», «что до конца дня» (21.09.2026)', () => {
    for (const text of [
      'что вечером',
      'что у меня утром',
      'что до конца дня',
      'что сегодня вечером',
    ]) {
      expect(askedDay(text), text).toBe('today');
    }
    // С предметом — про предмет: «что вечером с отчётом».
    expect(askedDay('что вечером с отчётом')).toBeUndefined();
  });

  it('прежние рамки не изменились', () => {
    expect(askedDay('что на завтра')).toBe('tomorrow');
    expect(askedDay('что на выходных')).toBe('weekend');
    expect(askedDay('какие планы на неделю')).toBe('week');
    expect(askedDay('что у меня на сегодня')).toBe('today');
  });

  it('с предметом — вопрос про предмет, а не про отрезок', () => {
    for (const text of [
      'что во вторник с отчётом',
      'что там с балконом на неделе',
      'что по стоматологу в октябре',
      'на 3 дня отложи отчёт',
    ]) {
      expect(askedDay(text), text).toBeUndefined();
    }
  });

  it('число дней вне разумного — не рамка', () => {
    expect(askedDay('что на 0 дней')).toBeUndefined();
    expect(askedDay('что на 45 дней')).toBeUndefined();
  });
});

describe('подпись отрезка после «На …»', () => {
  const label = (period: Parameters<typeof periodLabel>[0]): string =>
    periodLabel(period, defaultTexts.backlog);

  it.each([
    ['tomorrow', 'завтра'],
    ['afterTomorrow', 'послезавтра'],
    ['weekend', 'выходные'],
    ['week', 'неделю'],
    ['nextWeek', 'следующую неделю'],
    ['month', 'месяц'],
    ['days:1', '1 день'],
    ['days:3', '3 дня'],
    ['days:7', '7 дней'],
    ['month:10', 'октябрь'],
    ['weekday:2', 'вторник'],
    ['weekday:3', 'среду'],
    ['weekday:3:next', 'следующую среду'],
    ['weekday:0:next', 'следующее воскресенье'],
  ] as const)('%s → «%s»', (period, expected) => {
    expect(label(period)).toBe(expected);
  });
});

describe('окно отрезка — края, где легко ошибиться', () => {
  const MOSCOW = 'Europe/Moscow';
  const iso = (at: Date): string =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: MOSCOW }).format(at);
  const window = (period: Parameters<typeof periodWindow>[0], now: string): string => {
    const { from, to } = periodWindow(period, { now: new Date(now), timeZone: MOSCOW });
    return `${iso(from)}..${iso(to)}`;
  };

  it('«следующая неделя» в воскресенье — с завтрашнего понедельника, в понедельник — через неделю', () => {
    expect(window('nextWeek', '2026-09-06T09:00:00.000Z')).toBe('2026-09-07..2026-09-14');
    expect(window('nextWeek', '2026-09-07T09:00:00.000Z')).toBe('2026-09-14..2026-09-21');
  });

  it('названный месяц раньше текущего — в следующем году; декабрь не ломает год', () => {
    expect(window('month:3', '2026-09-21T09:00:00.000Z')).toBe('2027-03-01..2027-04-01');
    expect(window('month:12', '2026-09-21T09:00:00.000Z')).toBe('2026-12-01..2027-01-01');
  });

  it('день недели, совпадающий с сегодняшним, вечером — через неделю, как у разбора сроков', () => {
    // Понедельник 21.09, 18:00 по Москве: «в понедельник» — 28.09.
    expect(window('weekday:1', '2026-09-21T15:00:00.000Z')).toBe('2026-09-28..2026-09-29');
    expect(window('weekday:1:next', '2026-09-21T15:00:00.000Z')).toBe('2026-10-05..2026-10-06');
  });
});

describe('окно «что я сделала» — смотрит назад, а не вперёд', () => {
  const MOSCOW = 'Europe/Moscow';
  const iso = (at: Date): string =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: MOSCOW }).format(at);
  const window = (period: Parameters<typeof doneWindow>[0], now: string): string => {
    const { from, to } = doneWindow(period, { now: new Date(now), timeZone: MOSCOW });
    return `${iso(from)}..${iso(to)}`;
  };
  // Пятница 04.09.2026, 12:00 по Москве.
  const NOW = '2026-09-04T09:00:00.000Z';

  it('сегодня, вчера, неделя (7 дней включая сегодня), месяц (30), N дней', () => {
    expect(window('today', NOW)).toBe('2026-09-04..2026-09-05');
    expect(window('yesterday', NOW)).toBe('2026-09-03..2026-09-04');
    expect(window('week', NOW)).toBe('2026-08-29..2026-09-05');
    expect(window('month', NOW)).toBe('2026-08-06..2026-09-05');
    expect(window('days:3', NOW)).toBe('2026-09-02..2026-09-05');
  });

  it('названный месяц — прошедший: август в сентябре — этого года, октябрь — прошлого', () => {
    expect(window('month:8', NOW)).toBe('2026-08-01..2026-09-01');
    expect(window('month:10', NOW)).toBe('2025-10-01..2025-11-01');
    // Текущий месяц — с его начала по сегодня.
    expect(window('month:9', NOW)).toBe('2026-09-01..2026-09-05');
  });

  it('день недели — последний такой; выходные — последние; будущие рамки читаются как неделя', () => {
    expect(window('weekday:2', NOW)).toBe('2026-09-01..2026-09-02');
    expect(window('weekday:5', NOW)).toBe('2026-09-04..2026-09-05');
    expect(window('weekend', NOW)).toBe('2026-08-29..2026-08-31');
    expect(window('tomorrow', NOW)).toBe('2026-08-29..2026-09-05');
    expect(window('nextWeek', NOW)).toBe('2026-08-29..2026-09-05');
  });
});
