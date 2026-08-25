/**
 * Цены моделей (задача 1.16).
 *
 * Стоимость считается в микроединицах валюты целым числом: суммирование
 * тысяч мелких дробей в плавающей точке накапливает ошибку, а расход
 * должен сходиться с выставленным счётом.
 *
 * Валюта хранится рядом с суммой и не приводится к одной. Курс меняется,
 * и пересчёт по курсу «на сегодня» превратил бы себестоимость прошлого
 * месяца в оценку. Провайдеры к тому же выставляют счёт каждый в своей
 * валюте: OpenAI в долларах, Yandex Cloud в рублях.
 *
 * Таблицу надо держать в согласии с прайс-листом провайдера. Неизвестная
 * модель даёт null, а не ноль: молчаливый ноль превратил бы «мы не знаем
 * цену» в «это бесплатно», и себестоимость оказалась бы занижена.
 */

const MICROS_IN_UNIT = 1_000_000;

export type Currency = 'usd' | 'rub';

export interface TokenPricing {
  readonly kind: 'tokens';
  readonly currency: Currency;
  /** Цена за миллион входных токенов. */
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

export interface AudioPricing {
  readonly kind: 'audio';
  readonly currency: Currency;
  /** Цена за минуту аудио. */
  readonly perMinute: number;
  /**
   * Минимальный оплачиваемый отрезок в секундах.
   *
   * Распознавание речи тарифицируется блоками: у Yandex SpeechKit это
   * пятнадцать секунд, и трёхсекундная запись стоит столько же, сколько
   * пятнадцатисекундная. Без округления вверх себестоимость коротких
   * выгрузок оказалась бы занижена в разы — а короткие выгрузки как раз
   * и составят основную массу.
   */
  readonly billingBlockSec?: number;
}

export type ModelPricing = TokenPricing | AudioPricing;

export interface Cost {
  readonly micros: number;
  readonly currency: Currency;
}

/**
 * Прайс-лист. Значения задаются здесь, а не в переменных окружения:
 * изменение цены — это изменение кода, которое должно пройти ревью
 * и остаться в истории.
 *
 * Пусто намеренно. Цену распознавания у Yandex SpeechKit на 24.08.2026
 * подтвердить не удалось: страница тарифов отвечает капчей, а сторонние
 * пересказы расходятся на порядок. Выдуманное число здесь было бы хуже
 * пустоты: расход считался бы уверенно и неправильно, а так он честно
 * помечается неизвестным — см. `modelsWithoutPrice`.
 */
export const PRICING: Readonly<Record<string, ModelPricing>> = {};

export interface UsageAmount {
  readonly tokensIn?: number | undefined;
  readonly tokensOut?: number | undefined;
  readonly audioSeconds?: number | undefined;
}

/**
 * Стоимость вызова. null означает, что цена модели неизвестна или данных
 * о расходе недостаточно.
 */
export function callCost(
  model: string,
  usage: UsageAmount,
  pricing: Readonly<Record<string, ModelPricing>> = PRICING,
): Cost | null {
  const price = pricing[model];
  if (!price) return null;

  if (price.kind === 'audio') {
    if (usage.audioSeconds === undefined) return null;

    const block = price.billingBlockSec ?? 1;
    const billedSec = Math.ceil(usage.audioSeconds / block) * block;

    return {
      micros: Math.round((billedSec / 60) * price.perMinute * MICROS_IN_UNIT),
      currency: price.currency,
    };
  }

  if (usage.tokensIn === undefined && usage.tokensOut === undefined) return null;

  const input = ((usage.tokensIn ?? 0) / 1_000_000) * price.inputPerMillion;
  const output = ((usage.tokensOut ?? 0) / 1_000_000) * price.outputPerMillion;

  return {
    micros: Math.round((input + output) * MICROS_IN_UNIT),
    currency: price.currency,
  };
}

/** Микроединицы в единицы валюты — только для отображения. */
export function microsToUnits(micros: number): number {
  return micros / MICROS_IN_UNIT;
}

export function formatCost(cost: Cost | null): string {
  if (cost === null) return 'цена неизвестна';

  const amount = microsToUnits(cost.micros).toFixed(6);
  return cost.currency === 'usd' ? `$${amount}` : `${amount} ₽`;
}

/**
 * Модели без цены в прайс-листе. Нужна при старте: список пустой означает,
 * что себестоимость посчитается, непустой — что часть расхода уйдёт в
 * «неизвестно», и об этом лучше узнать из лога, а не из отчёта через месяц.
 */
export function modelsWithoutPrice(
  models: readonly string[],
  pricing: Readonly<Record<string, ModelPricing>> = PRICING,
): readonly string[] {
  return models.filter((model) => pricing[model] === undefined);
}
