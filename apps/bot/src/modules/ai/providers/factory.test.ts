import { describe, expect, it } from 'vitest';

import { parseEnv, type Env } from '../../../config/env.js';
import { createLlmProvider } from './factory.js';

/**
 * Условие готовности задачи 2.3: замена провайдера — одна переменная
 * окружения, а не правка конвейера. На первом этапе провайдера
 * распознавания уже пришлось менять, и второй раз это должно быть дешевле.
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

describe('createLlmProvider', () => {
  it('одна переменная переключает реализацию', () => {
    const mock = createLlmProvider(envWith({ AI_PROVIDER: 'mock' }));
    const yandex = createLlmProvider(
      envWith({ AI_PROVIDER: 'yandex', YANDEX_API_KEY: 'ключ', YANDEX_FOLDER_ID: 'каталог' }),
    );

    expect(mock.name).toBe('mock-llm');
    expect(yandex.name).toBe('yandex:yandexgpt/latest');
  });

  it('по умолчанию заглушка: разработка не зависит от чужого счёта', () => {
    expect(createLlmProvider(envWith({})).name).toBe('mock-llm');
  });

  it('передаёт выбранную модель', () => {
    const provider = createLlmProvider(
      envWith({
        AI_PROVIDER: 'yandex',
        YANDEX_API_KEY: 'ключ',
        YANDEX_FOLDER_ID: 'каталог',
        YANDEX_LLM_MODEL: 'yandexgpt-lite/latest',
      }),
    );

    expect(provider.name).toBe('yandex:yandexgpt-lite/latest');
  });

  it('без каталога отказывается собираться', () => {
    // Разбор конфигурации это уже не пропустит, но фабрика не должна
    // полагаться на то, что кто-то снаружи всё проверил.
    const broken = {
      ...envWith({}),
      AI_PROVIDER: 'yandex' as const,
      YANDEX_API_KEY: 'ключ',
    };

    expect(() => createLlmProvider(broken)).toThrow(/YANDEX_FOLDER_ID/u);
  });

  it('без ключа отказывается собираться', () => {
    const broken = {
      ...envWith({}),
      AI_PROVIDER: 'yandex' as const,
      YANDEX_FOLDER_ID: 'каталог',
    };

    expect(() => createLlmProvider(broken)).toThrow(/YANDEX_API_KEY/u);
  });
});

describe('проверки конфигурации', () => {
  it('яндексу нужны и ключ, и каталог', () => {
    expect(() => envWith({ AI_PROVIDER: 'yandex' })).toThrow(/YANDEX_API_KEY/u);
    expect(() => envWith({ AI_PROVIDER: 'yandex', YANDEX_API_KEY: 'к' })).toThrow(
      /YANDEX_FOLDER_ID/u,
    );
  });

  it('в боевом окружении заглушка модели запрещена', () => {
    // Иначе бот отвечал бы на выдуманный разбор и молчал об этом.
    expect(() =>
      envWith({
        NODE_ENV: 'production',
        SPEECH_PROVIDER: 'yandex',
        YANDEX_API_KEY: 'к',
        YANDEX_FOLDER_ID: 'кат',
        AI_PROVIDER: 'mock',
      }),
    ).toThrow(/заглушка языковой модели/u);
  });

  it('ключ и каталог общие для речи и языковой модели', () => {
    // Один сервисный аккаунт с двумя областями действия. Две пары
    // переменных однажды разошлись бы.
    const env = envWith({
      SPEECH_PROVIDER: 'yandex',
      AI_PROVIDER: 'yandex',
      YANDEX_API_KEY: 'ключ',
      YANDEX_FOLDER_ID: 'каталог',
    });

    expect(env.SPEECH_PROVIDER).toBe('yandex');
    expect(env.AI_PROVIDER).toBe('yandex');
  });
});
