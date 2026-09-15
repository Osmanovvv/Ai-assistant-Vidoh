import { describe, expect, it } from 'vitest';

import { cleanTitle } from './title.js';

/**
 * Заголовок дела — чистое повеление (видео заказчицы 15.09.2026).
 *
 * Извлечение обязано переписывать мысль в повеление, но модель это
 * делает не всегда: на бою «Хочу завтра съездить в офис…» и «Надо
 * отправить заявление…» ушли в карточки и в вечернее напоминание как
 * есть. Срез — кодом, по закрытому списку слов, только у дел.
 */
describe('cleanTitle', () => {
  const task = { type: 'TASK', hasDeadline: false } as const;
  const dated = { type: 'TASK', hasDeadline: true } as const;

  it('срезает ведущее «надо / нужно / хочу» и поднимает первую букву', () => {
    expect(cleanTitle('Надо отправить заявление', task)).toBe('Отправить заявление');
    expect(cleanTitle('нужно позвонить маме', task)).toBe('Позвонить маме');
    expect(cleanTitle('Хочу съездить в офис', task)).toBe('Съездить в офис');
    expect(cleanTitle('Мне надо к врачу', task)).toBe('К врачу');
    expect(cleanTitle('Надо бы ещё купить хлеб', task)).toBe('Купить хлеб');
    expect(cleanTitle('Хотелось бы разобрать балкон', task)).toBe('Разобрать балкон');
  });

  it('слово о дне срезает только когда день уже стал сроком', () => {
    expect(cleanTitle('Хочу завтра съездить в офис', dated)).toBe('Съездить в офис');
    expect(cleanTitle('Завтра позвонить в банк', dated)).toBe('Позвонить в банк');
    expect(cleanTitle('Завтра позвонить в банк', task)).toBe('Завтра позвонить в банк');
    expect(cleanTitle('Сегодня вечером погулять с собакой', dated)).toBe(
      'Вечером погулять с собакой',
    );
  });

  it('целые слова: «надолго», «нужные» и «хочется» внутри не трогает', () => {
    expect(cleanTitle('Надолго уехать к маме', task)).toBe('Надолго уехать к маме');
    expect(cleanTitle('Нужные документы собрать', task)).toBe('Нужные документы собрать');
    expect(cleanTitle('Купить то, что хочется', task)).toBe('Купить то, что хочется');
  });

  it('не у дела — как есть: у желания «хочу» это смысл', () => {
    expect(
      cleanTitle('Хочу научиться играть на гитаре', { type: 'DESIRE', hasDeadline: false }),
    ).toBe('Хочу научиться играть на гитаре');
    expect(cleanTitle('Надо бы отдохнуть', { type: 'EMOTION', hasDeadline: false })).toBe(
      'Надо бы отдохнуть',
    );
  });

  it('если после среза не остаётся дела — оставляет как было', () => {
    expect(cleanTitle('Надо', task)).toBe('Надо');
    expect(cleanTitle('Хочу завтра', dated)).toBe('Хочу завтра');
    expect(cleanTitle('  надо  ', task)).toBe('  надо  ');
  });
});
