import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

import { hashPassword } from '../http/admin/password.js';
import { encodeBase32 } from '../http/admin/totp.js';

/**
 * Настройки входа в админ-панель (§15 ТЗ, задача 4.5).
 *
 * Панель нельзя настроить без этой команды: в `.env` идёт **хэш**
 * пароля, а не пароль, и его надо чем-то посчитать. Считать в уме или
 * подбирать формат руками — верный способ получить панель, которая не
 * пускает хозяина и не говорит почему.
 *
 * Печатает четыре строки для `.env` и подсказку, как завести код.
 *
 * **Пароль спрашивается у человека, а не берётся аргументом.** Аргумент
 * командной строки виден в истории оболочки и в списке процессов —
 * то есть пароль от панели, где лежат чужие выгрузки, остался бы в
 * `~/.bash_history` навсегда.
 *
 * Запуск:
 *   npm run admin:secrets --workspace @vydoh/bot
 */

const MIN_LENGTH = 12;

const reader = createInterface({ input: process.stdin, output: process.stdout });

const login = (await reader.question('Логин: ')).trim();

if (login === '') {
  process.stderr.write(`Логин не может быть пустым${String.fromCharCode(10)}`);
  reader.close();
  process.exit(2);
}

const password = (
  await reader.question(`Пароль (не короче ${String(MIN_LENGTH)} знаков): `)
).trim();

if (password.length < MIN_LENGTH) {
  /**
   * Короткий пароль отсекается здесь, а не в панели.
   *
   * Панель проверяет, сходится ли пароль, и не вправе судить о его
   * длине: правило про длину относится к тому, кто пароль **задаёт**.
   * А задаётся он ровно здесь и один раз.
   */
  process.stderr.write(
    `Слишком короткий пароль. Панель показывает содержимое чужих выгрузок — ` +
      `восьми знаков для неё мало.${String.fromCharCode(10)}`,
  );
  reader.close();
  process.exit(2);
}

const repeat = (await reader.question('Пароль ещё раз: ')).trim();
reader.close();

if (repeat !== password) {
  // Опечатка в пароле означала бы панель, в которую нельзя войти, и
  // причину этого искали бы в коде.
  process.stderr.write(`Пароли не совпали${String.fromCharCode(10)}`);
  process.exit(2);
}

const hash = await hashPassword(password);

/**
 * Секрет одноразовых кодов — двадцать случайных байт в base32.
 *
 * Двадцать, потому что столько берёт HMAC-SHA1 в RFC 6238, и столько же
 * ждут приложения-аутентификаторы. Base32 без заполнителя: приложения
 * читают его именно так.
 */
const totp = encodeBase32(randomBytes(20));

const sessionSecret = randomBytes(32).toString('base64url');
const NL = String.fromCharCode(10);

process.stdout.write(
  [
    '',
    '── Впишите в .env на сервере ────────────────────────────────',
    `ADMIN_LOGIN=${login}`,
    `ADMIN_PASSWORD_HASH=${hash}`,
    `ADMIN_TOTP_SECRET=${totp}`,
    `ADMIN_SESSION_SECRET=${sessionSecret}`,
    '',
    '── Второй шаг входа ─────────────────────────────────────────',
    'Откройте приложение-аутентификатор (Google Authenticator, Aegis,',
    '1Password — любое) и добавьте ключ вручную:',
    '',
    `  ключ:      ${totp}`,
    '  тип:       по времени (TOTP)',
    '  знаков:    6',
    '  интервал:  30 секунд',
    '',
    'Или строкой для QR-кода:',
    `  otpauth://totp/${encodeURIComponent(`ВЫДОХ:${login}`)}?secret=${totp}&issuer=%D0%92%D0%AB%D0%94%D0%9E%D0%A5&digits=6&period=30`,
    '',
    'Секрет кодов больше нигде не хранится в открытом виде: перенесите его',
    'в приложение сейчас и не оставляйте эту распечатку в переписке.',
    '',
  ].join(NL) + NL,
);
