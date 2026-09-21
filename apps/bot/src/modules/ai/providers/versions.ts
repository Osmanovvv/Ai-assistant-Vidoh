import type { CompletionRequest, CompletionResult, LlmProvider } from './types.js';

/**
 * Сборки моделей, на которых мерился порог качества и назначены цены
 * (22.09.2026, закрепление модели по имени).
 *
 * Имя модели у Yandex — не сборка, а указатель: `yandexgpt/latest` они
 * дважды переставляли на новое поколение (июнь и декабрь 2024), а старое
 * потом отключали. Сейчас за явным именем стоит одна сборка, но и её
 * никто не обещал навсегда. Значения — из учёта боя 27.08–21.09.2026:
 * за месяц полная модель отвечала только `09.02.2025` (501 вызов), лёгкая
 * — только `25.03.2025` (221 вызов); живой набор 21.09 (98,5 %) мерился
 * на них же.
 *
 * Когда за именем окажется другая сборка, изменятся и разбор, и цена, и
 * никто ничего не трогал. Сторож ниже говорит об этом в журнал в тот же
 * день — уровнем предупреждения, который смотрят после каждой выкладки.
 */
export const EXPECTED_MODEL_VERSIONS: Readonly<Record<string, string>> = {
  'yandex:yandexgpt-5-pro': '09.02.2025',
  'yandex:yandexgpt/latest': '09.02.2025',
  'yandex:yandexgpt-5-lite': '25.03.2025',
  'yandex:yandexgpt-lite/latest': '25.03.2025',
};

export interface VersionDrift {
  readonly model: string;
  readonly expected: string;
  readonly actual: string;
}

interface Warner {
  warn(context: object, message: string): void;
}

/**
 * Один на процесс: помнит, о каких сборках уже сказал, — иначе журнал за
 * день был бы тысячей одинаковых строк, и их перестали бы читать.
 */
export class ModelVersionWatch {
  private readonly told = new Set<string>();

  constructor(
    private readonly log: Warner,
    private readonly expected: Readonly<Record<string, string>> = EXPECTED_MODEL_VERSIONS,
  ) {}

  /** Возвращает расхождение, если сборка не та; без версии судить не о чем. */
  note(model: string, version: string | undefined): VersionDrift | undefined {
    const expected = this.expected[model];
    if (expected === undefined || version === undefined || version === expected) return undefined;

    const drift: VersionDrift = { model, expected, actual: version };
    const key = `${model} ${version}`;
    if (!this.told.has(key)) {
      this.told.add(key);
      this.log.warn(
        drift,
        'Модель отвечает не той сборкой, на которой мерился порог качества и назначена цена',
      );
    }

    return drift;
  }
}

/** Провайдер с тем же именем и ответом: сторож только смотрит версию. */
export function watchVersions(provider: LlmProvider, watch: ModelVersionWatch): LlmProvider {
  return {
    name: provider.name,
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const result = await provider.complete(request);
      watch.note(provider.name, result.modelVersion);
      return result;
    },
  };
}
