import type { Item } from '../../db/schema.js';

/**
 * Повтор той же выгрузки (найдено на боевом 01.09.2026).
 *
 * **Человек отправил одно и то же голосовое три раза, и бот завёл
 * восемнадцать записей вместо шести.** Отправлял он повторно потому, что
 * ответ показывал не то, о чём он говорил, — то есть один дефект породил
 * второй. Первый починен порядком выдачи, но и второй надо закрыть: люди
 * повторяются и без наших ошибок — сеть отвалилась, показалось, что не
 * отправилось, вспомнил и сказал ещё раз.
 *
 * **Сверяется дословный текст, а не близость по смыслу.** Векторный
 * поиск в проекте есть, и соблазн применить его здесь велик — но цена
 * ошибки несимметрична. Пропущенный повтор даёт лишнюю строку в списке;
 * ложное совпадение **молча съедает сказанное**, а это ровно то, чего
 * продукт обещает не делать. «Позвонить маме» и «позвонить папе» по
 * вектору соседи.
 *
 * Дословное совпадение такой ошибки допустить не может: если строки
 * совпали до знака, это одно и то же дело, названное дважды.
 */

/**
 * Приводит текст к виду, в котором его можно сравнивать.
 *
 * Регистр и «ё» — потому что расшифровка речи их не гарантирует: одно и
 * то же голосовое дважды может прийти как «Съездить в магазин» и
 * «съездить в магазин». Пробелы — потому что их число ничего не значит.
 * Хвостовая точка — потому что расшифровка ставит её через раз.
 */
export function sameTextKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .replace(/[.!]+$/u, '')
    .trim();
}

export interface KnownItems {
  /** Уже открытые записи с таким же текстом: ключ — `sameTextKey`. */
  readonly byText: ReadonlyMap<string, Item>;
}

/**
 * Собирает указатель по открытым записям человека.
 *
 * Если одинаковый текст встретился дважды среди уже открытых (а он
 * встретился — дубли за 31.08 лежат в бою), берётся **самая ранняя**:
 * повтор присоединяется к первой записи, а не к последней копии.
 */
export function knownByText(open: readonly Item[]): KnownItems {
  const byText = new Map<string, Item>();

  for (const item of open) {
    const key = sameTextKey(item.text);
    const seen = byText.get(key);

    if (seen === undefined || item.createdAt.getTime() < seen.createdAt.getTime()) {
      byText.set(key, item);
    }
  }

  return { byText };
}

export interface SplitResult<T> {
  /** Чего у человека ещё нет — это и надо завести. */
  readonly fresh: readonly T[];
  /** Что уже есть: заводить не надо, но человек об этом сейчас говорил. */
  readonly known: readonly Item[];
}

/**
 * Делит разобранные единицы на новые и уже имеющиеся.
 *
 * Повтор внутри одной выгрузки тоже считается повтором: если человек в
 * одной речи дважды сказал «купить хлеб», записей должно стать одна.
 */
export function splitKnown<T extends { readonly text: string }>(
  units: readonly T[],
  known: KnownItems,
): SplitResult<T> {
  const fresh: T[] = [];
  const found: Item[] = [];
  const taken = new Set<string>();

  for (const unit of units) {
    const key = sameTextKey(unit.text);

    if (taken.has(key)) continue;
    taken.add(key);

    const existing = known.byText.get(key);
    if (existing === undefined) {
      fresh.push(unit);
      continue;
    }

    found.push(existing);
  }

  return { fresh, known: found };
}
