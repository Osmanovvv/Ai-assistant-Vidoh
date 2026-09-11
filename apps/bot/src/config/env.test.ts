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
  OFFER_URL: 'https://vydoh.test/oferta',
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

describe('адрес оферты', () => {
  it('без переменной берётся заглушка — выкладка на боевом .env без неё не падает', () => {
    expect(parseWith({ OFFER_URL: undefined }).OFFER_URL).toBe('https://example.invalid/oferta');
  });

  it('должен быть по https', () => {
    expect(() => parseWith({ OFFER_URL: 'http://vydoh.test/oferta' })).toThrow(EnvValidationError);
  });

  it('заглушка в бою ловится тем же предупреждением, что у политики', () => {
    const warnings = productionWarnings(
      parseWith({
        ACCOUNT_SPEND_DAILY_RUB: '300',
        LOG_FILE: '/app/logs/vydoh.log',
        OFFER_URL: undefined,
      }),
    );

    expect(warnings).toContain('OFFER_URL указывает на заглушку из .env.example');
  });
});

describe('productionWarnings', () => {
  /**
   * **Три случая ниже переписаны 06.09.2026 (задача 3.79).**
   *
   * Они сверяли **точный состав** предупреждений, и добавление нового
   * их уронило — правильно уронило: список этот и должен требовать
   * объяснения на каждую новую строку.
   *
   * Появилось предупреждение про незаданный потолок расхода. Коренная
   * причина аварии 05.09.2026 — «никто не заметил», а потолок выключен
   * по умолчанию; значит о его отсутствии надо говорить при каждом
   * старте, иначе защита существует только в чьей-то памяти.
   *
   * Поэтому в настройке «всё хорошо» теперь задан и потолок.
   *
   * 10.09.2026 к ним добавился журнал в файл — по тому же доводу: без
   * `LOG_FILE` журнал живёт только в `docker logs`, а тот стирается
   * каждой выкладкой, и разбирать вчерашнее нечем.
   */
  const healthy = { ACCOUNT_SPEND_DAILY_RUB: '300', LOG_FILE: '/app/logs/vydoh.log' };

  it('молчит на настоящих адресах и при заданном потолке', () => {
    expect(productionWarnings(parseWith(healthy))).toEqual([]);
  });

  it('ловит заглушку из .env.example в публичном адресе', () => {
    const env = parseWith({ ...healthy, PUBLIC_URL: 'https://example.invalid' });

    expect(productionWarnings(env)).toContain('PUBLIC_URL указывает на заглушку из .env.example');
  });

  it('ловит заглушку в адресе политики', () => {
    const env = parseWith({
      ...healthy,
      PRIVACY_POLICY_URL: 'https://example.invalid/privacy',
    });

    expect(productionWarnings(env)).toHaveLength(1);
  });

  it('сообщает про обе заглушки сразу', () => {
    const env = parseWith({
      ...healthy,
      PUBLIC_URL: 'https://example.invalid',
      PRIVACY_POLICY_URL: 'https://example.invalid/privacy',
    });

    expect(productionWarnings(env)).toHaveLength(2);
  });

  it('говорит, что потолка расхода нет вовсе', () => {
    /**
     * Ради этого предупреждение и добавлено: «выключен по умолчанию» —
     * правильная гарантия неухудшения, но если о выключенном страже
     * никто не скажет, повторение 05.09.2026 пройдёт ровно так же.
     */
    const warnings = productionWarnings(parseEnv(valid));

    expect(warnings.some((one) => one.includes('потолок расхода не задан'))).toBe(true);
  });

  it('одного из двух потолков достаточно, чтобы не ругаться', () => {
    // Суточный и общий — независимые: задан любой, присмотр есть.
    expect(
      productionWarnings(
        parseWith({ ACCOUNT_SPEND_CEILING_RUB: '3000', LOG_FILE: '/app/logs/vydoh.log' }),
      ),
    ).toEqual([]);
  });

  it('ловит нарушение паритета: Робокасса есть, звёзд нет', () => {
    /**
     * Не «неполная настройка», а нарушение с названной санкцией: бота
     * делают недоступным из магазинных версий Telegram либо отключают
     * от платёжной платформы. Выключить звёзды «на минутку» слишком
     * легко, поэтому проверка не глазами.
     */
    const env = parseWith({
      ...healthy,
      RK_MERCHANT_LOGIN: 'vydoh',
      RK_PASSWORD1: 'п1',
      RK_PASSWORD2: 'п2',
      STARS: 'off',
    });

    expect(productionWarnings(env).some((one) => one.includes('паритета'))).toBe(true);
  });

  it('без Робокассы выключенные звёзды нарушением не считаются', () => {
    // Паритет — про «продаётся снаружи, а за звёзды нет». Нет ни того,
    // ни другого — нечему и нарушаться.
    const env = parseWith({ ...healthy, STARS: 'off' });

    expect(productionWarnings(env)).toEqual([]);
  });

  it('ловит тестовый режим Робокассы в бою', () => {
    // Оплата проходит, а денег нет: со стороны человека «я заплатил»,
    // со стороны учёта тишина.
    const env = parseWith({
      ...healthy,
      RK_MERCHANT_LOGIN: 'vydoh',
      RK_PASSWORD1: 'п1',
      RK_PASSWORD2: 'п2',
      RK_IS_TEST: 'on',
    });

    expect(productionWarnings(env).some((one) => one.includes('тестовом режиме'))).toBe(true);
  });

  it('«false» строкой не включает выключатели', () => {
    /**
     * `coerce.boolean` превращает «false» в true, и выключатель,
     * который не выключается, — худший вид выключателя. Проверка на
     * оба новых: паритет и тестовый режим.
     */
    expect(() => parseWith({ STARS: 'false' })).toThrow(EnvValidationError);
    expect(() => parseWith({ RK_IS_TEST: 'false' })).toThrow(EnvValidationError);
    expect(() => parseWith({ RK_RECURRING: 'false' })).toThrow(EnvValidationError);
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

/**
 * Запись ответов модели (задача 3.80).
 *
 * Половина проверок — про запрет: запись в бою коварнее заглушки. Она
 * отвечает **правдоподобно** — ответы настоящие, просто чужие и
 * вчерашние, — и человек получил бы разбор чужой выгрузки, ничего не
 * заподозрив.
 */
describe('запись ответов модели', () => {
  it('без файла записи не настраивается', () => {
    // Воспроизводить нечего, а тихо работать в этом состоянии нельзя.
    expect(() => parseWith({ AI_PROVIDER: 'cassette' })).toThrow(/CASSETTE_PATH/u);
  });

  it('воспроизведение живого ключа не требует', () => {
    // Весь смысл: прогон без сети и без чужого счёта.
    const env = parseWith({
      AI_PROVIDER: 'cassette',
      CASSETTE_PATH: 'src/e2e/cassettes/stage3.json',
    });

    expect(env.AI_PROVIDER).toBe('cassette');
    expect(env.CASSETTE_MODE).toBe('replay');
  });

  it('для записи ключ обязателен: она спрашивает живую модель', () => {
    expect(() =>
      parseWith({
        AI_PROVIDER: 'cassette',
        CASSETTE_PATH: 'src/e2e/cassettes/stage3.json',
        CASSETTE_MODE: 'record',
      }),
    ).toThrow(/YANDEX_API_KEY/u);
  });

  it('в боевом окружении запрещена', () => {
    /**
     * Ровно та же защита, что у заглушки модели, и по той же причине:
     * бот отвечал бы на выдуманный — точнее, на чужой — разбор.
     */
    expect(() =>
      parseWith({
        NODE_ENV: 'production',
        AI_PROVIDER: 'cassette',
        CASSETTE_PATH: 'src/e2e/cassettes/stage3.json',
        SPEECH_PROVIDER: 'yandex',
        YANDEX_API_KEY: 'ключ',
        YANDEX_FOLDER_ID: 'каталог',
      }),
    ).toThrow(/запись ответов модели недопустима в боевом окружении/u);
  });
});
