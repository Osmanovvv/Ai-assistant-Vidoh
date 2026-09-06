/**
 * Обращения панели к боту (§15 ТЗ, задача 4.5).
 *
 * Одним файлом, потому что у всех обращений есть общие обязанности:
 * печенье пропуска, разбор отказа и одинаковое поведение при 401.
 * Разложенные по компонентам, они разъехались бы на третьем разделе.
 *
 * **`credentials: 'same-origin'`** — печенье пропуска помечено
 * `SameSite=Strict`, и без этого браузер его не пришлёт даже на свой
 * адрес при некоторых настройках. Панель молча оказалась бы «всегда не
 * вошедшей», и искать причину пришлось бы в подписи пропуска.
 */

/** Корень раздела панели. Тот же и в разработке — Vite проксирует. */
const ROOT = '/admin/api';

/** Панель не пустила: пропуска нет или он больше не годится. */
export class NotSignedIn extends Error {
  constructor() {
    super('Панель не пустила');
    this.name = 'NotSignedIn';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ROOT}${path}`, {
    credentials: 'same-origin',
    ...init,
  });

  if (response.status === 401) throw new NotSignedIn();

  if (!response.ok) {
    throw new Error(`Панель ответила ${String(response.status)}`);
  }

  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Шаг первый. Панель ещё не открыта: дальше нужен код. */
export function signInWithPassword(login: string, password: string): Promise<{ next: string }> {
  return post<{ next: string }>('/auth/login', { login, password });
}

/** Шаг второй. После него панель открыта. */
export function signInWithCode(code: string): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>('/auth/code', { code });
}

export function signOut(): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>('/auth/logout', {});
}

/** Кто вошёл. Отказ означает, что пропуска нет. */
export function whoAmI(): Promise<{ login: string }> {
  return call<{ login: string }>('/me');
}
