import type { ModelEnv } from '../../../config/env.js';
import { MockLlmProvider } from './mock.js';
import type { LlmProvider } from './types.js';
import { YandexLlmProvider } from './yandex.js';

/**
 * Выбор провайдера языковой модели (задача 2.3).
 *
 * Развилка живёт в одном месте, поэтому остальной код видит только
 * интерфейс. Замена провайдера — это переменная окружения, а не правка
 * конвейера: на первом этапе провайдера распознавания уже пришлось
 * менять, и второй раз это должно стоить дешевле.
 *
 * Проверки ключей повторены здесь намеренно, хотя их делает и разбор
 * конфигурации. Конструктор не должен полагаться на то, что кто-то
 * снаружи всё проверил: иначе отсутствие каталога обернётся невнятным
 * отказом посреди разбора чужой выгрузки.
 */
export interface ProviderChoice {
  /**
   * Взять лёгкую модель вместо полной.
   *
   * Отдельный экземпляр провайдера, а не подмена модели в запросе:
   * название модели у провайдера попадает в учёт расхода, и подмена
   * сделала бы себестоимость недостоверной — списали бы по цене полной
   * модели то, что считала лёгкая.
   */
  readonly light?: boolean;
}

export function createLlmProvider(env: ModelEnv, choice: ProviderChoice = {}): LlmProvider {
  switch (env.AI_PROVIDER) {
    case 'yandex': {
      if (env.YANDEX_API_KEY === undefined) {
        throw new Error('AI_PROVIDER=yandex, но YANDEX_API_KEY не задан');
      }
      if (env.YANDEX_FOLDER_ID === undefined) {
        throw new Error(
          'AI_PROVIDER=yandex, но YANDEX_FOLDER_ID не задан: из него собирается modelUri',
        );
      }
      return new YandexLlmProvider({
        apiKey: env.YANDEX_API_KEY,
        folderId: env.YANDEX_FOLDER_ID,
        model: choice.light === true ? env.YANDEX_LLM_MODEL_LIGHT : env.YANDEX_LLM_MODEL,
      });
    }

    case 'mock':
      return new MockLlmProvider();
  }
}
