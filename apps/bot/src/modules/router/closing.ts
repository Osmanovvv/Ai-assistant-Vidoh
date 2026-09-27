import { namesDay } from '../classifier/own-sentence.js';
import type { Segment } from './router.service.js';

/**
 * Отметка и отмена — по одному делу на отрезок (серия голосовых
 * 18.09.2026, голос 5).
 *
 * «Продукты купила уже, а в школу звонить не надо. Всё решилось» —
 * модель маршрутизатора отдала это одним `COMPLETE`. Резолвер получил
 * одну реплику про два разных дела, выбрать не смог, сказал «новая
 * мысль» — и школа осталась открытой, а слова легли черновиком. Промпт
 * маршрутизатора не трогаем: он теряет единицы от любого утяжеления.
 *
 * Правило, а не догадка: отрезок закрытия режется по границам
 * предложений и по запятой с союзом («, а», «, и», «, но», «, зато»).
 * Часть без своего сказуемого — перечисление или объяснение («и хлеб»,
 * «всё решилось») — остаётся при предыдущей. Намерение каждой части —
 * по её словам: «не надо», «передумала», «отменяется» — отмена; глагол
 * в прошедшем без «не» — отметка; и то и другое или ни того, ни
 * другого — как сказала модель про весь отрезок. Запятая без союза не
 * режет: «записала сына к врачу, как ты просила» — одно дело.
 */

/** Чьи сегменты разбираются: закрытия. Мысли, вопросы, правки — нет. */
const CLOSINGS = new Set<Segment['intent']>(['COMPLETE', 'CANCEL']);

/** Границы: конец предложения или запятая с союзом. Знак остаётся при части. */
const BOUNDARY = /(?<=[.!?;])\s+|,\s+(?=(?:а|и|но|зато)\s)/iu;

/** Слова отмены. */
const CANCEL_WORDS =
  /(?<!\p{L})(?:не\s+(?:надо|нужно|буду|будем|стоит|требуется|актуально)|отмен\p{L}*|передумал\p{L}*|больше\s+не|неактуальн\p{L}*|отпал\p{L}*)(?!\p{L})/iu;

/** Глагол в прошедшем без «не» перед ним: «купила», «сходили», «записался». */
const DONE_WORD = /(?<!\p{L})(?<!не\s)(\p{L}{3,}(?:ла|ли|лся|лась|лись))(?!\p{L})/giu;

/** Существительные на «-ла/-ли», которые глаголом не являются. */
const NOT_VERBS = new Set(['дела', 'недели', 'тела', 'земли', 'мысли', 'цели']);

/** Повеление или «надо»: у части есть своё сказуемое. */
const PREDICATE = /(?<!\p{L})(?:\p{L}+(?:ть|ться|чь|чься)|надо|нужно|сделано|готово)(?!\p{L})/iu;

function isDone(text: string): boolean {
  return [...text.matchAll(DONE_WORD)].some(
    (match) => !NOT_VERBS.has(match[1]?.toLowerCase() ?? ''),
  );
}

function isCancel(text: string): boolean {
  return CANCEL_WORDS.test(text);
}

function hasPredicate(text: string): boolean {
  return isCancel(text) || isDone(text) || PREDICATE.test(text);
}

function intentOf(part: string, parent: Segment['intent']): Segment['intent'] {
  const cancel = isCancel(part);
  const done = isDone(part);
  if (cancel && !done) return 'CANCEL';
  if (done && !cancel) return 'COMPLETE';
  return parent;
}

/**
 * Обрывок «И в пятницу.» — начало следующей части, а не хвост
 * предыдущей (стенд 27.09.2026, voice-27-02): «И в пятницу. Забрать
 * документы из МФЦ, они уже готовы.» резалось на две, и резолвер,
 * получив голое «И в пятницу.», переносил на пятницу чужое дело. Короткая
 * часть без сказуемого, в которой назван день, идёт вперёд.
 */
function leadsIntoNext(piece: string): boolean {
  const words = piece.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  return words.length <= 4 && namesDay(piece);
}

function splitSegment(segment: Segment): readonly Segment[] {
  const parts: string[] = [];
  // Часть, которой своей быть нельзя, — к следующей: первая без
  // сказуемого (прицепиться назад не к чему) и обрывок дня.
  let carry = '';
  for (const raw of segment.text.split(BOUNDARY)) {
    const piece = raw.trim();
    if (piece.length === 0) continue;
    const joined = carry === '' ? piece : `${carry} ${piece}`;
    carry = '';
    const last = parts.length - 1;
    if (hasPredicate(joined)) parts.push(joined);
    else if (last < 0 || leadsIntoNext(joined)) carry = joined;
    else parts[last] = `${parts[last] ?? ''} ${joined}`;
  }
  // Вперёд идти некуда — хвост последней части.
  if (carry !== '') {
    const last = parts.length - 1;
    if (last < 0) parts.push(carry);
    else parts[last] = `${parts[last] ?? ''} ${carry}`;
  }

  if (parts.length <= 1) return [segment];

  return parts.map((part) => ({
    intent: intentOf(part, segment.intent),
    text: part.replace(/,\s*$/u, ''),
  }));
}

/** Прошедшее мужского рода: «позвонил», «сделал», «забрал» (с «-ся» тоже). */
const DONE_HE = /(?<!\p{L})(?<!не\s)\p{L}{2,}(?:ал|ял|ил|ел|ёл|ыл|ул)(?:ся)?(?!\p{L})/iu;

/** Прошедшее без «-л»: «вынес», «принёс», «отвёз», «пришёл», «смог». */
const DONE_IRREGULAR =
  /(?<!\p{L})(?<!не\s)(?:вынес|внес|внёс|принес|принёс|отнес|отнёс|занес|занёс|унес|унёс|привез|привёз|отвез|отвёз|увез|увёз|завез|завёз|довез|довёз|пришел|пришёл|ушел|ушёл|зашел|зашёл|нашел|нашёл|прошел|прошёл|дошел|дошёл|смог|помог|сделано|готово)(?!\p{L})/iu;

/**
 * Сказано как о сделанном или отменённом — любым родом (стенд 27.09.2026).
 *
 * Признак для развилки «закрытие без записи»: такая реплика делом стать
 * не может (прогон 15.09.2026, находка 5 — «мусор я уже вынес»). Шире,
 * чем признак резки: лишнее «сделано» здесь оставляет слова в черновике,
 * как и было, а пропущенное завело бы дело из сделанного.
 */
export function saidAsDone(text: string): boolean {
  return isDone(text) || isCancel(text) || DONE_HE.test(text) || DONE_IRREGULAR.test(text);
}

export function splitClosings(segments: readonly Segment[]): readonly Segment[] {
  return segments.flatMap((segment) =>
    CLOSINGS.has(segment.intent) ? splitSegment(segment) : [segment],
  );
}
