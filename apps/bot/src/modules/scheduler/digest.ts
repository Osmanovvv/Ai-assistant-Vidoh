import type { Review } from '../review/review.service.js';
import { toShortId } from '../shared/short-id.js';
import type { Item } from '../../db/schema.js';
import type { TextProfile } from '../../texts/types.js';
import { titleUnderDayHeader, withCapital } from '../items/item-text.js';
import { isoDateIn, localDateParts } from '../classifier/dates.js';
import { underDayTitle } from '../backlog/day-list.js';
import { titleWithoutDate } from '../resolver/title-date.js';

/**
 * Утренняя и вечерняя сводки (§11 и §13.6 ТЗ, задача 3.15).
 *
 * Утреннее — приглашение выгрузить мысли и дела на сегодня, если они есть.
 * Вечернее — короткий итог дня и приглашение выгрузить накопившееся.
 *
 * **Просроченное не подаётся как провал, пропущенные дни не считаются.**
 * §13.6 говорит это прямо, и соблюдается оно не проверкой на выходе, а
 * устройством входа: сюда не приходит ни числа просроченных, ни числа
 * пропущенных дней. Их неоткуда взять — значит, они не появятся в реплике
 * ни сегодня, ни после чьей-нибудь правки текстов.
 *
 * **Сборка отдельно от отправки.** Из чистой функции «список дел → строка»
 * проверяются и тон, и состав; из отправляющего кода — только то, что он
 * не упал.
 */

/**
 * Сколько дел показывать утром.
 *
 * Столько же, сколько в обычной выдаче (§10): утреннее напоминание — это
 * та же выдача, просто по часам, и другой лимит означал бы, что в восемь
 * тридцать человек получает больше, чем когда спрашивает сам.
 */
export const MORNING_ACTIONS_LIMIT = 3;

/**
 * Какой из трёх вариантов приветствия сегодня (ТЗ 17.09.2026, 2.9): по
 * номеру дня в поясе человека, по кругу. Не случайность и не модель:
 * одно и то же утро у одного человека всегда собирается одинаково, и
 * проверить это можно.
 */
function variantOf<T>(
  variants: { readonly one: T; readonly two: T; readonly three: T },
  day: { readonly now: Date; readonly timeZone: string },
): T {
  const parts = localDateParts(day.now, day.timeZone);
  const days = Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
  const all = [variants.one, variants.two, variants.three];
  return all[days % all.length] ?? variants.one;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Утренняя реплика: приглашение и, если есть, дела на сегодня.
 *
 * **День и пояс обязательны** (задача 3.78). Шапка списка называет
 * сегодня, и у дела, чей срок и есть сегодня, вчерашнее «завтра» из слов
 * человека срезается: иначе строка спорит с шапкой. Без пояса решить это
 * нельзя, а необязательным параметр не сделан намеренно — забытый, он
 * вернул бы противоречие молча.
 */
export function morningText(
  texts: TextProfile,
  actions: readonly Item[],
  day: { readonly now: Date; readonly timeZone: string },
  /**
   * Есть ли у человека доступ к новым разборам (ревизия этапа 4).
   *
   * Прежде приглашение «наговори, разложу» уходило каждое утро и тому,
   * кому бот в ответ откажет. Приглашение, которое бот сам не исполнит,
   * хуже молчания: оно повторяется ежедневно, и человек либо перестаёт
   * верить боту, либо каждый день натыкается на отказ.
   *
   * Дела на сегодня при этом остаются: §14 велит держать бэклог
   * доступным на чтение, и напоминание о делах — чтение.
   */
  mayDump = true,
  /**
   * Разбор вчерашнего и одно из «Позже» (запрос на изменение №4). Разбор
   * идёт после дел на сегодня: сперва день, потом хвост — и хвост один
   * раз. Предложение из отложенного — последней строкой, как
   * необязательное: не в списке дел и без «надо».
   */
  extra: {
    readonly review?: Review | undefined;
    readonly offer?: Item | undefined;
    /**
     * Сразу после карточки первого утра (проверка Никиты 26.09.2026,
     * 09:00): карточка уже поздоровалась — «Доброе утро ☀️ Вот что сегодня
     * важно:», — и второе «Утро доброе. На сегодня немного:» под ней
     * читалось повтором. Дела — сразу.
     */
    readonly afterCard?: boolean | undefined;
  } = {},
): string {
  /**
   * Приветствие — одна строка, дальше сразу суть (ТЗ 17.09.2026, 2.9).
   * Обычное утро: приветствие с переходом парой того же номера, потом
   * дела без второй шапки. Лёгкий день (дел меньше лимита): приветствие,
   * «На сегодня немного:», дела. Пусто: приветствие, «ничего срочного»,
   * куда скидывать. Без доступа к разборам приглашение скидывать
   * заменяется словами об оплате.
   */
  const hello = variantOf(texts.reminders.morningHello, day);
  const shown = actions.slice(0, MORNING_ACTIONS_LIMIT);
  const lines: string[] = [];

  if (shown.length === 0) {
    lines.push(
      hello,
      texts.reminders.morningEmpty,
      mayDump ? texts.reminders.morningEmptyInvite : texts.reminders.needsPay,
    );
  } else {
    if (extra.afterCard === true) {
      // Шапку дала карточка.
    } else if (shown.length < MORNING_ACTIONS_LIMIT) {
      lines.push(hello, texts.reminders.morningLight);
    } else {
      lines.push(`${hello} ${variantOf(texts.reminders.morningIntro, day)}`);
    }
    for (const item of shown) lines.push(texts.reminders.line(dayLine(item, day)));
  }

  if (extra.review !== undefined) {
    lines.push(
      '',
      extra.review.since === 'yesterday'
        ? texts.review.headerYesterday
        : texts.review.headerEarlier,
    );
    extra.review.items.forEach((item, index) => {
      lines.push(texts.review.line(index + 1, titleWithoutDate(item.text)));
    });
  }

  if (extra.offer !== undefined) {
    lines.push('', texts.review.offer(titleWithoutDate(extra.offer.text)));
  }

  if (!mayDump && shown.length > 0) lines.push(texts.reminders.needsPay);

  return lines.join('\n');
}

/** Ряды кнопок разбора: по ряду на дело, три кнопки с номером дела. */
export function reviewRows(
  texts: TextProfile,
  review: Review,
): readonly (readonly { readonly label: string; readonly action: string }[])[] {
  return review.items.map((item, index) => {
    const n = index + 1;
    const code = toShortId(item.id);
    return [
      { label: texts.review.buttonToday(n), action: `${REVIEW_ACTION.today}:${code}` },
      { label: texts.review.buttonLater(n), action: `${REVIEW_ACTION.later}:${code}` },
      { label: texts.review.buttonDrop(n), action: `${REVIEW_ACTION.drop}:${code}` },
    ];
  });
}

/** Действия кнопок разбора: обработчик — `bot/handlers/review.ts`. */
export const REVIEW_ACTION = {
  today: 'review:today',
  later: 'review:later',
  drop: 'review:drop',
} as const;

/**
 * Вечерняя реплика: итог дня, приглашение и — если есть — один вопрос.
 *
 * Итог — только про закрытое. Ни одного дела не закрыто — итога нет, и
 * это не повод для замечания: день, в котором ничего не закрылось,
 * человеку известен и без нас.
 *
 * **Предложение запомнить регулярность едет здесь, а не отдельным
 * сообщением** (задача 3.17а). Бот, который сам начинает разговор с
 * открытия про твою жизнь, — это вторжение, даже когда он прав. Вечерняя
 * сводка уже приходит по расписанию человека; предложение занимает в ней
 * место единственного вопроса, и §13.9 не нарушается: приглашение выше —
 * не вопрос, а приглашение.
 */
export function eveningText(
  texts: TextProfile,
  params: {
    /** Сколько закрыто сегодня — числом, если больше нуля. */
    readonly closed: number;
    /** Что на сегодня осталось открытым. */
    readonly left: readonly Item[];
    readonly day: { readonly now: Date; readonly timeZone: string };
    readonly suggestion?: string | undefined;
    /** Есть ли доступ к новым разборам. См. `morningText`. */
    readonly mayDump?: boolean | undefined;
  },
): string {
  /**
   * Вечер по ТЗ 17.09.2026 (2.9): всё закрыто — «На сегодня всё 🤍» и
   * «Остальное я помню.», точка завершения без приглашения; что-то
   * осталось — приветствие по кругу, что осталось с сегодня и что с
   * этим можно сделать. Закрытое — числом между ними, если есть что
   * считать; ноль не пишется (§13.6).
   */
  const lines: string[] = [];
  const closed = params.closed > 0 ? [texts.reminders.eveningClosed(params.closed)] : [];

  if (params.left.length === 0) {
    lines.push(texts.reminders.eveningAllDone, ...closed, texts.reminders.remembered);
  } else {
    lines.push(variantOf(texts.reminders.eveningHello, params.day), ...closed);
    lines.push(texts.reminders.eveningLeft);
    for (const item of params.left) {
      lines.push(texts.reminders.line(dayLine(item, params.day)));
    }
    lines.push(texts.reminders.eveningLeftHint);
  }

  if (params.mayDump === false) lines.push(texts.reminders.needsPay);
  if (params.suggestion !== undefined && params.suggestion.length > 0) {
    lines.push('', params.suggestion);
  }

  return lines.join('\n');
}

/**
 * Строка дела в утреннем и вечернем. У сегодняшнего — час из срока, как в
 * списках дня (проверка Никиты 25.09.2026, 21:00: «Забрать ребёнка из
 * школы» без 16:00); у остальных — заголовок под шапкой дня, как был: у
 * дела без срока он не трогается.
 */
function dayLine(item: Item, day: { readonly now: Date; readonly timeZone: string }): string {
  const today =
    item.deadlineAt !== null &&
    isoDateIn(item.deadlineAt, day.timeZone) === isoDateIn(day.now, day.timeZone);
  return today ? underDayTitle(item) : titleUnderDayHeader(item, day);
}

/** Реплика напоминания по сроку (задача 3.16). */
export function deadlineText(
  texts: TextProfile,
  params: { readonly item: Item; readonly onDay: boolean },
): string {
  // Реплика сама называет день, поэтому дату из цитаты убираем: иначе в
  // одной фразе окажутся две даты (см. title-date.ts). Час — из срока, со
  // старым часом из названия вместо (проверка Никиты 25.09.2026, 21:00).
  const title = underDayTitle(params.item);

  return params.onDay
    ? texts.reminders.deadlineToday(title)
    : texts.reminders.deadlineTomorrow(title);
}

/**
 * Напоминание в указанный час (ТЗ проджекта 17.09.2026, шаг 5):
 * «Через 30 минут, в 13:00: Сходить к стоматологу.» — или «Сейчас, в
 * 13:00: …», если упреждение ноль. Час из заголовка убирается: реплика
 * называет его сама, иначе в одной фразе он стоял бы дважды.
 */
export function hourText(
  texts: TextProfile,
  params: { readonly item: Item; readonly time: string; readonly leadMinutes: number },
): string {
  // С заглавной (живой прогон 26.09.2026): дело, сохранённое строчным до
  // починки, иначе приходило «…в 19:00: зайти в аптеку».
  const title = withCapital(titleWithoutClock(titleWithoutDate(params.item.text)));

  return params.leadMinutes > 0
    ? texts.reminders.deadlineHourSoon(String(params.leadMinutes), params.time, title)
    : texts.reminders.deadlineHourNow(params.time, title);
}

/** Заголовок без хвоста «в 13:00» / «в 9 0 0» / «до 6 вечера» на конце. */
export function titleWithoutClock(title: string): string {
  return title
    .replace(
      /\s*(?:,\s*)?(?:в|к|до|около|после)\s+\d{1,2}(?::\d{2}|\.\d{2}|\s+\d\s+\d|\s+\d{2})?(?:\s+час(?:ов|а)?)?(?:\s+(?:утра|дня|вечера|ночи))?\s*$/u,
      '',
    )
    .trim();
}

/** Вопрос про застрявший проект (задача 3.13). */
export function projectText(
  texts: TextProfile,
  params: { readonly title: string; readonly step: string },
): string {
  return texts.reminders.projectStuck(params.title, params.step);
}
