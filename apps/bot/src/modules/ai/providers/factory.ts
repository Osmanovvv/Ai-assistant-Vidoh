import type { ModelEnv } from '../../../config/env.js';
import { RecordingLlmProvider, ReplayLlmProvider } from '../cassette/provider.js';
import { cassetteSession } from '../cassette/session.js';
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

    /**
     * Запись ответов (задача 3.80): либо спрашиваем живую модель и
     * складываем, либо отвечаем из файла и в сеть не ходим.
     *
     * В бою запрещено схемой окружения: запись отвечает правдоподобно —
     * ответы настоящие, просто чужие и вчерашние, — и человек не
     * заподозрил бы подмены.
     */
    case 'cassette': {
      const session = cassetteSession(env);

      if (session.mode === 'replay') {
        if (session.player === undefined) throw new Error('запись открыта без читалки');
        return new ReplayLlmProvider(session.player);
      }

      if (session.recorder === undefined) throw new Error('запись открыта без копилки');

      return new RecordingLlmProvider({
        live: liveYandex(env, choice),
        recorder: session.recorder,
        recordedAt: new Date(),
      });
    }
  }
}

/**
 * Живой Yandex — отдельной функцией, чтобы запись спрашивала ровно того
 * же провайдера, что и бой. Иначе записанное однажды разошлось бы с тем,
 * что бот получает на самом деле.
 */
function liveYandex(env: ModelEnv, choice: ProviderChoice): LlmProvider {
  if (env.YANDEX_API_KEY === undefined || env.YANDEX_FOLDER_ID === undefined) {
    throw new Error('для записи нужны YANDEX_API_KEY и YANDEX_FOLDER_ID');
  }

  return new YandexLlmProvider({
    apiKey: env.YANDEX_API_KEY,
    folderId: env.YANDEX_FOLDER_ID,
    model: choice.light === true ? env.YANDEX_LLM_MODEL_LIGHT : env.YANDEX_LLM_MODEL,
  });
}
