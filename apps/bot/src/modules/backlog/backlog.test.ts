import { describe, expect, it } from 'vitest';

import { pageOf, PAGE_SIZE } from './backlog.service.js';
import { ToolRegistry } from './tools.js';
import { asksAboutToday } from './query.service.js';

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
      'Что у меня сейчас?',
      'Что мне нужно сделать сегодня?',
      'Какие планы на сегодня?',
      'Что в ближайшее время?',
    ]) {
      expect(asksAboutToday(text), text).toBe(true);
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
