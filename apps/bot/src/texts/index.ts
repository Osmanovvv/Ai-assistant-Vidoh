import { reserved } from './profiles/reserved.js';
import type { TextProfile } from './types.js';

/**
 * Выбор профиля текстов (задача 2.11, §13.8 ТЗ).
 *
 * Добавление второго профиля — это новый файл в `profiles` и одна строка
 * здесь. Больше нигде: обращения к текстам идут через `textsFor`, а имя
 * профиля хранится у пользователя строкой, а не перечислением в базе.
 * Перечисление потребовало бы миграции, то есть правки вне этой папки, —
 * а условие готовности задачи говорит обратное.
 */

export const profiles: Readonly<Record<string, TextProfile>> = {
  reserved,
};

export type ProfileName = keyof typeof profiles;

/** В первой версии профиль один и включён постоянно (§13.8). */
export const DEFAULT_PROFILE = 'reserved';

export function isProfileName(name: string): boolean {
  return Object.hasOwn(profiles, name);
}

/**
 * Тексты для пользователя.
 *
 * Неизвестное имя не считается ошибкой и не роняет ответ: человек в этот
 * момент ждёт разбор своей выгрузки, и отказ ради опечатки в настройке
 * был бы обменом важного на неважное. Берётся профиль по умолчанию.
 */
export function textsFor(profile?: string | null): TextProfile {
  if (profile != null) {
    const found = profiles[profile];
    if (found) return found;
  }

  return reserved;
}

/**
 * Тексты по умолчанию — для мест, где пользователя ещё нет.
 *
 * Такое место одно: первый экран до регистрации (§13.1). Везде, где
 * пользователь известен, профиль берётся из его настроек.
 */
export const defaultTexts: TextProfile = textsFor(DEFAULT_PROFILE);

export type { TextProfile } from './types.js';
