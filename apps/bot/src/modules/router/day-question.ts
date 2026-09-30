import { askedList, asksAboutEverything } from '../backlog/list-questions.js';
import { askedDay } from '../backlog/periods.js';
import { wordsOf } from '../backlog/question-words.js';
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

/**
 * Слова, которыми спрашивают. «Напиши», «скинь», «пришли», «дай»,
 * «отправь» — просьбы показать (заказчица, бой 21.09.2026); «выкати» —
 * тоже (заказчица, бой 29.09.2026).
 */
const ASK_WORD =
  /(?<!\p{L})(?:что|чего|какие|какой|какая|кто|покажи|напомни|скажи|расскажи|перечисли|выведи|напиши|выпиши|скинь|пришли|дай|выдай|отправь|выкати)(?!\p{L})/iu;

/**
 * Граница предложений — по знаку конца и пробелу после него; и запятая
 * перед «кстати» (голос 10, 18.09.2026): расшифровка приклеивает
 * вопрос к предыдущей фразе, а «кстати» — всегда начало нового.
 */
const SENTENCE_END = /(?<=[.!?…])\s+|,\s+(?=кстати(?!\p{L}))/iu;

/** «И ещё …» — начало следующей мысли, если после него повеление. */
const AND_MORE = /[\s,]+(?:(?:и|а)\s+)?(?:ещё|еще)\s+/giu;

/** Глагол в повелении — «платить», «записаться». */
const INFINITIVE = /\p{L}+(?:ть|ться|чь|чься)(?!\p{L})/u;

/**
 * Вопрос о дне — или список по признаку (21.09.2026): «что просрочено»,
 * «сколько у меня дел», «что я сделала» — те же вопросы к бэклогу, и
 * из мысли они выделяются тем же правилом. «Сколько» — само по себе
 * вопросительное слово.
 */
const ASK_WORD_MORE = /(?<!\p{L})(?:сколько|много\s+ли)(?!\p{L})/iu;

/**
 * Вопрос обо всём — тоже (заказчица, бой 21.09.2026): «Напиши мне все,
 * что накопилось» модель отдала мыслью, извлечение ничего не нашло, и
 * человек прочёл «Я здесь. Расскажешь, что в голове?». Слова о «всём»
 * код знает (`asksAboutEverything`); здесь они применяются там же, где
 * вопрос о дне.
 */
function isDayQuestion(text: string): boolean {
  const asks = ASK_WORD.test(text) || ASK_WORD_MORE.test(text) || text.trim().endsWith('?');
  return (
    asks &&
    (askedDay(text) !== undefined || askedList(text) !== undefined || asksAboutEverything(text))
  );
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

/**
 * Слова, из которых состоит кусок вопроса без содержания: «Слушай, а
 * еще...» (вводные `wordsOf` уже убрал). Закрытый список связок — не
 * рамка вопроса: «Мои дела» и «Покажи всё» — вопросы сами по себе.
 */
const BARE_WORDS: ReadonlySet<string> = new Set(['а', 'и', 'еще', 'кстати', 'вообще', 'там']);

/** Не спрашивает и ничего не называет: ни слова вопроса, ни знака, ни предмета. */
function isBare(text: string): boolean {
  const asks = ASK_WORD.test(text) || ASK_WORD_MORE.test(text) || text.trim().endsWith('?');
  return !asks && wordsOf(text).every((word) => BARE_WORDS.has(word));
}

/**
 * Кусок вопроса без содержания — к соседнему вопросу (заказчица, бой
 * 29.09.2026).
 *
 * «Слушай, а еще... Да выкати мне вообще все, что нужно сделать на этой
 * неделе.» — многоточие распознавания режет вопрос надвое, и «Слушай, а
 * еще...», отвеченное отдельно, — это «а ещё» без предмета, то есть весь
 * список «Мои дела» вдобавок к неделе. Кусок клеится к следующему
 * вопросу, а в конце — к предыдущему; рядом вопроса нет — остаётся как
 * был.
 */
function glueBareQueries(segments: readonly Segment[]): readonly Segment[] {
  const glued: Segment[] = [];
  let carried = '';

  for (const [index, segment] of segments.entries()) {
    const text = carried === '' ? segment.text : `${carried} ${segment.text}`;
    carried = '';

    if (segment.intent === 'QUERY' && isBare(segment.text)) {
      if (segments[index + 1]?.intent === 'QUERY') {
        carried = text;
        continue;
      }
      const last = glued.at(-1);
      if (last?.intent === 'QUERY') {
        glued[glued.length - 1] = { ...last, text: `${last.text} ${text}` };
        continue;
      }
    }

    glued.push(text === segment.text ? segment : { ...segment, text });
  }

  return glued;
}

export function splitDayQuestions(segments: readonly Segment[]): readonly Segment[] {
  const split = glueBareQueries(
    segments.flatMap((segment) =>
      SPLITTABLE.has(segment.intent) ? splitSegment(segment) : [segment],
    ),
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

/**
 * Речь без вопросов о дне — для правил дня классификации (голос 10,
 * 18.09.2026).
 *
 * Маршрутизатор убирает вопрос из разбора, но правила дня читают речь
 * **целиком**, и «на выходных» из «кстати, что у меня на выходных» стало
 * сроком соседнего дела «разобрать балкон» — выдуманный срок, худшая из
 * ошибок разбора. Вопрос о дне сроком быть не может ни для кого;
 * вырезается он тем же правилом, каким выделяется, — иначе два способа
 * узнать вопрос разошлись бы.
 */
export function withoutDayQuestions(speech: string): string {
  const kept = speech
    .split(SENTENCE_END)
    .filter((sentence) => sentence.trim().length > 0)
    .flatMap(splitAndMore)
    .filter((part) => part.thought || !isDayQuestion(part.text))
    .map((part) => part.text.trim());

  return kept.join(' ');
}
