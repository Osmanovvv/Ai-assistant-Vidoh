import type { StatusButton } from '../presenter/status.service.js';
import { toShortId } from '../shared/short-id.js';
import type { TextProfile } from '../../texts/types.js';

/**
 * Кнопки под напоминаниями (задачи 3.13 и 3.16).
 *
 * §11 требует у напоминания по сроку две кнопки — «сделано» и
 * «перенести». Обе должны что-то делать: кнопка, которая только закрывает
 * сообщение, учит не нажимать кнопки вообще.
 *
 * Идентификатор записи едет коротким кодом: в `callback_data` шестьдесят
 * четыре байта, а UUID с префиксом съедает больше половины.
 */

export const REMINDER_ACTION = {
  done: 'rd:',
  postpone: 'rp:',
  projectTake: 'pt:',
  projectLater: 'pl:',
} as const;

/** «Сделано» и «Перенести» под напоминанием о сроке. */
export function deadlineButtons(itemId: string, texts: TextProfile): readonly StatusButton[] {
  const code = toShortId(itemId);

  return [
    { label: texts.reminders.buttonDone, action: `${REMINDER_ACTION.done}${code}` },
    { label: texts.reminders.buttonPostpone, action: `${REMINDER_ACTION.postpone}${code}` },
  ];
}

/** «Возьмусь» и «Не сейчас» под вопросом о застрявшем проекте. */
export function projectButtons(itemId: string, texts: TextProfile): readonly StatusButton[] {
  const code = toShortId(itemId);

  return [
    { label: texts.reminders.buttonProjectTake, action: `${REMINDER_ACTION.projectTake}${code}` },
    { label: texts.reminders.buttonProjectLater, action: `${REMINDER_ACTION.projectLater}${code}` },
  ];
}

/**
 * На сколько двигает срок кнопка «Перенести».
 *
 * На сутки. Спрашивать «на когда?» значило бы задать вопрос там, где
 * человек нажал кнопку, чтобы вопроса не было; а неделя — слишком много
 * для дела, о котором напомнили сегодня утром.
 */
export const POSTPONE_DAYS = 1;
