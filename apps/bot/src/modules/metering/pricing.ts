/**
 * Цены моделей (задача 1.16).
 *
 * Стоимость считается в микродолларах целым числом: суммирование тысяч
 * мелких дробей в плавающей точке накапливает ошибку, а расход должен
 * сходиться с выставленным счётом.
 *
 * Таблицу надо держать в согласии с прайс-листом провайдера. Неизвестная
 * модель даёт null, а не ноль: молчаливый ноль превратил бы «мы не знаем
 * цену» в «это бесплатно», и себестоимость оказалась бы занижена.
 */

const MICROS_IN_USD = 1_000_000;

export interface TokenPricing {
  readonly kind: 'tokens';
  /** Долларов за миллион входных токенов. */
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

export interface AudioPricing {
  readonly kind: 'audio';
  /** Долларов за минуту аудио. */
  readonly perMinuteUsd: number;
}

export type ModelPricing = TokenPricing | AudioPricing;

/**
 * Прайс-лист. Значения задаются здесь, а не в переменных окружения:
 * изменение цены — это изменение кода, которое должно пройти ревью
 * и остаться в истории.
 */
export const PRICING: Readonly<Record<string, ModelPricing>> = {
  // Заполняется по мере подключения моделей на задаче 1.15.
};

export interface UsageAmount {
  readonly tokensIn?: number | undefined;
  readonly tokensOut?: number | undefined;
  readonly audioSeconds?: number | undefined;
}

/**
 * Стоимость вызова в микродолларах. null означает, что цена модели
 * неизвестна или данных о расходе недостаточно.
 */
export function costMicros(
  model: string,
  usage: UsageAmount,
  pricing: Readonly<Record<string, ModelPricing>> = PRICING,
): number | null {
  const price = pricing[model];
  if (!price) return null;

  if (price.kind === 'audio') {
    if (usage.audioSeconds === undefined) return null;
    const minutes = usage.audioSeconds / 60;
    return Math.round(minutes * price.perMinuteUsd * MICROS_IN_USD);
  }

  if (usage.tokensIn === undefined && usage.tokensOut === undefined) return null;

  const input = ((usage.tokensIn ?? 0) / 1_000_000) * price.inputPerMillionUsd;
  const output = ((usage.tokensOut ?? 0) / 1_000_000) * price.outputPerMillionUsd;

  return Math.round((input + output) * MICROS_IN_USD);
}

/** Микродоллары в доллары — только для отображения. */
export function microsToUsd(micros: number): number {
  return micros / MICROS_IN_USD;
}

export function formatUsd(micros: number | null): string {
  return micros === null ? 'цена неизвестна' : `$${microsToUsd(micros).toFixed(6)}`;
}
