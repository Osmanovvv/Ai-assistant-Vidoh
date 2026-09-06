import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Второй шаг входа — код из приложения-аутентификатора (§15 ТЗ, задача 4.5).
 *
 * **§15 требует «вход в два шага», но чем должен быть второй шаг — не
 * говорит.** Выбран одноразовый код по RFC 6238 (тот, что показывают
 * Google Authenticator, Aegis, 1Password и любой другой). Причины, по
 * которым не взяты остальные варианты:
 *
 *  - **Код в SMS** требует шлюза, договора и денег за каждое сообщение —
 *    ради входа одного человека раз в неделю.
 *  - **Код в Telegram самому владельцу** соблазнителен: бот у нас уже
 *    есть, лишних зависимостей ноль. Но Telegram в России с февраля
 *    2026 замедляют, а панель нужна именно тогда, когда что-то не
 *    работает. Вход в диагностический инструмент не должен зависеть от
 *    канала, который и диагностируют.
 *  - **Ссылка на почту** — та же зависимость от внешней доставки плюс
 *    почтовый ящик как новая поверхность.
 *
 * Код из приложения работает без сети вовсе, стоит нуля и не требует
 * ничьих услуг.
 *
 * **Алгоритм написан здесь, а не взят зависимостью, и это осознанно.**
 * RFC 6238 — это HMAC, деление по модулю и выбор четырёх байт: тридцать
 * строк, у которых есть **официальные проверочные векторы**. Они и
 * лежат в тестах. Такой код проверяется до последнего знака, а
 * зависимость ради тридцати строк — это ещё один пакет в цепочке
 * поставки того, что охраняет доступ к чужим выгрузкам.
 */

/** Длина кода. Шесть знаков — то, что показывают все приложения. */
const DIGITS = 6;

/** Шаг времени. Тридцать секунд — значение по умолчанию в RFC. */
export const STEP_SECONDS = 30;

/**
 * Сколько шагов в обе стороны принимается.
 *
 * Один. Часы на телефоне и на сервере расходятся, а человек ещё и
 * набирает код не мгновенно: без допуска вход срывался бы на каждом
 * втором коде у самой границы тридцатисекундного окна. Больше одного —
 * это уже продление жизни кода без нужды.
 */
const DRIFT_STEPS = 1;

/** Разбор секрета из base32 — в таком виде его дают приложения. */
export function decodeBase32(secret: string): Buffer | undefined {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = secret.replace(/=+$/u, '').replace(/\s+/gu, '').toUpperCase();

  if (cleaned === '') return undefined;

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index === -1) return undefined;

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

/**
 * Обратная сборка: байты в base32.
 *
 * Рядом с разбором нарочно — так они проверяются друг о друга
 * обратимостью, и никто не сможет поправить одну сторону, забыв
 * другую. Нужна ровно одному месту: команде, которая печатает секрет
 * для приложения-аутентификатора.
 *
 * Без заполнителя `=`: приложения читают секрет именно так.
 */
export function encodeBase32(raw: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31] ?? '';
    }
  }

  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31] ?? '';

  return out;
}

/** Код для заданного шага времени. */
export function codeAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  // Счётчик — 64-битное число, а `writeUInt32BE` пишет по 32: старшая
  // половина остаётся нулевой и станет ненулевой в 2106 году.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step % 2 ** 32, 4);

  const digest = createHmac('sha1', secret).update(counter).digest();

  // Смещение берётся из младших четырёх бит последнего байта — так
  // велит RFC, и именно поэтому код не привязан к началу дайджеста.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const slice =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(slice % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Сходится ли введённый код.
 *
 * Сравнение постоянного времени: по времени ответа код иначе подбирался
 * бы знак за знаком. Проверяются текущий шаг и по одному в обе стороны.
 */
export function codeMatches(params: {
  readonly secret: string;
  readonly code: string;
  readonly now?: Date | undefined;
}): boolean {
  const secret = decodeBase32(params.secret);
  if (secret === undefined || secret.length === 0) return false;

  const entered = params.code.replace(/\s+/gu, '');
  if (!new RegExp(`^\\d{${String(DIGITS)}}$`, 'u').test(entered)) return false;

  const seconds = Math.floor((params.now?.getTime() ?? Date.now()) / 1000);
  const step = Math.floor(seconds / STEP_SECONDS);

  let matched = false;

  for (let shift = -DRIFT_STEPS; shift <= DRIFT_STEPS; shift++) {
    const expected = Buffer.from(codeAt(secret, step + shift));
    const got = Buffer.from(entered);

    // Без досрочного выхода: иначе по времени ответа станет видно, на
    // каком из трёх шагов код сошёлся, — а это подсказка о часах.
    if (got.length === expected.length && timingSafeEqual(got, expected)) matched = true;
  }

  return matched;
}
