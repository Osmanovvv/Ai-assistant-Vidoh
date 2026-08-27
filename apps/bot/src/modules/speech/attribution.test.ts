import { describe, expect, it } from 'vitest';

import { attribute, AttributionError } from './attribution.js';
import type { GluedPiece } from './audio.service.js';
import type { RecognizedUtterance } from './providers/types.js';

/**
 * Раскладка склеенной расшифровки по сообщениям (задача 1.14).
 *
 * Цена ошибки здесь — не деньги, а правда: слово, приписанное чужому
 * сообщению, искажает и выгрузку данных по §16, и порядок текста выгрузки.
 * Поэтому проверяется и обычный случай, и промах времён внутрь паузы, и
 * фраза, перескочившая границу.
 */

/** Три записи по 3 секунды с паузой в полсекунды между ними. */
const PIECES: readonly GluedPiece[] = [
  { messageId: 'первое', startSec: 0, endSec: 3 },
  { messageId: 'второе', startSec: 3.5, endSec: 6.5 },
  { messageId: 'третье', startSec: 7, endSec: 10 },
];

function words(
  ...pairs: readonly [string, number][]
): readonly { text: string; startMs: number; endMs: number }[] {
  return pairs.map(([text, startMs]) => ({ text, startMs, endMs: startMs + 300 }));
}

function utterance(text: string, ...pairs: readonly [string, number][]): RecognizedUtterance {
  return { text, words: words(...pairs) };
}

describe('раскладка по сообщениям', () => {
  it('каждая фраза уходит в своё сообщение со знаками и заглавными', () => {
    const result = attribute(PIECES, [
      utterance('Купить продукты.', ['купить', 500], ['продукты', 1200]),
      utterance(
        'Записать сына к врачу.',
        ['записать', 3800],
        ['сына', 4400],
        ['к', 4900],
        ['врачу', 5200],
      ),
      utterance('Продлить страховку.', ['продлить', 7300], ['страховку', 8000]),
    ]);

    expect(result.pieces).toEqual([
      { messageId: 'первое', text: 'Купить продукты.' },
      { messageId: 'второе', text: 'Записать сына к врачу.' },
      { messageId: 'третье', text: 'Продлить страховку.' },
    ]);
    expect(result.split).toBe(0);
  });

  it('две фразы одного сообщения сохраняют порядок', () => {
    const result = attribute(PIECES, [
      utterance('Первая мысль.', ['первая', 200]),
      utterance('Вторая мысль.', ['вторая', 1500]),
    ]);

    expect(result.pieces[0]?.text).toBe('Первая мысль. Вторая мысль.');
  });

  it('запись без речи даёт пустую расшифровку, а не чужую', () => {
    const result = attribute(PIECES, [utterance('Только первое.', ['только', 300])]);

    expect(result.pieces[1]?.text).toBe('');
    expect(result.pieces[2]?.text).toBe('');
  });

  it('промах времён внутрь паузы слово не переносит', () => {
    // Слово принадлежит второй записи (3,5 … 6,5), но время пришло на
    // 3,4 с — внутри паузы. Граница проходит посередине паузы, на 3,25,
    // поэтому слово всё равно во втором сообщении.
    const result = attribute(PIECES, [utterance('Почти на стыке.', ['почти', 3400])]);

    expect(result.pieces[1]?.text).toBe('Почти на стыке.');
    expect(result.pieces[0]?.text).toBe('');
  });

  it('фраза, перескочившая границу, делится по словам', () => {
    // Распознаватель не разорвал фразу на нашей паузе. Пунктуацию теряет
    // только она, и это видно в счётчике.
    const result = attribute(PIECES, [
      utterance(
        'Купить продукты записать сына.',
        ['купить', 500],
        ['продукты', 1200],
        ['записать', 3800],
        ['сына', 4400],
      ),
    ]);

    expect(result.pieces[0]?.text).toBe('купить продукты');
    expect(result.pieces[1]?.text).toBe('записать сына');
    expect(result.split).toBe(1);
  });

  it('фраза без времён — отказ, а не догадка', () => {
    // Приписать текст наугад значило бы тихо соврать о том, кто что
    // сказал. Вызывающий код на это переходит к расшифровке по одному
    // сообщению: дороже, зато честно.
    expect(() => attribute(PIECES, [{ text: 'Без времён.', words: [] }])).toThrow(AttributionError);
  });

  it('слово раньше первой записи попадает в первую, а не в никуда', () => {
    const result = attribute(PIECES, [utterance('Самое начало.', ['самое', 0])]);

    expect(result.pieces[0]?.text).toBe('Самое начало.');
  });

  it('пустой список сообщений — ошибка', () => {
    expect(() => attribute([], [])).toThrow(AttributionError);
  });
});
