/** Закрытый словарь согласия; ответы на открытые вопросы читаются раньше него. */
export const ACK_WORDS: ReadonlySet<string> = new Set([
  'ок',
  'окей',
  'ok',
  'okay',
  'понятно',
  'ясно',
  'ага',
  'угу',
  'хорошо',
  'ладно',
  'понял',
  'поняла',
  'принято',
  'договорились',
  'супер',
  'отлично',
]);

const AROUND: ReadonlySet<string> = new Set(['да', 'ну', 'все', 'я']);

/** Только согласие: «да, поняла», но не «поняла, что надо купить хлеб». */
export function onlyAgreementAck(text: string): boolean {
  if (text.includes('?') || /[«»„“”‘’"'`]/u.test(text)) return false;
  const words =
    text
      .toLowerCase()
      .replace(/ё/gu, 'е')
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return (
    words.some((word) => ACK_WORDS.has(word)) &&
    words.every((word) => ACK_WORDS.has(word) || AROUND.has(word))
  );
}
