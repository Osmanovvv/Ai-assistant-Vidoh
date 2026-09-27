/**
 * «Спасибо» — по закрытому списку слов, целыми словами (заказчица,
 * 16.09.2026). Благодарность — одна из немногих ситуаций, где бот ставит
 * фирменное 🤍; маршрутизатор отдаёт такое как SMALLTALK, и прежде на него
 * приходило «Я здесь. Расскажешь, что в голове?» — будто не услышал.
 *
 * Правило, а не догадка: слово либо есть, либо нет. «Спасибочки» и прочие
 * формы сюда не входят намеренно — лучше промолчать, чем поставить сердечко
 * не туда.
 */
const THANKS = ['спасибо', 'благодарю'] as const;

function wordsOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');
}

export function saysThanks(text: string): boolean {
  const words = wordsOf(text);

  return THANKS.some((word) => words.includes(word));
}

/**
 * Что может стоять рядом с благодарностью, не делая её чем-то ещё:
 * обращение, сила, «за всё», «ты очень помогла». Закрытый список: на
 * чистую благодарность бот отвечает сразу, без модели (Никита,
 * 27.09.2026), — и всё, что сверх неё, обязано уйти в разбор.
 */
const AROUND_THANKS = new Set([
  'тебе',
  'тебя',
  'вам',
  'вас',
  'ты',
  'вы',
  'выдох',
  'большое',
  'огромное',
  'очень',
  'за',
  'все',
  'помощь',
  'помогла',
  'помогаешь',
  'выручила',
  'выручаешь',
  'ой',
  'ну',
]);

/** Сообщение — одна благодарность, и ничего сверх неё. */
export function onlyThanks(text: string | undefined): boolean {
  if (text === undefined) return false;

  const words = wordsOf(text);
  return (
    THANKS.some((word) => words.includes(word)) &&
    words.every((word) => (THANKS as readonly string[]).includes(word) || AROUND_THANKS.has(word))
  );
}
