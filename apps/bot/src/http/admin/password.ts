import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * scrypt промисом. Своей обёрткой, а не через `promisify`: тот выбирает
 * первый вариант подписи — без настроек, — и стоимость подбора задать
 * было бы нечем.
 */
function scrypt(
  password: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * Пароль администратора (§15 ТЗ, задача 4.5).
 *
 * **Хранится хэшем, а не паролем.** В `.env` на сервере лежит
 * `ADMIN_PASSWORD_HASH`; сам пароль не знает ни репозиторий, ни файл
 * настроек, ни журнал. Утечка файла настроек не должна давать входа в
 * панель, где видно содержимое чужих выгрузок (§16).
 *
 * **scrypt из стандартной библиотеки, а не своя схема и не зависимость.**
 * Node умеет scrypt сам, он с солью и с настраиваемой стоимостью —
 * то есть подбор по украденному хэшу стоит времени. Своя схема на
 * SHA-256 подбиралась бы на видеокарте за часы.
 *
 * **Сравнение постоянного времени.** Обычное `===` на строках выходит
 * раньше на первом несовпавшем байте, и по времени ответа хэш можно
 * подбирать побайтно. Здесь `timingSafeEqual`, и то же правило действует
 * для подписи сессии и для кода второго шага.
 */

/** Стоимость подбора. 2^17 — примерно 100 мс на проверку, и это норма. */
const COST = 2 ** 17;
const BLOCK_SIZE = 8;
const PARALLEL = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** Формат строки: `scrypt$N$r$p$соль$хэш`, соль и хэш в base64url. */
const PREFIX = 'scrypt';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLEL,
    maxmem: 256 * COST * BLOCK_SIZE,
  });

  return [
    PREFIX,
    String(COST),
    String(BLOCK_SIZE),
    String(PARALLEL),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Сходится ли пароль с хэшем.
 *
 * Любая невнятность — испорченная строка, чужой формат, битая база64 —
 * это «не сходится», а не отказ. Панель не должна открываться из-за
 * того, что настройку записали неправильно; и падать при попытке входа
 * она тоже не должна.
 */
export async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallel = Number(parts[3]);
  const salt = parts[4];
  const expected = parts[5];

  if (
    !Number.isInteger(cost) ||
    !Number.isInteger(blockSize) ||
    !Number.isInteger(parallel) ||
    cost < 2 ||
    blockSize < 1 ||
    parallel < 1 ||
    salt === undefined ||
    expected === undefined
  ) {
    return false;
  }

  let want: Buffer;
  try {
    want = Buffer.from(expected, 'base64url');
  } catch {
    return false;
  }

  if (want.length === 0) return false;

  let got: Buffer;
  try {
    got = await scrypt(password, Buffer.from(salt, 'base64url'), want.length, {
      N: cost,
      r: blockSize,
      p: parallel,
      // Стоимость памяти растёт вместе с N, и при большом N по умолчанию
      // scrypt отказывает «memory limit exceeded». Предел задаётся явно
      // и с запасом: иначе смена стоимости в настройке ломала бы вход.
      maxmem: 256 * cost * blockSize,
    });
  } catch {
    return false;
  }

  return got.length === want.length && timingSafeEqual(got, want);
}
