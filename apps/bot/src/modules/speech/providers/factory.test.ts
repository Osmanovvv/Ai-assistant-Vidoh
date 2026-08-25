import { describe, expect, it } from 'vitest';

import { parseEnv, type Env } from '../../../config/env.js';
import { createSpeechProvider } from './factory.js';

/**
 * Условие готовности задачи 1.15: переключение реализации делается одной
 * переменной окружения. Проверяется буквально это.
 */

const base: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_URL: 'https://bot.vydoh.test',
  PRIVACY_POLICY_URL: 'https://vydoh.test/privacy',
  BOT_TOKEN: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  BOT_WEBHOOK_SECRET: 'a'.repeat(32),
  DATABASE_URL: 'postgres://vydoh:vydoh@localhost:5434/vydoh',
  REDIS_URL: 'redis://localhost:6379',
};

const envWith = (overrides: Record<string, string>): Env => parseEnv({ ...base, ...overrides });

describe('createSpeechProvider', () => {
  it('одна переменная переключает реализацию', () => {
    const mock = createSpeechProvider(envWith({ SPEECH_PROVIDER: 'mock' }));
    const yandex = createSpeechProvider(
      envWith({ SPEECH_PROVIDER: 'yandex', YANDEX_API_KEY: 'ключ' }),
    );
    const openai = createSpeechProvider(
      envWith({ SPEECH_PROVIDER: 'openai', OPENAI_API_KEY: 'ключ' }),
    );

    expect(mock.name).toBe('mock');
    expect(yandex.name).toBe('yandex:general');
    expect(openai.name).toBe('openai:whisper-1');
  });

  it('передаёт выбранную модель провайдеру', () => {
    const provider = createSpeechProvider(
      envWith({
        SPEECH_PROVIDER: 'yandex',
        YANDEX_API_KEY: 'ключ',
        YANDEX_SPEECH_MODEL: 'deluxe',
      }),
    );

    expect(provider.name).toBe('yandex:deluxe');
  });

  it('по умолчанию отдаёт заглушку', () => {
    expect(createSpeechProvider(envWith({})).name).toBe('mock');
  });

  it('падает внятно, если ключ потерялся после разбора конфигурации', () => {
    // Разбор конфигурации это уже не пропустит, но фабрика не должна
    // полагаться на то, что кто-то снаружи всё проверил: иначе отказ
    // случится где-то посреди обработки чужого голосового.
    const broken = { ...envWith({}), SPEECH_PROVIDER: 'yandex' as const };

    expect(() => createSpeechProvider(broken)).toThrow(/YANDEX_API_KEY/u);
  });
});
