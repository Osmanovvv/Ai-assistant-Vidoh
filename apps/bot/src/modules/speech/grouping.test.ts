import { describe, expect, it } from 'vitest';

import { blocksOf, groupVoices, type GroupingOptions } from './grouping.js';

/**
 * Раскладка голосовых по запросам (задача 1.14).
 *
 * SpeechKit берёт деньги блоками по 15 секунд за запрос, поэтому вопрос
 * «сколько запросов и каких» — это вопрос счёта. Проверяется и он, и то,
 * что раскладка не теряет ни одной записи и не меняет их порядок: порядок
 * держит склейку текста выгрузки.
 */

const OPTIONS: GroupingOptions = { capacitySec: 82, pauseSec: 1, blockSec: 15 };

function voices(
  ...durations: readonly number[]
): readonly { messageId: string; durationSec: number }[] {
  return durations.map((durationSec, index) => ({
    messageId: `м${String(index)}`,
    durationSec,
  }));
}

/** Как считалось до склейки: каждая запись — свой запрос, своё округление. */
function onePerMessage(durations: readonly number[]): number {
  return durations.reduce((sum, seconds) => sum + Math.ceil(seconds / OPTIONS.blockSec), 0);
}

describe('живая выгрузка 27.08.2026', () => {
  // Девять голосовых, 172 секунды речи. По записанному учёту расхода
  // семнадцать блоков и 2,7642 ₽ — числа не выдуманы, а взяты из ai_calls.
  const REAL = [77, 29, 20, 5, 17, 9, 4, 8, 3];

  it('семнадцать блоков превращаются в тринадцать', () => {
    expect(onePerMessage(REAL)).toBe(17);
    expect(blocksOf(groupVoices(voices(...REAL), OPTIONS), OPTIONS)).toBe(13);
  });

  it('запросов три, а не девять и не пять', () => {
    // Пять групп по тринадцать блоков тоже существуют — та же цена, но
    // пять ожиданий вместо трёх. Ничья разрешается в пользу меньшего
    // числа запросов.
    expect(groupVoices(voices(...REAL), OPTIONS)).toHaveLength(3);
  });

  it('ни одна запись не потеряна и порядок сохранён', () => {
    const groups = groupVoices(voices(...REAL), OPTIONS);
    const flat = groups.flat().map((voice) => voice.durationSec);

    expect(flat).toEqual(REAL);
  });
});

describe('раскладка', () => {
  it('пустой список — пустая раскладка', () => {
    expect(groupVoices([], OPTIONS)).toEqual([]);
  });

  it('короткие записи собираются в один запрос', () => {
    const groups = groupVoices(voices(3, 4, 5), OPTIONS);

    expect(groups).toHaveLength(1);
    // 3 + 1 + 4 + 1 + 5 = 14 секунд, то есть один блок вместо трёх.
    expect(blocksOf(groups, OPTIONS)).toBe(1);
    expect(onePerMessage([3, 4, 5])).toBe(3);
  });

  it('запись, не влезающая в запрос, идёт отдельно и рвёт цепочку', () => {
    // Такую всё равно придётся резать по паузам внутри самой записи —
    // это умеет путь по одному сообщению.
    const groups = groupVoices(voices(4, 300, 6), OPTIONS);

    expect(groups.map((group) => group.map((voice) => voice.durationSec))).toEqual([
      [4],
      [300],
      [6],
    ]);
  });

  it('две длинные подряд не сливаются', () => {
    const groups = groupVoices(voices(300, 400), OPTIONS);

    expect(groups).toHaveLength(2);
  });

  it('точный перебор дешевле жадного набивания', () => {
    // Жадная раскладка набила бы первую группу до 82 секунд (шесть
    // блоков) и заплатила четырнадцать. Найдено перебором раскладов
    // 27.08.2026.
    const groups = groupVoices(voices(56, 21, 31, 33, 34), OPTIONS);

    expect(blocksOf(groups, OPTIONS)).toBe(13);
  });

  it('пауза учитывается в вместимости, а не забывается', () => {
    // Две записи по 41 секунде дают 41 + 1 + 41 = 83 > 82: вместе они не
    // влезают, хотя без паузы влезли бы ровно.
    expect(groupVoices(voices(41, 41), OPTIONS)).toHaveLength(2);
    expect(groupVoices(voices(40, 41), OPTIONS)).toHaveLength(1);
  });

  it('одна запись — один запрос', () => {
    expect(groupVoices(voices(30), OPTIONS)).toEqual([[{ messageId: 'м0', durationSec: 30 }]]);
  });
});
