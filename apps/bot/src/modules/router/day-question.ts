import { askedDay } from '../backlog/query.service.js';
import type { Segment } from './router.service.js';

/**
 * Вопрос о дне внутри мысли — кодом (серия голосовых 18.09.2026, голос 3).
 *
 * «Надо позвонить в школу насчёт экскурсии. Кстати, что у меня там на
 * завтра и ещё платить интернет?» — расшифровка склеила вопрос и
 * следующую мысль в одно предложение со знаком вопроса в конце. Модель
 * маршрутизатора на таком либо оставляет всё мыслью — и из вопроса
 * выходит дело «Проверить, что запланировано на завтра» со сроком, —
 * либо называет вопросом вместе с «платить интернет», и мысль пропала
 * бы в ответе на вопрос. Промпт маршрутизатора не трогаем: он теряет
 * единицы от любого утяжеления.
 *
 * Правило, а не догадка: вопрос о дне узнаётся теми же словами, что и
 * при ответе на него (`askedDay`: слово о дне есть, предмета нет), плюс
 * слово, которым спрашивают, — без него «надо на завтра» обрывок мысли,
 * а не вопрос. Мысль, приклеенная к вопросу через «и ещё», отделяется
 * только когда перед «и ещё» стоит вопрос о дне, а после — повеление
 * («платить»): «что на завтра и ещё на выходных» остаётся вопросом.
 * Один и тот же день, спрошенный дважды (голосовое наговорили два раза),
 * спрашивается один раз.
 */

/** Чьи сегменты разбираются: мысль и вопрос. Правки и ответы — нет. */
const SPLITTABLE = new Set<Segment['intent']>(['DUMP', 'QUERY']);

/** Слова, которыми спрашивают. */
const ASK_WORD =
  /(?<!\p{L})(?:что|чего|какие|какой|какая|кто|покажи|напомни|скажи|расскажи|перечисли|выведи)(?!\p{L})/iu;

/** Граница предложений — по знаку конца и пробелу после него. */
const SENTENCE_END = /(?<=[.!?…])\s+/u;

/** «И ещё …» — начало следующей мысли, если после него повеление. */
const AND_MORE = /[\s,]+(?:(?:и|а)\s+)?(?:ещё|еще)\s+/giu;

/** Глагол в повелении — «платить», «записаться». */
const INFINITIVE = /\p{L}+(?:ть|ться|чь|чься)(?!\p{L})/u;

function isDayQuestion(text: string): boolean {
  return askedDay(text) !== undefined && (ASK_WORD.test(text) || text.trim().endsWith('?'));
}

/** Части предложения: вопрос о дне и приклеенная к нему мысль. */
function splitAndMore(sentence: string): readonly { text: string; thought: boolean }[] {
  for (const match of sentence.matchAll(AND_MORE)) {
    const head = sentence.slice(0, match.index).trim();
    const tail = sentence.slice(match.index).replace(/^[\s,]+/u, '');

    if (isDayQuestion(head) && INFINITIVE.test(tail)) {
      return [
        { text: head, thought: false },
        { text: tail, thought: true },
      ];
    }
  }

  return [{ text: sentence, thought: false }];
}

function splitSegment(segment: Segment): readonly Segment[] {
  const parts = segment.text
    .split(SENTENCE_END)
    .filter((sentence) => sentence.trim().length > 0)
    .flatMap(splitAndMore)
    .map((part): Segment => ({
      intent: part.thought ? 'DUMP' : isDayQuestion(part.text) ? 'QUERY' : segment.intent,
      text: part.text,
    }));

  if (!parts.some((part) => part.intent === 'QUERY' && isDayQuestion(part.text))) return [segment];
  if (parts.length === 1 && parts[0]?.intent === segment.intent) return [segment];

  // Соседние предложения одного намерения — снова одним сегментом.
  const merged: Segment[] = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (last?.intent === part.intent && part.intent !== 'QUERY') {
      merged[merged.length - 1] = { intent: part.intent, text: `${last.text} ${part.text}` };
    } else {
      merged.push(part);
    }
  }

  return merged;
}

export function splitDayQuestions(segments: readonly Segment[]): readonly Segment[] {
  const split = segments.flatMap((segment) =>
    SPLITTABLE.has(segment.intent) ? splitSegment(segment) : [segment],
  );

  // Один день — один вопрос.
  const askedDays = new Set<string>();
  return split.filter((segment) => {
    if (segment.intent !== 'QUERY') return true;
    const day = askedDay(segment.text);
    if (day === undefined) return true;
    if (askedDays.has(day)) return false;
    askedDays.add(day);
    return true;
  });
}
