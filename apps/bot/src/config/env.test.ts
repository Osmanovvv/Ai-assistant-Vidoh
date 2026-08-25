import { describe, expect, it } from 'vitest';

import {
  EnvValidationError,
  WEBHOOK_PATH,
  parseEnv,
  productionWarnings,
  webhookUrl,
} from './env.js';

/** Заведомо ненастоящий токен нужного формата: репозиторий публичный. */
const FAKE_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const valid: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_URL: 'https://bot.vydoh.test',
  PRIVACY_POLICY_URL: 'https://vydoh.test/privacy',
  BOT_TOKEN: FAKE_TOKEN,
  BOT_WEBHOOK_SECRET: 'a'.repeat(32),
  DATABASE_URL: 'postgres://vydoh:vydoh@localhost:5434/vydoh',
  REDIS_URL: 'redis://localhost:6379',
};

function parseWith(overrides: Record<string, string | undefined>) {
  return parseEnv({ ...valid, ...overrides });
}

describe('parseEnv', () => {
  it('разбирает корректную конфигурацию', () => {
    const env = parseEnv(valid);

    expect(env.NODE_ENV).toBe('test');
    expect(env.BOT_TOKEN).toBe(FAKE_TOKEN);
    expect(env.DATABASE_URL).toBe(valid['DATABASE_URL']);
  });

  it('проставляет значения по умолчанию для необязательных полей', () => {
    const env = parseEnv(valid);

    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.BOT_SET_WEBHOOK_ON_BOOT).toBe(true);
  });

  it('приводит PORT из строки к числу', () => {
    expect(parseWith({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('отвергает PORT вне диапазона портов', () => {
    expect(() => parseWith({ PORT: '70000' })).toThrow(EnvValidationError);
    expect(() => parseWith({ PORT: '0' })).toThrow(EnvValidationError);
  });

  describe('булевы значения', () => {
    it('строка «false» означает false, а не непустую строку', () => {
      expect(parseWith({ BOT_SET_WEBHOOK_ON_BOOT: 'false' }).BOT_SET_WEBHOOK_ON_BOOT).toBe(false);
      expect(parseWith({ BOT_SET_WEBHOOK_ON_BOOT: '0' }).BOT_SET_WEBHOOK_ON_BOOT).toBe(false);
    });

    it('строка «true» означает true', () => {
      expect(parseWith({ BOT_SET_WEBHOOK_ON_BOOT: 'true' }).BOT_SET_WEBHOOK_ON_BOOT).toBe(true);
      expect(parseWith({ BOT_SET_WEBHOOK_ON_BOOT: '1' }).BOT_SET_WEBHOOK_ON_BOOT).toBe(true);
    });

    it('отвергает значение, которое не является булевым', () => {
      expect(() => parseWith({ BOT_SET_WEBHOOK_ON_BOOT: 'yes' })).toThrow(EnvValidationError);
    });
  });

  describe('токен бота', () => {
    it('требует обязательного присутствия', () => {
      expect(() => parseWith({ BOT_TOKEN: undefined })).toThrow(EnvValidationError);
    });

    it('отвергает строку не в формате @BotFather', () => {
      expect(() => parseWith({ BOT_TOKEN: 'просто-строка' })).toThrow(EnvValidationError);
      expect(() => parseWith({ BOT_TOKEN: '123456789' })).toThrow(EnvValidationError);
    });
  });

  describe('секрет вебхука', () => {
    it('отвергает секрет короче 16 символов', () => {
      expect(() => parseWith({ BOT_WEBHOOK_SECRET: 'короткий' })).toThrow(EnvValidationError);
    });

    it('отвергает символы, недопустимые в заголовке Telegram', () => {
      expect(() => parseWith({ BOT_WEBHOOK_SECRET: `${'a'.repeat(20)}!` })).toThrow(
        EnvValidationError,
      );
      expect(() => parseWith({ BOT_WEBHOOK_SECRET: 'секретсекретсекрет' })).toThrow(
        EnvValidationError,
      );
    });

    it('принимает допустимый секрет', () => {
      const secret = `${'A1b2-_'.repeat(4)}xyz`;
      expect(parseWith({ BOT_WEBHOOK_SECRET: secret }).BOT_WEBHOOK_SECRET).toBe(secret);
    });
  });

  describe('публичный адрес', () => {
    it('отвергает http: Telegram принимает вебхук только по https', () => {
      expect(() => parseWith({ PUBLIC_URL: 'http://bot.vydoh.test' })).toThrow(EnvValidationError);
    });

    it('отвергает строку, которая не является адресом', () => {
      expect(() => parseWith({ PUBLIC_URL: 'bot.vydoh.test' })).toThrow(EnvValidationError);
    });
  });

  describe('адреса хранилищ', () => {
    it('отвергает DATABASE_URL с чужой схемой', () => {
      expect(() => parseWith({ DATABASE_URL: 'mysql://localhost/vydoh' })).toThrow(
        EnvValidationError,
      );
    });

    it('отвергает REDIS_URL с чужой схемой', () => {
      expect(() => parseWith({ REDIS_URL: 'http://localhost:6379' })).toThrow(EnvValidationError);
    });
  });

  it('сообщает обо всех проблемах сразу, а не только о первой', () => {
    let caught: unknown;
    try {
      parseEnv({});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvValidationError);
    const { issues } = caught as EnvValidationError;

    expect(issues.length).toBeGreaterThanOrEqual(5);
    expect(issues.some((i) => i.startsWith('BOT_TOKEN'))).toBe(true);
    expect(issues.some((i) => i.startsWith('DATABASE_URL'))).toBe(true);
  });

  it('в тексте ошибки перечислены названия полей', () => {
    expect(() => parseEnv({})).toThrow(/BOT_TOKEN/);
  });
});

describe('webhookUrl', () => {
  it('собирает адрес вебхука из публичного адреса', () => {
    const env = parseEnv(valid);
    expect(webhookUrl(env)).toBe(`https://bot.vydoh.test${WEBHOOK_PATH}`);
  });

  it('не задваивает слэш, если публичный адрес заканчивается на слэш', () => {
    const env = parseWith({ PUBLIC_URL: 'https://bot.vydoh.test/' });
    expect(webhookUrl(env)).toBe(`https://bot.vydoh.test${WEBHOOK_PATH}`);
  });
});

describe('адрес политики конфиденциальности', () => {
  it('обязателен: §16 ТЗ требует показывать согласие при первом запуске', () => {
    expect(() => parseWith({ PRIVACY_POLICY_URL: undefined })).toThrow(EnvValidationError);
  });

  it('должен быть по https', () => {
    expect(() => parseWith({ PRIVACY_POLICY_URL: 'http://vydoh.test/privacy' })).toThrow(
      EnvValidationError,
    );
  });
});

describe('productionWarnings', () => {
  it('молчит на настоящих адресах', () => {
    expect(productionWarnings(parseEnv(valid))).toEqual([]);
  });

  it('ловит заглушку из .env.example в публичном адресе', () => {
    const env = parseWith({ PUBLIC_URL: 'https://example.invalid' });

    expect(productionWarnings(env)).toContain('PUBLIC_URL указывает на заглушку из .env.example');
  });

  it('ловит заглушку в адресе политики', () => {
    const env = parseWith({ PRIVACY_POLICY_URL: 'https://example.invalid/privacy' });

    expect(productionWarnings(env)).toHaveLength(1);
  });

  it('сообщает про обе заглушки сразу', () => {
    const env = parseWith({
      PUBLIC_URL: 'https://example.invalid',
      PRIVACY_POLICY_URL: 'https://example.invalid/privacy',
    });

    expect(productionWarnings(env)).toHaveLength(2);
  });
});

describe('провайдер расшифровки', () => {
  it('по умолчанию заглушка: разработка не должна зависеть от чужого ключа', () => {
    expect(parseEnv(valid).SPEECH_PROVIDER).toBe('mock');
  });

  it('заглушке ключ не нужен', () => {
    expect(() => parseWith({ SPEECH_PROVIDER: 'mock' })).not.toThrow();
  });

  it('в боевом окружении заглушка запрещена', () => {
    // Иначе бот отвечал бы на выдуманные расшифровки и молчал об этом.
    expect(() => parseWith({ NODE_ENV: 'production', SPEECH_PROVIDER: 'mock' })).toThrow(
      /заглушка расшифровки/u,
    );
  });

  it('яндексу нужен ключ', () => {
    expect(() => parseWith({ SPEECH_PROVIDER: 'yandex' })).toThrow(/YANDEX_API_KEY/u);
  });

  it('с ключом яндекс проходит', () => {
    const env = parseWith({ SPEECH_PROVIDER: 'yandex', YANDEX_API_KEY: 'ключ' });

    expect(env.SPEECH_PROVIDER).toBe('yandex');
    expect(env.YANDEX_SPEECH_MODEL).toBe('general');
    expect(env.SPEECH_LANGUAGE).toBe('ru');
  });

  it('openai нужен свой ключ, а не яндексовый', () => {
    expect(() => parseWith({ SPEECH_PROVIDER: 'openai', YANDEX_API_KEY: 'ключ' })).toThrow(
      /OPENAI_API_KEY/u,
    );
  });

  it('незнакомый провайдер отвергается', () => {
    expect(() => parseWith({ SPEECH_PROVIDER: 'sber' })).toThrow(EnvValidationError);
  });

  it('в сообщении об ошибке видно имя недостающей переменной', () => {
    try {
      parseWith({ SPEECH_PROVIDER: 'yandex' });
      expect.unreachable('разбор должен был упасть');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues.join(' ')).toContain('YANDEX_API_KEY');
    }
  });
});
