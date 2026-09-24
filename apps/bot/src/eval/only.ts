/**
 * `--only`: какие случаи набора гнать (план docs/26, задача 1).
 *
 * Живой прогон стоит денег за каждый случай, и замер «как сейчас» нужен
 * только на части набора. Отдельная папка под каждую часть — это копии,
 * которые расходятся с набором; фильтр по началу `id` — нет.
 *
 * Ошибки громкие намеренно. Флаг без значения, молча превращённый в
 * «весь набор», заплатит за случаи, которых не просили; фильтр, не
 * совпавший ни с чем, даст пустой прогон, который отчёт посчитает
 * пройденным.
 */

export class BadOnlyError extends Error {
  constructor(problem: string) {
    super(`--only: ${problem}`);
    this.name = 'BadOnlyError';
  }
}

export interface ParsedOnly {
  /** Начала `id`; `undefined` — фильтра нет, гнать всё. */
  readonly only: readonly string[] | undefined;
  /** Аргументы без `--only` и его значения. */
  readonly rest: string[];
}

function prefixes(value: string | undefined): string[] {
  // Следующий флаг значением не бывает: `--only --budget 20` съел бы потолок.
  if (value?.startsWith('--') === true) {
    throw new BadOnlyError(`вместо значения стоит флаг «${value}»`);
  }
  const list = (value ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter((one) => one !== '');
  if (list.length === 0)
    throw new BadOnlyError('нужно значение: начало id или список через запятую');
  return list;
}

export function parseOnly(args: readonly string[]): ParsedOnly {
  const rest: string[] = [];
  let only: string[] | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';

    if (argument === '--only') {
      only = prefixes(args[index + 1]);
      index += 1;
      continue;
    }

    if (argument.startsWith('--only=')) {
      only = prefixes(argument.slice('--only='.length));
      continue;
    }

    rest.push(argument);
  }

  return { only, rest };
}

export function pickCases<T extends { readonly id: string }>(
  cases: readonly T[],
  only: readonly string[] | undefined,
): T[] {
  if (only === undefined) return [...cases];

  const picked = cases.filter((item) => only.some((prefix) => item.id.startsWith(prefix)));
  if (picked.length === 0) {
    throw new BadOnlyError(
      `ни один случай не начинается с ${only.map((one) => `«${one}»`).join(', ')}`,
    );
  }
  return picked;
}
