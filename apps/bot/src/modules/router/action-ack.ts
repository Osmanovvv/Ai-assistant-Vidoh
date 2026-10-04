import { onlyAgreementAck } from '../presenter/acknowledgement.js';
import { onlyThanks } from '../presenter/thanks.js';
import { opensWithAction } from './thought-words.js';
import type { Segment } from './router.service.js';

/**
 * Разговорные подтверждения не создают дела (заказчица, 02.10.2026).
 * Сверяется вся фраза: названное дело, срок, вопрос, отрицание и цитата
 * остаются в обычном разборе. Начало работы не означает её завершение.
 */
const ACTION_ACKS: readonly string[] = [
  'пошла делать',
  'пошел делать',
  'пойду делать',
  'пойду сделаю',
  'приступаю',
  'начинаю',
  'сейчас займусь',
  'берусь за дело',
  'займусь этим',
];

function wordsOf(text: string): readonly string[] {
  return (
    text
      .toLowerCase()
      .replace(/ё/gu, 'е')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** Вводные без содержания могут стоять перед «я приступаю». */
function onlyLead(text: string): boolean {
  const words = wordsOf(text);
  return (
    words.every((word) => ['да', 'ну', 'все', 'я'].includes(word)) ||
    onlyAgreementAck(text) ||
    onlyThanks(text)
  );
}

/** «Приступаю», «спасибо, пойду сделаю» — без названия дела и нового срока. */
export function onlyActionAck(text: string): boolean {
  if (text.includes('?') || /[«»„“”‘’"'`]/u.test(text)) return false;
  const words = wordsOf(text);
  return ACTION_ACKS.some((phrase) => {
    const parts = phrase.split(' ');
    const start = words.length - parts.length;
    return (
      start >= 0 &&
      parts.every((part, offset) => words[start + offset] === part) &&
      onlyLead(words.slice(0, start).join(' '))
    );
  });
}

/** Согласие, благодарность или начало действий — без конкретного нового дела. */
export function onlyConversationAck(text: string): boolean {
  return onlyAgreementAck(text) || onlyThanks(text) || onlyActionAck(text);
}

interface Piece {
  readonly start: number;
  readonly end: number;
  readonly comma: boolean;
}

/** Границы вне кавычек и скобок; исходные пробелы и знаки сохраняются. */
function piecesOf(text: string): readonly Piece[] {
  const pieces: Piece[] = [];
  const closings: string[] = [];
  const pairs: Readonly<Record<string, string>> = {
    '«': '»',
    '“': '”',
    '„': '“',
    '‘': '’',
    "'": "'",
    '"': '"',
    '`': '`',
    '(': ')',
    '[': ']',
  };
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at] ?? '';
    if (closings.at(-1) === char) {
      closings.pop();
      continue;
    }
    const close = pairs[char];
    if (close !== undefined) {
      closings.push(close);
      continue;
    }
    if (closings.length > 0) continue;
    const comma = char === ',';
    const boundary =
      comma ||
      char === ';' ||
      char === '\n' ||
      (/[.!?…]/u.test(char) && /\s/u.test(text[at + 1] ?? ''));
    if (!boundary) continue;
    pieces.push({ start, end: at + 1, comma });
    start = at + 1;
  }
  if (start < text.length) pieces.push({ start, end: text.length, comma: false });
  return pieces.filter((piece) => text.slice(piece.start, piece.end).trim() !== '');
}

/** После запятой должно начинаться самостоятельное дело, а не его предмет. */
function startsThought(text: string): boolean {
  const flat = wordsOf(text).join(' ');
  return (
    opensWithAction(text) ||
    /^(?:(?:и|а|еще|кстати|потом|также|ну)\s+)*(?:(?:мне|я)\s+)?(?:надо|нужно|необходимо|должна|должен|должны|обязательно|не забыть|не забудь|планирую|собираюсь|придется)(?!\p{L})/u.test(
      flat,
    )
  );
}

/**
 * «Спасибо, поняла, ещё надо позвонить маме» разделяется на ответ и дело.
 * «Пойду делать, отчёт» и названия в кавычках сохраняются целиком.
 * Ответы, правки, вопросы, выполнение и отмена здесь не переопределяются.
 */
export function splitConversationAcks(segments: readonly Segment[]): readonly Segment[] {
  return segments.flatMap((segment) => {
    if (segment.intent !== 'DUMP' && segment.intent !== 'SMALLTALK') return [segment];
    if (onlyConversationAck(segment.text)) return [{ ...segment, intent: 'SMALLTALK' as const }];

    const pieces = piecesOf(segment.text);
    const classified = pieces.map((piece, index) => {
      const text = segment.text.slice(piece.start, piece.end).trim();
      const next = pieces[index + 1];
      const tail = next === undefined ? '' : segment.text.slice(next.start, next.end).trim();
      return (
        onlyConversationAck(text) &&
        (!piece.comma || next === undefined || onlyConversationAck(tail) || startsThought(tail))
      );
    });
    const merged: { start: number; end: number; intent: Segment['intent']; ack: boolean }[] = [];
    let found = false;
    for (const [index, piece] of pieces.entries()) {
      // Подтверждение после запятой внутри самого дела не вырезается:
      // «Купить открытку, спасибо» может содержать её название.
      const ack =
        classified[index] === true &&
        (index === 0 || pieces[index - 1]?.comma !== true || merged.at(-1)?.ack === true);
      found ||= ack;
      const intent = ack ? 'SMALLTALK' : segment.intent;
      const last = merged.at(-1);
      if (last?.intent === intent && last.ack === ack) last.end = piece.end;
      else merged.push({ start: piece.start, end: piece.end, intent, ack });
    }
    return found
      ? merged.map((part) => ({
          intent: part.intent,
          text: segment.text.slice(part.start, part.end).trim(),
        }))
      : [segment];
  });
}
