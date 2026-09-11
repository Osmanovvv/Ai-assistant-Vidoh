import { describe, expect, it } from 'vitest';

import type { ClassifiedItem } from '../modules/classifier/classifier.service.js';
import { anchorLine, unverifiedAnchorsIn } from './unverified-anchor.js';

/**
 * Правила, стоящие на непроверенном якоре, — счёт для прогона набора
 * (находка 10.09.2026).
 *
 * **Зачем это число.** Вторая находка спрашивает: можно ли выбрасывать
 * правило повторения вместе с отвергнутым сроком? Ответить на это без
 * денег нельзя, но и платить дважды не за что: сочетание «правило есть,
 * проверенного срока нет» — единственное, которого такая строгость
 * коснётся. Сосчитай его в прогоне — и цена строгости названа числом,
 * а не спором.
 *
 * **Признак берётся из готовых записей, а не из внутренностей разбора.**
 * Якорь при отвергнутом сроке может прийти только из строки модели —
 * значит «есть правило и нет срока» и есть тот самый случай, целиком.
 * Считать его снаружи дешевле и честнее: разбор ради замера не трогаем.
 */

function item(over: Partial<ClassifiedItem> = {}): ClassifiedItem {
  return {
    text: 'собирать сыну обед в школу',
    type: 'TASK',
    priority: 'SOON',
    topic: 'семья',
    isProject: false,
    ...over,
  };
}

const rule = { kind: 'weekdays' as const, interval: 1, anchor: '2026-09-07' };

describe('правила на непроверенном якоре', () => {
  it('правило есть, срока нет — это тот самый случай', () => {
    const found = unverifiedAnchorsIn([
      item({ recurrence: { rule, text: 'по будням', source: 'stated' } }),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe('собирать сыну обед в школу');
    expect(found[0]?.kind).toBe('weekdays');
    expect(found[0]?.anchor).toBe('2026-09-07');
    expect(found[0]?.said).toBe('по будням');
  });

  it('правило со сроком не считается: якорь пришёл из проверенного', () => {
    const found = unverifiedAnchorsIn([
      item({
        deadline: { at: new Date('2026-09-06T21:00:00.000Z'), accuracy: 'day' },
        recurrence: { rule, text: 'по будням', source: 'stated' },
      }),
    ]);

    expect(found).toEqual([]);
  });

  it('фраза без правила не считается: выбрасывать нечего', () => {
    // «Правило не собралось» — уже сегодняшнее поведение, строгость его
    // не изменит.
    const found = unverifiedAnchorsIn([
      item({ recurrence: { text: 'как получится', source: 'stated' } }),
    ]);

    expect(found).toEqual([]);
  });

  it('запись без повторения не считается', () => {
    expect(unverifiedAnchorsIn([item()])).toEqual([]);
  });
});

/**
 * Сама строка отчёта — отдельной проверкой.
 *
 * Печать живёт в скрипте прогона, и поведенческой проверки у неё быть не
 * может без прогона. Поэтому вынесена наружу хотя бы **формулировка**:
 * число без объясняющей строки в этом проекте уже стоило часа разбора, и
 * строка, молча съевшая слова человека, стоила бы столько же.
 */
describe('строка отчёта про непроверенный якорь', () => {
  it('называет запись, вид правила, дату и слова человека', () => {
    const line = anchorLine('recurrence', {
      text: 'собирать сыну обед в школу',
      kind: 'weekdays',
      anchor: '2026-09-07',
      said: 'по будням',
    });

    expect(line).toContain('[recurrence]');
    expect(line).toContain('собирать сыну обед в школу');
    expect(line).toContain('weekdays');
    expect(line).toContain('2026-09-07');
    expect(line).toContain('по будням');
  });

  it('без слов человека хвост не приписывается пустыми кавычками', () => {
    const line = anchorLine('recurrence', {
      text: 'платить уборщице',
      kind: 'weekly',
      anchor: '2026-09-07',
      said: '',
    });

    expect(line).not.toContain('«»');
  });
});
