/**
 * Короткие идентификаторы для `callback_data` (задача 2.18).
 *
 * Telegram отводит на `callback_data` 64 байта. UUID в текстовом виде
 * занимает 36 из них, и вместе с действием и версией схемы лимит
 * пробивается быстро — а обнаруживается это тогда, когда клавиатур уже
 * десяток. План прямо называет это классической причиной переделки всех
 * клавиатур на середине проекта, поэтому короткие идентификаторы с самого
 * начала.
 *
 * **Не отдельная колонка, а другая запись того же значения.** UUID — это
 * шестнадцать байт; в base64url они укладываются в двадцать два знака
 * вместо тридцати шести. Ни новой колонки, ни таблицы соответствий, ни
 * состояния, которое может разъехаться: преобразование обратимо и
 * проверяется round-trip.
 *
 * **Идентификатор не заменяет проверку прав.** Он короткий, а не
 * секретный: `callback_data` приходит снаружи, и подделать его можно.
 * Каждый обработчик обязан сверять, что запись принадлежит нажавшему, —
 * иначе чужая запись правится по подобранному коду.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CODE_RE = /^[A-Za-z0-9_-]{22}$/u;

/** UUID → двадцать два знака. */
export function toShortId(uuid: string): string {
  if (!UUID_RE.test(uuid)) {
    throw new Error(`«${uuid}» не похож на UUID`);
  }

  const hex = uuid.replace(/-/gu, '');
  return Buffer.from(hex, 'hex').toString('base64url');
}

/**
 * Обратно в UUID. Возвращает `undefined` на мусоре, а не бросает:
 * значение приходит из нажатия, то есть снаружи, и странный код здесь
 * ожидаемое событие, а не поломка.
 */
export function fromShortId(code: string): string | undefined {
  if (!CODE_RE.test(code)) return undefined;

  const bytes = Buffer.from(code, 'base64url');
  if (bytes.length !== 16) return undefined;

  const hex = bytes.toString('hex');
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');

  return UUID_RE.test(uuid) ? uuid : undefined;
}

/**
 * Предел Telegram на `callback_data`. Держится здесь, чтобы проверка
 * длины всех клавиатур проекта ссылалась на одно число.
 */
export const CALLBACK_DATA_LIMIT = 64;

export function callbackDataSize(data: string): number {
  return Buffer.byteLength(data, 'utf8');
}
