import { eq } from 'drizzle-orm';

import { userSettings } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Ответ словами вместо кнопки (задача 3.61).
 *
 * **Почему этого не было.** Онбординг был целиком на кнопках, и причина
 * записана в `onboarding.service.ts`: свободный ответ приходит обычным
 * сообщением и попадает в буфер выгрузки. Пришлось бы либо угадывать,
 * ответ это или новая мысль, — и однажды угадать неверно, записав в имя
 * «надо купить продукты», — либо перехватывать все сообщения, пока опрос
 * открыт, и тогда терялась бы выгрузка.
 *
 * **Что изменилось.** Развилку убирает не догадка, а **явное нажатие**.
 * Человек нажал «напишу своё» — значит он сам сказал, что следующая его
 * реплика будет ответом. Догадываться больше не о чём.
 *
 * **И три страховки, потому что цена ошибки — потерянная мысль.**
 *
 * 1. **Строгий разбор.** Не похоже на время или на имя — не ответ.
 * 2. **Окно в четверть часа.** Нажал и отвлёкся на день, а вернувшись
 *    сказал мысль — мысль уйдёт в разбор, а не в имя.
 * 3. **Ничего не съедается молча.** Не подошло — ожидание снимается, и
 *    сообщение идёт обычным путём, как до задачи.
 */

/** Чего ждём. `edit:<id>` несёт внутри запись, поэтому не перечисление. */
export const AWAITING = {
  name: 'name',
  morning: 'morning',
  evening: 'evening',
  /** `edit:6f1e…` — правка текста записи словами. */
  editPrefix: 'edit:',
} as const;

/**
 * Сколько ожидание живёт.
 *
 * Четверть часа. Человек, нажавший «напишу своё», отвечает в следующую
 * минуту; всё остальное — это уже новая мысль, а не запоздавший ответ.
 */
export const AWAITING_TTL_MS = 15 * 60_000;

export interface Awaiting {
  readonly kind: string;
  /** У правки — запись, которую правят. */
  readonly itemId?: string | undefined;
}

export function parseAwaiting(value: string | null): Awaiting | undefined {
  if (value === null || value === '') return undefined;

  if (value.startsWith(AWAITING.editPrefix)) {
    const itemId = value.slice(AWAITING.editPrefix.length);
    return itemId === '' ? undefined : { kind: 'edit', itemId };
  }

  return value === AWAITING.name || value === AWAITING.morning || value === AWAITING.evening
    ? { kind: value }
    : undefined;
}

export async function setAwaiting(
  db: Executor,
  userId: string,
  value: string | null,
): Promise<void> {
  await db
    .update(userSettings)
    // `updatedAt` здесь не косметика: по нему считается окно жизни
    // ожидания, см. `awaitingOf`.
    .set({ awaitingInput: value, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

export interface AwaitingState {
  readonly awaiting?: Awaiting | undefined;
  /** Ожидание было, но просрочено: снять и пропустить сообщение в разбор. */
  readonly expired: boolean;
}

/** Чего ждём от этого человека. Просроченное не возвращается. */
export async function awaitingOf(
  db: Executor,
  userId: string,
  now: Date = new Date(),
): Promise<AwaitingState> {
  const [row] = await db
    .select({ value: userSettings.awaitingInput, updatedAt: userSettings.updatedAt })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  const awaiting = parseAwaiting(row?.value ?? null);
  if (awaiting === undefined) return { expired: false };

  const since = row === undefined ? 0 : row.updatedAt.getTime();
  if (now.getTime() - since > AWAITING_TTL_MS) return { expired: true };

  return { awaiting, expired: false };
}

/** Слова, которыми время обрамляют: «в 7:30 утра», «21:00 мск». */
const AROUND_TIME = new Set([
  'в',
  'во',
  'к',
  'около',
  'где-то',
  'часов',
  'часа',
  'час',
  'утра',
  'утром',
  'вечера',
  'вечером',
  'дня',
  'ночи',
  'мск',
]);

/**
 * Время из слов человека (задача 3.61, пункт 4 заказчика).
 *
 * Кнопок четыре — 07:00, 08:00, 09:00, 10:00, — а человек может хотеть
 * 7:30. Принимается то, чем время пишут на самом деле: «7:30», «07:30»,
 * «7 30», «7.30», «19-05», «в 7:30», «7:30 утра», «7».
 *
 * **Строго и без догадок.** Одно число без минут читается как круглый
 * час: «7» — это 07:00. Всё остальное — не время, и мысль человека уйдёт
 * в разбор, а не в настройку. Именно поэтому здесь нет попыток понять
 * «полвосьмого»: угадав неверно, бот начнёт писать не в то время, а
 * человек не поймёт почему.
 */
export function parseTime(text: string): string | undefined {
  /**
   * Слова вокруг времени убираются **по словам**, а не выражением с `\b`.
   *
   * `\b` в JavaScript считает словом только латиницу с цифрами, поэтому
   * `\bв\b` кириллическое «в» не находит вовсе: у него нет границы слова
   * там, где её ждёшь. На этом «в 7:30» не разбиралось.
   */
  const cleaned = text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .split(/\s+/u)
    .filter((word) => word !== '' && !AROUND_TIME.has(word))
    .join(' ');

  const match = /^(\d{1,2})(?:[:. ∶-](\d{2}))?$/u.exec(cleaned);
  if (!match) return undefined;

  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);

  if (!Number.isInteger(hours) || hours > 23) return undefined;
  if (!Number.isInteger(minutes) || minutes > 59) return undefined;

  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}`;
}

/**
 * Имя из слов человека (задача 3.61, пункт 2 заказчика).
 *
 * Telegram даёт то, что стоит в профиле, — «Никита AI - web digital», а
 * человек хочет «Леночка» или «Ксюша».
 *
 * **Что считается именем.** Одна строка, до тридцати двух знаков, до трёх
 * слов, нет цифр и нет ссылок. Ограничения не ради красоты: чем строже,
 * тем меньше шанс, что коротко сказанная мысль («купить хлеб») будет
 * принята за имя. Совсем этот шанс не убрать — поэтому бот сразу
 * показывает, как теперь зовёт, и человек видит промах в ту же секунду.
 *
 * **Буква не обязательна** — правка заказчика 04.09.2026: «вдруг человек
 * хочет, чтобы его называли „,“». Проверка на букву была и стояла против
 * мусора **из профиля Telegram**: там имя приходит само, и подтверждать
 * «...» нечего. Здесь человек нажал кнопку и написал это сам, а решать за
 * него, годится ли ему такое имя, не наше дело. Мысль от этого потерять
 * нельзя: у мысли буквы есть всегда.
 */
export function parseName(text: string): string | undefined {
  const cleaned = text.replace(/\s+/gu, ' ').trim();

  if (cleaned === '' || cleaned.length > 32) return undefined;
  if (text.includes('\n')) return undefined;
  if (/\d/u.test(cleaned)) return undefined;
  if (/https?:|@|\//u.test(cleaned)) return undefined;
  if (cleaned.split(' ').length > 3) return undefined;

  return cleaned;
}

export async function setPreferredName(db: Executor, userId: string, name: string): Promise<void> {
  await db
    .update(userSettings)
    .set({ preferredName: name, awaitingInput: null, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}
