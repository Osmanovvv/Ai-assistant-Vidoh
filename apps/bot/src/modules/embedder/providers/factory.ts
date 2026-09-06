import type { ModelEnv } from '../../../config/env.js';
import { RecordingEmbeddingProvider, ReplayEmbeddingProvider } from '../../ai/cassette/provider.js';
import { cassetteSession } from '../../ai/cassette/session.js';
import { MockEmbeddingProvider } from './mock.js';
import type { EmbeddingProvider } from './types.js';
import { YANDEX_EMBEDDING_DIMENSIONS, YandexEmbeddingProvider } from './yandex.js';

/**
 * Выбор провайдера смысловых представлений (задача 2.9).
 *
 * Переключается той же переменной, что и языковая модель: это один и тот
 * же сервисный аккаунт и одна и та же область действия. Разводить их
 * двумя переменными значило бы однажды поставить заглушку на одно и
 * живого провайдера на другое, и половина конвейера тихо работала бы
 * на выдуманных данных.
 */
export function createEmbeddingProvider(env: ModelEnv): EmbeddingProvider {
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
      return new YandexEmbeddingProvider({
        apiKey: env.YANDEX_API_KEY,
        folderId: env.YANDEX_FOLDER_ID,
      });
    }

    case 'mock':
      return new MockEmbeddingProvider();

    /**
     * Вектора тоже пишутся (задача 3.80), и это не роскошь: от них
     * зависит поиск кандидатов. Подставь сюда выдуманные числа — и
     * резолвер получит другой список записей, то есть другой вход, то
     * есть промах по записи. Весь смысл записи — в повторяемости.
     */
    case 'cassette': {
      const session = cassetteSession(env);

      if (session.mode === 'replay') {
        if (session.player === undefined) throw new Error('запись открыта без читалки');
        return new ReplayEmbeddingProvider(session.player, YANDEX_EMBEDDING_DIMENSIONS);
      }

      if (session.recorder === undefined) throw new Error('запись открыта без копилки');

      if (env.YANDEX_API_KEY === undefined || env.YANDEX_FOLDER_ID === undefined) {
        throw new Error('для записи нужны YANDEX_API_KEY и YANDEX_FOLDER_ID');
      }

      return new RecordingEmbeddingProvider(
        new YandexEmbeddingProvider({
          apiKey: env.YANDEX_API_KEY,
          folderId: env.YANDEX_FOLDER_ID,
        }),
        session.recorder,
      );
    }
  }
}
