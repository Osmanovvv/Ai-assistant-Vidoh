import type { ModelEnv } from '../../../config/env.js';
import { MockSpeechProvider } from './mock.js';
import { OpenAiSpeechProvider } from './openai.js';
import type { SpeechProvider } from './types.js';
import { YandexSpeechProvider } from './yandex.js';

/**
 * Выбор провайдера расшифровки (задача 1.15).
 *
 * Условие готовности задачи: переключение реализации делается одной
 * переменной окружения. Вся развилка живёт здесь, поэтому остальной код
 * видит только интерфейс и не знает, кто за ним стоит.
 *
 * Обязательность ключей проверяется при разборе конфигурации, но проверки
 * повторены и здесь: конструктор не должен зависеть от того, что кто-то
 * снаружи уже всё проверил, иначе отсутствие ключа обернётся невнятным
 * падением где-то посреди обработки чужого голосового.
 */
export function createSpeechProvider(env: ModelEnv): SpeechProvider {
  switch (env.SPEECH_PROVIDER) {
    case 'yandex': {
      if (env.YANDEX_API_KEY === undefined) {
        throw new Error('SPEECH_PROVIDER=yandex, но YANDEX_API_KEY не задан');
      }
      return new YandexSpeechProvider({
        apiKey: env.YANDEX_API_KEY,
        folderId: env.YANDEX_FOLDER_ID,
        model: env.YANDEX_SPEECH_MODEL,
      });
    }

    case 'openai': {
      if (env.OPENAI_API_KEY === undefined) {
        throw new Error('SPEECH_PROVIDER=openai, но OPENAI_API_KEY не задан');
      }
      return new OpenAiSpeechProvider({
        apiKey: env.OPENAI_API_KEY,
        ...(env.OPENAI_BASE_URL === undefined ? {} : { baseUrl: env.OPENAI_BASE_URL }),
        model: env.OPENAI_SPEECH_MODEL,
      });
    }

    case 'mock':
      return new MockSpeechProvider();
  }
}
