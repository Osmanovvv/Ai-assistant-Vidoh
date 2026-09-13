import type { Review } from '../review/review.service.js';
import { toShortId } from '../shared/short-id.js';
import type { Item } from '../../db/schema.js';
import type { TextProfile } from '../../texts/types.js';
import { titleUnderDayHeader } from '../items/item-text.js';
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
  extra: { readonly review?: Review | undefined; readonly offer?: Item | undefined } = {},
): string {
  const lines = [mayDump ? texts.reminders.morningInvite : texts.reminders.needsPay];

  const shown = actions.slice(0, MORNING_ACTIONS_LIMIT);
  if (shown.length > 0) {
    lines.push('', texts.reminders.morningActions);
    for (const item of shown) lines.push(texts.reminders.line(titleUnderDayHeader(item, day)));
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
  closedToday: number,
  suggestion?: string,
  /** Есть ли доступ к новым разборам. См. `morningText`. */
  mayDump = true,
): string {
  const summary =
    closedToday > 0 ? texts.reminders.eveningClosed(closedToday) : texts.reminders.eveningQuiet;

  const lines = [summary, mayDump ? texts.reminders.eveningInvite : texts.reminders.needsPay];
  if (suggestion !== undefined && suggestion.length > 0) lines.push('', suggestion);

  return lines.join('\n');
}

/** Реплика напоминания по сроку (задача 3.16). */
export function deadlineText(
  texts: TextProfile,
  params: { readonly item: Item; readonly onDay: boolean },
): string {
  // Реплика сама называет день, поэтому дату из цитаты убираем:
  // иначе в одной фразе окажутся две даты. См. title-date.ts.
  const title = titleWithoutDate(params.item.text);

  return params.onDay
    ? texts.reminders.deadlineToday(title)
    : texts.reminders.deadlineTomorrow(title);
}

/** Вопрос про застрявший проект (задача 3.13). */
export function projectText(
  texts: TextProfile,
  params: { readonly title: string; readonly step: string },
): string {
  return texts.reminders.projectStuck(params.title, params.step);
}
