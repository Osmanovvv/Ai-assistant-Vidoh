import type { ClassifiedItem } from '../modules/classifier/classifier.service.js';
import type { ExpectedUnit } from './dataset.js';

/**
 * Сопоставление разобранного с ожидаемым (задача 2.19).
 *
 * **Почему по корням, а не по строке.** Модель перефразирует: «проверить
 * список продуктов» превращается в «проверить продукты», «отнести вещи в
 * химчистку» — в «химчистка». Сверка по строке занижала бы качество на
 * пересказе, а не на ошибке, и порог 85% стал бы недостижим по причине,
 * не имеющей отношения к делу.
 *
 * **Почему все корни обязательны.** Один корень спутал бы «купить кофе» с
 * «купить пуфики»: оба про покупку. Требование всех корней делает
 * совпадение однозначным, а если оно всё же двоякое — виноват набор, и
 * это видно по двум ожиданиям, поймавшим одну запись.
 */

/** «Ё» приравнивается к «е», регистр не считается. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е');
}

export interface Match {
  readonly expected: ExpectedUnit;
  readonly actual: ClassifiedItem;
}

export interface MatchResult {
  readonly matched: readonly Match[];
  /** Ожидалось, но не нашлось. Потерянные дела — худший вид промаха. */
  readonly missed: readonly ExpectedUnit[];
  /** Нашлось, но не ожидалось: либо лишнее дробление, либо выдумка. */
  readonly extra: readonly ClassifiedItem[];
  /** Одно ожидание поймало несколько записей: набор размечен двояко. */
  readonly ambiguous: readonly ExpectedUnit[];
}

function fits(unit: ExpectedUnit, item: ClassifiedItem): boolean {
  const text = normalize(item.text);
  return unit.keywords.every((keyword) => text.includes(normalize(keyword)));
}

/**
 * Каждое ожидание берёт себе одну запись.
 *
 * Порядок жадный и намеренно простой: первое подошедшее и не занятое.
 * Точное паросочетание тут не нужно — при однозначной разметке результат
 * тот же, а при двоякой её надо править, а не обходить алгоритмом.
 */
export function match(
  expected: readonly ExpectedUnit[],
  actual: readonly ClassifiedItem[],
): MatchResult {
  const taken = new Set<ClassifiedItem>();
  const matched: Match[] = [];
  const missed: ExpectedUnit[] = [];
  const ambiguous: ExpectedUnit[] = [];

  /**
   * Обязательные ожидания разбираются первыми (задача 3.53).
   *
   * Иначе метка «двоякое дробление» не работает. В речи «Еще взять номер
   * телефона. Домика в Волконке и узнать о наличии свободных мест может
   * быть запланировать поездку на 5 7 сентября» разбор вправе сделать
   * одну запись. Если необязательное ожидание «номер» стоит в списке
   * раньше обязательного «поездк», оно забирает единственную запись
   * себе — и «поездк» уходит в потери вместе со своей проверкой срока.
   *
   * Порядок внутри каждой группы сохраняется: он задан разметкой и
   * повторяет порядок речи.
   */
  const byPriority = [
    ...expected.filter((one) => !one.optional),
    ...expected.filter((one) => one.optional),
  ];

  for (const unit of byPriority) {
    const candidates = actual.filter((item) => fits(unit, item));
    const free = candidates.find((item) => !taken.has(item));

    if (free === undefined) {
      /**
       * Необязательное ожидание, которого разбор не сделал, — не потеря
       * (задача 3.53). Оно помечено там, где оба чтения речи верны.
       */
      if (!unit.optional) missed.push(unit);
      continue;
    }

    if (candidates.length > 1) ambiguous.push(unit);

    taken.add(free);
    matched.push({ expected: unit, actual: free });
  }

  return {
    matched,
    missed,
    extra: actual.filter((item) => !taken.has(item)),
    ambiguous,
  };
}
