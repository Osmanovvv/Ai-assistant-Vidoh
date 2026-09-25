/**
 * Обрывок правки, сказанный потом целиком («с нуля» Никиты 25.09.2026,
 * 17:10).
 *
 * Голосовое «Перенеси стоматолога на после.» оборвалось, и человек тут
 * же сказал заново: «Перенеси стоматолога на послезавтра в 7.». Обе
 * фразы легли в одну выгрузку, и обрывок ушёл в резолвер отдельной
 * правкой: лишний вызов модели и ответ «Там уже так — менять нечего»
 * рядом с настоящим переносом. Хуже того, обрывок мог бы занять
 * единственный вопрос обмена (§13.9) — и вопрос о часе полной фразы уже
 * не прозвучал бы.
 *
 * Признак — сам текст: правка, с которой **начинается** одна из
 * следующих фраз выгрузки (или равная ей), — начатое заново. Сравнение
 * по буквам и цифрам, без знаков и регистра: обрыв бывает посреди слова
 * («на пос…»). Обрывком бывает только правка — у мыслей и вопросов свои
 * отсевы, а «Купить хлеб. Купить хлеб и молоко.» разбор склеит сам.
 *
 * Продолжение через «и», «а», «ещё», «также» — добавка, а не начатое
 * заново: «Удали хлеб.» и «Удали хлеб и масло.» — обе правки, иначе хлеб
 * мог бы остаться.
 */
const ADDITION = new Set(['и', 'а', 'еще', 'также', 'плюс']);
export function restartedFragments(
  segments: readonly { readonly intent: string; readonly text: string }[],
  resolved: (intent: string) => boolean,
): ReadonlySet<number> {
  const keys = segments.map((segment) => keyOf(segment.text));
  const fragments = new Set<number>();

  for (const [index, segment] of segments.entries()) {
    if (!resolved(segment.intent)) continue;
    const own = keys[index] ?? '';
    if (!/\p{L}/u.test(own)) continue;
    const restarts = keys.some(
      (other, later) => later > index && other.startsWith(own) && !addsTo(other.slice(own.length)),
    );
    if (restarts) fragments.add(index);
  }

  return fragments;
}

/** Хвост полной фразы начинается целым словом-союзом: это добавка. */
function addsTo(rest: string): boolean {
  if (!rest.startsWith(' ')) return false;
  const [first] = rest.trim().split(' ');
  return first !== undefined && ADDITION.has(first);
}

function keyOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
