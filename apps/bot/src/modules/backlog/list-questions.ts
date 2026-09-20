import { askedDay, type AskedPeriod } from './periods.js';
import { FRAME_WORDS, normalizeText, wordsOf } from './question-words.js';

/**
 * Вопросы-списки по признаку (21.09.2026, список Никиты).
 *
 * Бот отвечал на «что на сегодня», «что на неделе», «покажи всё» и на
 * вопрос про конкретное дело. Остальное — «что просрочено», «сколько у
 * меня дел», «с чего начать», «что я записала», «что я сделала», «покажи
 * желания» — уходило в поиск предмета по словам и кончалось «не поняла».
 *
 * Правило то же, что у отрезков (`periods.ts`): закрытая рамка-признак,
 * а всё, что сверх рамки и слов о времени, — предмет, и тогда это вопрос
 * про предмет («что просрочено по отчёту» — про отчёт), не про список.
 * Утверждение с предметом («сделала отчёт») сюда не попадает по той же
 * причине. Порядок проверок важен: «не успела» — просрочено, а не
 * «сделано».
 */

export type ListQuestion =
  /** «Что просрочено», «что я не успела», «что горит». */
  | { readonly kind: 'overdue' }
  /** «Что на потом», «что я отложила». */
  | { readonly kind: 'later' }
  /** «Что без срока». */
  | { readonly kind: 'undated' }
  /** «Сколько у меня дел». */
  | { readonly kind: 'count' }
  /** «Что важное», «с чего начать» — то же, что кнопка «Выбрать главное». */
  | { readonly kind: 'pick' }
  /** «Что я сегодня записала» / «что последнее записала». */
  | { readonly kind: 'recent'; readonly scope: 'today' | 'last' }
  /** «Что я сделала [за отрезок]»; без отрезка — за неделю. */
  | { readonly kind: 'done'; readonly period: 'today' | 'yesterday' | AskedPeriod }
  /** «Покажи желания / идеи / цели». */
  | { readonly kind: 'byType'; readonly type: 'DESIRE' | 'IDEA' | 'goal' };

/** Рамки-признаки. У каждой — свой список слов, все закрытые. */
const OVERDUE = /(?<!\p{L})(?:просроч\p{L}*|не\s+успел\p{L}*|горит|горящ\p{L}*)(?!\p{L})/u;
const LATER = /(?<!\p{L})(?:на\s+потом|отлож\p{L}*|откладыва\p{L}*)(?!\p{L})/u;
const UNDATED = /(?<!\p{L})(?:без\s+(?:срока|сроков|даты|дат)|бессрочн\p{L}*)(?!\p{L})/u;
const COUNT = /(?<!\p{L})(?:сколько|много\s+ли)(?!\p{L})/u;
const PICK =
  /(?<!\p{L})(?:важн\p{L}*|срочн\p{L}*|главн\p{L}*|в\s+первую\s+очередь|с\s+чего\s+начать|начать|сначала|первым\s+делом)(?!\p{L})/u;
const RECENT =
  /(?<!\p{L})(?:записал\p{L}*|записыва\p{L}*|наговорил\p{L}*|надиктовал\p{L}*|добавил\p{L}*|последн\p{L}*|нового|новое|новенького)(?!\p{L})/u;
const DONE =
  /(?<!\p{L})(?:сделал\p{L}*|сделано|закрыл\p{L}*|закрыто|выполнил\p{L}*|выполнено|успел\p{L}*|завершил\p{L}*|завершено)(?!\p{L})/u;
const BY_TYPE =
  /(?<!\p{L})(?:желани\p{L}*|мечт\p{L}*|иде[ийя]\p{L}*|цел[ьеийя]\p{L}*|проект\p{L}*)(?!\p{L})/u;

const TODAY = /(?<!\p{L})сегодня(?!\p{L})/u;
const YESTERDAY = /(?<!\p{L})вчера(?!\p{L})/u;

/** Слова, разрешённые в остатке сверх общей рамки: только здесь. */
// «С чего мне начать»: предлог остаётся в остатке, когда между ним и
// «начать» стоит местоимение.
const EXTRA_FRAME = ['дел', 'всего', 'записей', 'записаны', 'большие', 'большая', 'большой', 'с'];

/** Остаток без рамки — только слова вопроса: предмета нет. */
function onlyFrame(rest: string): boolean {
  const frame = new Set([...FRAME_WORDS, ...EXTRA_FRAME].map((word) => normalizeText(word)));
  return wordsOf(rest).every((word) => frame.has(word));
}

/** Вырезать все вхождения рамки; остаток проверяется на предмет. */
function without(text: string, ...markers: readonly RegExp[]): string {
  let rest = text;
  for (const marker of markers) rest = rest.replace(new RegExp(marker.source, 'gu'), ' ');
  return rest;
}

function typeOf(marker: string): 'DESIRE' | 'IDEA' | 'goal' {
  if (marker.startsWith('иде')) return 'IDEA';
  if (marker.startsWith('цел') || marker.startsWith('проект')) return 'goal';
  return 'DESIRE';
}

export function askedList(text: string): ListQuestion | undefined {
  const normalized = normalizeText(text);
  if (wordsOf(normalized).length === 0) return undefined;

  if (OVERDUE.test(normalized)) {
    return onlyFrame(without(normalized, OVERDUE)) ? { kind: 'overdue' } : undefined;
  }
  if (LATER.test(normalized)) {
    return onlyFrame(without(normalized, LATER)) ? { kind: 'later' } : undefined;
  }
  if (UNDATED.test(normalized)) {
    return onlyFrame(without(normalized, UNDATED)) ? { kind: 'undated' } : undefined;
  }
  if (COUNT.test(normalized)) {
    return onlyFrame(without(normalized, COUNT)) ? { kind: 'count' } : undefined;
  }
  if (PICK.test(normalized)) {
    return onlyFrame(without(normalized, PICK)) ? { kind: 'pick' } : undefined;
  }

  const done = DONE.exec(normalized);
  if (done !== null) {
    const rest = without(normalized, DONE, YESTERDAY);
    if (YESTERDAY.test(normalized)) {
      return onlyFrame(rest) ? { kind: 'done', period: 'yesterday' } : undefined;
    }
    // Отрезок — тем же разбором, что у «что на неделе»; без него — неделя.
    const period = askedDay(rest);
    if (period !== undefined) return { kind: 'done', period };
    return onlyFrame(rest) ? { kind: 'done', period: 'week' } : undefined;
  }

  if (RECENT.test(normalized)) {
    const rest = without(normalized, RECENT, TODAY);
    if (!onlyFrame(rest)) return undefined;
    return { kind: 'recent', scope: TODAY.test(normalized) ? 'today' : 'last' };
  }

  const byType = BY_TYPE.exec(normalized);
  if (byType !== null) {
    return onlyFrame(without(normalized, BY_TYPE))
      ? { kind: 'byType', type: typeOf(byType[0]) }
      : undefined;
  }

  return undefined;
}
