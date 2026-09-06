import { aiStage, type AiStage } from '../db/schema.js';

/**
 * Разбор флага `--use стадия=версия` у прогонов набора (задача 4.8).
 *
 * Прогон обычно мерит активные версии. Но §15 разрешает править промпт
 * из панели, а §10.3 запрещает включать непрогнанную версию — и без
 * возможности прогнать **конкретную** версию эти два требования запирают
 * друг друга насмерть: включить нельзя, пока не измерено, измерить
 * нельзя, пока не включено.
 *
 * Флаг разбирается здесь, а не в каждом скрипте, потому что наборов два
 * (общий и резолвера) и оба должны понимать его одинаково.
 */

export class BadPinError extends Error {
  constructor(argument: string) {
    super(
      `Не разобрал «${argument}». Нужно --use стадия=версия, ` +
        `стадия из: ${aiStage.enumValues.join(', ')}`,
    );
    this.name = 'BadPinError';
  }
}

/**
 * Вынимает прикрепления из аргументов. Возвращает и остаток аргументов —
 * позиционные пути прогонов не должны разъехаться от флага.
 */
export function parsePins(argv: readonly string[]): {
  readonly pinned: ReadonlyMap<AiStage, string>;
  readonly rest: readonly string[];
} {
  const pinned = new Map<AiStage, string>();
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) continue;

    // Две записи флага: «--use a=b» и «--use=a=b». Человек напишет
    // любую, а падать на второй — мелочно.
    const value =
      argument === '--use'
        ? argv[++index]
        : argument.startsWith('--use=')
          ? argument.slice(6)
          : undefined;

    if (value === undefined) {
      rest.push(argument);
      continue;
    }

    const at = value.indexOf('=');
    const stage = at === -1 ? '' : value.slice(0, at);
    const version = at === -1 ? '' : value.slice(at + 1);

    if (!(aiStage.enumValues as readonly string[]).includes(stage) || version === '') {
      throw new BadPinError(value);
    }

    pinned.set(stage as AiStage, version);
  }

  return { pinned, rest };
}
