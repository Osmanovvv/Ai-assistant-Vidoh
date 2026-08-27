/**
 * Раскладка голосовых по запросам к распознавателю (задача 1.14,
 * дополнено 27.08.2026).
 *
 * SpeechKit берёт деньги блоками по 15 секунд **за запрос**: запись на 4
 * секунды и запись на 14 стоят одинаково. Живая выгрузка 27.08.2026 —
 * девять голосовых, 172 секунды речи — обошлась в семнадцать блоков вместо
 * двенадцати именно потому, что каждая запись округлялась сама по себе.
 *
 * Отсюда задача: разбить голосовые на группы так, чтобы блоков вышло как
 * можно меньше. Ограничение одно — тело запроса. Оно же переводится в
 * потолок длительности (см. MAX_SEGMENT_SEC).
 *
 * **Почему не «склеить всё и порезать».** Резать склейку на части значит
 * округлять каждую часть заново: 180 секунд, разрезанные по 82, дают
 * 6 + 6 + 2 = 14 блоков вместо двенадцати. Группы, собранные заранее,
 * режутся по границам сообщений — а там пауза, и слово не пострадает.
 *
 * **Почему перебор, а не жадность.** Жадная раскладка набивает первую
 * группу до упора и на живой выгрузке даёт те же 13 блоков, но проигрывает
 * на других раскладах: длинная запись, влезающая с хвостом в 14 секунд,
 * тянет за собой лишний блок. Записей в выгрузке максимум пятнадцать,
 * поэтому точный перебор стоит доли миллисекунды и даёт настоящий минимум.
 */

export interface VoiceForGrouping {
  readonly messageId: string;
  /**
   * Длительность по данным Telegram, в секундах. Целая — этого хватает:
   * здесь решается только вопрос вместимости, а точные границы внутри
   * склейки измеряются потом, по готовым файлам.
   */
  readonly durationSec: number;
}

export interface GroupingOptions {
  /** Потолок длительности одного запроса. */
  readonly capacitySec: number;
  /** Пауза, которая вставляется между записями при склейке. */
  readonly pauseSec: number;
  /** Блок оплаты: 15 секунд у SpeechKit. */
  readonly blockSec: number;
}

/**
 * Длительность склейки группы: сумма записей плюс паузы между ними.
 */
function lengthOf(
  voices: readonly VoiceForGrouping[],
  from: number,
  to: number,
  pauseSec: number,
): number {
  let total = 0;
  for (let index = from; index <= to; index++) {
    total += voices[index]?.durationSec ?? 0;
  }

  return total + pauseSec * (to - from);
}

/**
 * Разбивает подряд идущие голосовые на группы с минимальным числом
 * оплаченных блоков.
 *
 * Записи, которые сами по себе не влезают в запрос, выделяются в отдельную
 * группу: их всё равно придётся резать по паузам внутри самой записи, и это
 * умеет прежний путь по одному сообщению.
 */
export function groupVoices(
  voices: readonly VoiceForGrouping[],
  options: GroupingOptions,
): readonly (readonly VoiceForGrouping[])[] {
  if (voices.length === 0) return [];

  const groups: (readonly VoiceForGrouping[])[] = [];
  let runStart = 0;

  const flushRun = (endExclusive: number): void => {
    if (endExclusive <= runStart) return;
    groups.push(...packRun(voices.slice(runStart, endExclusive), options));
  };

  for (const [index, voice] of voices.entries()) {
    if (voice.durationSec <= options.capacitySec) continue;

    // Слишком длинная запись рвёт цепочку: до неё — группа, она сама —
    // отдельно, после неё — снова с начала.
    flushRun(index);
    groups.push([voice]);
    runStart = index + 1;
  }

  flushRun(voices.length);

  return groups;
}

/** Точный перебор внутри участка, где каждая запись влезает в запрос. */
function packRun(
  voices: readonly VoiceForGrouping[],
  options: GroupingOptions,
): readonly (readonly VoiceForGrouping[])[] {
  const count = voices.length;
  if (count === 0) return [];

  /**
   * Лучшая стоимость первых i записей, число групп в этом решении и место,
   * с которого начиналась последняя группа.
   *
   * Число групп — не украшение, а разрешение ничьей. На живой выгрузке
   * 27.08.2026 нашлись два решения по тринадцать блоков: в три группы и в
   * пять. Денег одинаково, но пять запросов — это пять ожиданий и пять
   * поводов сорваться. При равной цене берём меньше запросов.
   */
  const best = new Array<number>(count + 1).fill(Number.POSITIVE_INFINITY);
  const parts = new Array<number>(count + 1).fill(Number.POSITIVE_INFINITY);
  const from = new Array<number>(count + 1).fill(0);
  best[0] = 0;
  parts[0] = 0;

  for (let end = 1; end <= count; end++) {
    for (let start = end; start >= 1; start--) {
      const length = lengthOf(voices, start - 1, end - 1, options.pauseSec);
      // Дальше группа только растёт, значит продолжать смысла нет.
      if (length > options.capacitySec) break;

      const blocks = Math.ceil(length / options.blockSec);
      const candidate = (best[start - 1] ?? Number.POSITIVE_INFINITY) + blocks;
      const candidateParts = (parts[start - 1] ?? Number.POSITIVE_INFINITY) + 1;

      const currentBest = best[end] ?? Number.POSITIVE_INFINITY;
      const currentParts = parts[end] ?? Number.POSITIVE_INFINITY;

      if (candidate < currentBest || (candidate === currentBest && candidateParts < currentParts)) {
        best[end] = candidate;
        parts[end] = candidateParts;
        from[end] = start - 1;
      }
    }
  }

  const groups: (readonly VoiceForGrouping[])[] = [];
  let cursor = count;
  while (cursor > 0) {
    const start = from[cursor] ?? 0;
    groups.push(voices.slice(start, cursor));
    cursor = start;
  }

  return groups.reverse();
}

/** Во сколько блоков обойдётся раскладка. Нужно замерам и тестам. */
export function blocksOf(
  groups: readonly (readonly VoiceForGrouping[])[],
  options: GroupingOptions,
): number {
  let blocks = 0;

  for (const group of groups) {
    const length = lengthOf(group, 0, group.length - 1, options.pauseSec);
    blocks += Math.ceil(length / options.blockSec);
  }

  return blocks;
}
