import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Подписанный пропуск в панель (§15 ТЗ, задача 4.5).
 *
 * Два вида, и разница между ними — вся суть двух шагов входа:
 *  - `firstStep` выдаётся, когда сошлись логин и пароль. Он **не даёт
 *    доступа ни к чему**: им можно только предъявить код второго шага.
 *  - `session` выдаётся после кода и открывает панель.
 *
 * **Вид записан внутри подписи.** Если бы вид жил рядом с подписью или
 * выводился из длины, пропуск первого шага можно было бы предъявить как
 * сессию — и «вход в два шага» превратился бы в один. Это главное
 * свойство, которое здесь проверяется тестом.
 *
 * **Без таблицы сессий, и это решение с названной ценой.** Пропуск
 * самодостаточен: сервер не хранит выданное, а проверяет подпись.
 * Плата — отозвать один пропуск нельзя, можно только сменить секрет
 * и тем разом закрыть все. Для панели с одним человеком это дешевле
 * таблицы, миграции и уборки просроченных строк; когда администраторов
 * станет несколько, здесь появится таблица, и менять придётся только
 * этот файл.
 */

export type PassKind = 'firstStep' | 'session';

/** Сколько живёт пропуск первого шага. Двух минут на код хватает. */
export const FIRST_STEP_TTL_MS = 2 * 60_000;

/** Сколько живёт сессия. Смена — это повторный вход с кодом. */
export const SESSION_TTL_MS = 12 * 60 * 60_000;

interface Payload {
  readonly kind: PassKind;
  readonly login: string;
  /** Время истечения, миллисекунды. */
  readonly exp: number;
  /**
   * Случайная метка пропуска — чтобы его можно было **погасить**.
   *
   * **Найдено ревизией четвёртого этапа.** Пропуск первого шага
   * подписан и живёт две минуты, а годных кодов у второго шага три
   * (предыдущее окно, нынешнее и следующее — так требует стандарт).
   * Предела попыток на сам пропуск не было: кто украл его из сетевого
   * журнала или получил, зная пароль, мог перебирать коды до истечения.
   * Задержка от подбора не защищает — она задерживает, а не запрещает.
   *
   * Метка даёт роутеру, чем считать промахи: пять неверных кодов — и
   * пропуск негоден, даже пока не истёк. Погасить его иначе нечем:
   * подписанный пропуск состояния не имеет.
   */
  readonly nonce: string;
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function issuePass(params: {
  readonly secret: string;
  readonly kind: PassKind;
  readonly login: string;
  readonly now?: Date | undefined;
}): string {
  const ttl = params.kind === 'session' ? SESSION_TTL_MS : FIRST_STEP_TTL_MS;
  const payload: Payload = {
    kind: params.kind,
    login: params.login,
    exp: (params.now?.getTime() ?? Date.now()) + ttl,
    // Метка нужна, чтобы роутер мог погасить пропуск после нескольких
    // неверных кодов: подписанный пропуск состояния не имеет.
    nonce: randomBytes(9).toString('base64url'),
  };

  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  return `${body}.${sign(params.secret, body)}`;
}

/**
 * Разбор пропуска. `undefined` означает «не годится», без объяснений.
 *
 * Одинаково на все случаи — испорченный, подделанный, просроченный,
 * чужого вида. Различать их в ответе значило бы подсказывать тому, кто
 * подбирает: «подпись верна, но истёк» — уже полезное знание.
 */
export function readPass(params: {
  readonly secret: string;
  readonly pass: string;
  readonly kind: PassKind;
  readonly now?: Date | undefined;
}): { readonly login: string; readonly nonce: string } | undefined {
  const parts = params.pass.split('.');
  if (parts.length !== 2) return undefined;

  const [body, signature] = parts;
  if (body === undefined || signature === undefined || body === '' || signature === '') {
    return undefined;
  }

  const expected = Buffer.from(sign(params.secret, body));
  const got = Buffer.from(signature);

  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return undefined;

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
  } catch {
    return undefined;
  }

  if (typeof payload.login !== 'string' || payload.login === '') return undefined;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return undefined;

  // Вид проверяется наравне с подписью: пропуск первого шага не должен
  // открывать панель, даже если подпись у него настоящая.
  if (payload.kind !== params.kind) return undefined;

  if (payload.exp <= (params.now?.getTime() ?? Date.now())) return undefined;

  /**
   * Пропуск без метки не годится вовсе.
   *
   * Так отсекаются пропуски, выданные до этой правки: гасить их нечем, а
   * жить им две минуты (сессии — двенадцать часов, и повторный вход
   * стоит одного кода).
   */
  if (typeof payload.nonce !== 'string' || payload.nonce === '') return undefined;

  return { login: payload.login, nonce: payload.nonce };
}
