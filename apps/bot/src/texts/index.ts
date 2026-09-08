import { reserved } from './profiles/reserved.js';
import { render } from './rules.js';
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
 * Правки реплик из базы, применённые к словарю (§13.9, задача 4.13).
 *
 * Хранится **готовый** объект, а не карта переопределений: реплики
 * берутся десятками раз за выгрузку, и склеивать словарь на каждое
 * обращение значило бы платить за правку, которой обычно нет. Склейка
 * происходит один раз — когда правки меняются.
 */
let patched: Readonly<Record<string, TextProfile>> = profiles;

/**
 * Применить правки, пришедшие из базы.
 *
 * Пустая карта возвращает словарь к тому, что в коде, — это и есть
 * «вернуть как было» для всех реплик разом.
 *
 * Зовёт `TextsRegistry`, и только он: источник правды один, и подмешать
 * реплики откуда-то ещё нельзя незаметно.
 */
export function applyOverrides(overrides: ReadonlyMap<string, string>): void {
  if (overrides.size === 0) {
    patched = profiles;
    return;
  }

  patched = Object.fromEntries(
    Object.entries(profiles).map(([name, profile]) => [name, patch(profile, overrides)]),
  );
}

/**
 * Словарь с заменёнными репликами.
 *
 * Простая реплика заменяется строкой. Параметризованная — функцией,
 * которая подставляет значения в правку по номерам: `{1}` — первый
 * аргумент, `{2}` — второй. Что все подстановки на месте, проверено при
 * записи; здесь остаётся только подставить.
 *
 * Обход рекурсивный, а замена — по пути: так правка одной реплики не
 * задевает соседей и не зависит от того, где именно в словаре она лежит.
 */
function patch(profile: TextProfile, overrides: ReadonlyMap<string, string>): TextProfile {
  const walk = (value: unknown, path: string): unknown => {
    const override = overrides.get(path);

    if (typeof value === 'string') {
      return override ?? value;
    }

    if (typeof value === 'function') {
      if (override === undefined) return value;

      const replaced = (...args: readonly unknown[]): string => render(override, args);

      /**
       * Арность сохраняется, и это не косметика.
       *
       * У обёртки с `...args` она равна нулю, а по ней считается, сколько
       * значений реплика подставляет. Оставь ноль — и правленая реплика
       * стала бы выглядеть простой: редактор отверг бы её следующую
       * правку с `{1}` словами «нечего подставлять», то есть человек не
       * смог бы поправить то, что уже поправил. Поймано проверкой формы.
       */
      Object.defineProperty(replaced, 'length', { value: value.length });

      return replaced;
    }

    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          walk(nested, path === '' ? key : `${path}.${key}`),
        ]),
      );
    }

    return value;
  };

  /**
   * Приведение одно и здесь.
   *
   * Обход работает со словарём как с деревом значений: типу известно,
   * что на месте строки будет строка, а на месте функции — функция, но
   * доказать это обходом нельзя. Взамен форму держит проверка: реплика
   * подменяется только той же природы, и на это стоит тест.
   */
  return walk(profile, '') as TextProfile;
}

/**
 * Тексты для пользователя.
 *
 * Неизвестное имя не считается ошибкой и не роняет ответ: человек в этот
 * момент ждёт разбор своей выгрузки, и отказ ради опечатки в настройке
 * был бы обменом важного на неважное. Берётся профиль по умолчанию.
 *
 * Правки из базы уже применены: `textsFor` осталась синхронной нарочно —
 * её зовут из мест, где `await` взять негде, и план обещал, что вызовы
 * менять не придётся.
 */
export function textsFor(profile?: string | null): TextProfile {
  if (profile != null) {
    const found = patched[profile];
    if (found) return found;
  }

  return patched[DEFAULT_PROFILE] ?? reserved;
}

/**
 * Словарь **из кода**, без правок из базы.
 *
 * Нужен двум разным читателям, и обоим нужен именно кодовый:
 *
 * - проверкам — иначе они мерили бы то, что кто-то поправил в панели, и
 *   краснели бы от чужой правки, а не от поломки;
 * - местам, где реплика обязана быть на месте всегда: реплики из кода
 *   лежат в репозитории и заведомо прошли §13.
 *
 * **Первый экран сюда не относится и берёт `textsFor()`.** Приветствие
 * §13.1 заказчица правит наравне с остальным, и застывшее значение
 * означало бы «без выкладки, кроме самого первого, что видит человек».
 */
export const defaultTexts: TextProfile = reserved;

export type { TextProfile } from './types.js';
