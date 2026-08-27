import type { GluedPiece } from './audio.service.js';
import type { RecognizedUtterance } from './providers/types.js';

/**
 * Раскладка склеенной расшифровки обратно по сообщениям (задача 1.14,
 * дополнено 27.08.2026).
 *
 * Голосовые одной выгрузки склеиваются в один файл и распознаются одним
 * запросом: SpeechKit берёт деньги блоками по 15 секунд за запрос, и девять
 * округлений вверх вместо одного превращают 172 секунды речи в 255
 * оплаченных. Но расшифровка обязана вернуться в то сообщение, из которого
 * пришла: на ней держится и выгрузка данных по §16, и повторный заход после
 * сбоя, и порядок склейки текста выгрузки.
 *
 * **Раскладываем фразами, а не словами.** Пунктуация и заглавные буквы есть
 * только у текста фразы целиком; в словах SpeechKit отдаёт голые токены с
 * маленькой буквы. Поэтому фраза целиком уходит тому сообщению, в котором
 * началась. По словам фраза делится только если она перескочила границу —
 * и тогда потеря пунктуации касается одной фразы, а не всей выгрузки.
 *
 * **Границы проходят посередине паузы.** Пауза между записями — вставленная
 * нами тишина, слов в ней нет. Значит промах хоть на десяток миллисекунд
 * никуда слово не перенесёт: до ошибки надо сдвинуться на полпаузы.
 */

export interface AttributedPiece {
  readonly messageId: string;
  /** Расшифровка этого сообщения. Пустая строка — в записи не было речи. */
  readonly text: string;
}

export interface Attribution {
  readonly pieces: readonly AttributedPiece[];
  /** Сколько фраз пришлось делить: они перескочили границу сообщений. */
  readonly split: number;
}

/**
 * Фраза без слов раскладке не поддаётся.
 *
 * Это не мелкая неприятность, а повод отказаться от склейки целиком:
 * приписать текст наугад значило бы тихо соврать о том, что человек
 * сказал и когда. Вызывающий код ловит это и расшифровывает по одному
 * сообщению — дороже, зато честно.
 */
export class AttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttributionError';
  }
}

/**
 * Границы между сообщениями — середины пауз.
 *
 * Первая граница минус бесконечность, последняя плюс: слово раньше первой
 * записи или позже последней всё равно должно куда-то попасть, и крайние
 * сообщения — единственный осмысленный ответ.
 */
function edgesOf(pieces: readonly GluedPiece[]): readonly number[] {
  const edges = [Number.NEGATIVE_INFINITY];

  for (let index = 1; index < pieces.length; index++) {
    const previous = pieces[index - 1];
    const current = pieces[index];
    if (previous === undefined || current === undefined) continue;

    edges.push((previous.endSec + current.startSec) / 2);
  }

  edges.push(Number.POSITIVE_INFINITY);
  return edges;
}

function pieceAt(edges: readonly number[], seconds: number): number {
  for (let index = 0; index + 1 < edges.length; index++) {
    const from = edges[index] ?? Number.NEGATIVE_INFINITY;
    const to = edges[index + 1] ?? Number.POSITIVE_INFINITY;
    if (seconds >= from && seconds < to) return index;
  }

  return Math.max(0, edges.length - 2);
}

export function attribute(
  pieces: readonly GluedPiece[],
  utterances: readonly RecognizedUtterance[],
): Attribution {
  if (pieces.length === 0) throw new AttributionError('раскладывать не по чему');

  const edges = edgesOf(pieces);
  const chunks = pieces.map((): string[] => []);
  let split = 0;

  for (const utterance of utterances) {
    if (utterance.text === '') continue;

    if (utterance.words.length === 0) {
      throw new AttributionError(`фраза «${utterance.text.slice(0, 40)}» пришла без времён`);
    }

    const indexes = utterance.words.map((word) => pieceAt(edges, word.startMs / 1000));
    const first = indexes[0] ?? 0;

    if (indexes.every((index) => index === first)) {
      // Обычный случай: фраза целиком внутри одного сообщения — и уходит
      // туда как есть, со знаками и заглавными буквами.
      chunks[first]?.push(utterance.text);
      continue;
    }

    // Редкий случай: распознаватель не разорвал фразу на нашей паузе.
    // Делим по словам — пунктуацию теряет только эта фраза.
    split++;
    let current = first;
    let words: string[] = [];

    const flush = (): void => {
      if (words.length > 0) chunks[current]?.push(words.join(' '));
      words = [];
    };

    for (const [position, word] of utterance.words.entries()) {
      const index = indexes[position] ?? current;
      if (index !== current) {
        flush();
        current = index;
      }
      words.push(word.text);
    }

    flush();
  }

  return {
    pieces: pieces.map((piece, index) => ({
      messageId: piece.messageId,
      text: (chunks[index] ?? []).join(' ').trim(),
    })),
    split,
  };
}
