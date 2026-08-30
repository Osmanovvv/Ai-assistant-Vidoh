import { describe, expect, it } from 'vitest';

import { pageOf, PAGE_SIZE } from './backlog.service.js';
import { ToolRegistry } from './tools.js';

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
