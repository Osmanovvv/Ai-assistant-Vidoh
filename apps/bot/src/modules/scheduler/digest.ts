import type { Item } from '../../db/schema.js';
import type { TextProfile } from '../../texts/types.js';

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

/** Утренняя реплика: приглашение и, если есть, дела на сегодня. */
export function morningText(texts: TextProfile, actions: readonly Item[]): string {
  const lines = [texts.reminders.morningInvite];

  const shown = actions.slice(0, MORNING_ACTIONS_LIMIT);
  if (shown.length > 0) {
    lines.push('', texts.reminders.morningActions);
    for (const item of shown) lines.push(texts.reminders.line(item.text));
  }

  return lines.join('\n');
}

/**
 * Вечерняя реплика: итог дня и приглашение.
 *
 * Итог — только про закрытое. Ни одного дела не закрыто — итога нет, и
 * это не повод для замечания: день, в котором ничего не закрылось,
 * человеку известен и без нас.
 */
export function eveningText(texts: TextProfile, closedToday: number): string {
  const summary =
    closedToday > 0 ? texts.reminders.eveningClosed(closedToday) : texts.reminders.eveningQuiet;

  return [summary, texts.reminders.eveningInvite].join('\n');
}

/** Реплика напоминания по сроку (задача 3.16). */
export function deadlineText(
  texts: TextProfile,
  params: { readonly item: Item; readonly onDay: boolean },
): string {
  return params.onDay
    ? texts.reminders.deadlineToday(params.item.text)
    : texts.reminders.deadlineTomorrow(params.item.text);
}

/** Вопрос про застрявший проект (задача 3.13). */
export function projectText(
  texts: TextProfile,
  params: { readonly title: string; readonly step: string },
): string {
  return texts.reminders.projectStuck(params.title, params.step);
}
