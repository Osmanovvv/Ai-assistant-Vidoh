import type { ClassifiedItem } from '../modules/classifier/classifier.service.js';
import type { ExpectedUnit, RetractedPlan } from './dataset.js';

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
 *
 * **Внутри одного корня можно перечислить замены через «|»** (задача
 * 3.56). Одно и то же дело человек называет двумя словами, и оба его:
 * «Ещё в четверг хотел заехать я на мойку… вот в пятницу тогда надо
 * помыть машину». Разбор вправе назвать это и «заехать на мойку», и
 * «помыть машину», и требовать одно из двух значило бы мерить не
 * качество разбора, а нашу догадку о его словах. Корень «мойк|машин»
 * подходит, если есть **любой** из них; между разными корнями правило
 * прежнее — нужны все.
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
  /**
   * Отменённое человеком, что разбор всё же завёл записью (задача 3.56).
   *
   * Подмножество `extra`: считается и там, и здесь. В «лишних» — потому
   * что запись действительно лишняя, отдельным числом — потому что порог
   * по ней ноль, а у лишних он 25%.
   */
  readonly retracted: readonly ClassifiedItem[];
}

/** Один корень: подходит, если найдена любая из замен, перечисленных «|». */
function hasRoot(text: string, keyword: string): boolean {
  return normalize(keyword)
    .split('|')
    .filter((one) => one.length > 0)
    .some((one) => text.includes(one));
}

function fits(unit: ExpectedUnit, item: ClassifiedItem): boolean {
  const text = normalize(item.text);
  return unit.keywords.every((keyword) => hasRoot(text, keyword));
}

/** Узнаётся ли в записи отменённый замысел: правило то же, что у ожиданий. */
function fitsPlan(plan: RetractedPlan, item: ClassifiedItem): boolean {
  const text = normalize(item.text);
  return plan.keywords.every((keyword) => hasRoot(text, keyword));
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
  retracted: readonly RetractedPlan[] = [],
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

  const leftovers = actual.filter((item) => !taken.has(item));

  /**
   * Отменённое ищется только среди незанятых записей (задача 3.56).
   *
   * Запись, закрывшая ожидание, законна по определению: разметка её ждала.
   * Нарушение — добавочная запись с отменённым замыслом.
   */
  const cancelled = leftovers.filter((item) => retracted.some((plan) => fitsPlan(plan, item)));

  return {
    matched,
    missed,
    extra: leftovers,
    ambiguous,
    retracted: cancelled,
  };
}
