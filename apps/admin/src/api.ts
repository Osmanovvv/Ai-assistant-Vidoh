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

/** Деньги: микро-единицы валюты. Складывать разные валюты нельзя. */
export interface Money {
  readonly currency: 'rub' | 'usd';
  readonly micros: number;
}

export interface CostRow {
  readonly key: string;
  readonly calls: number;
  readonly failed: number;
  readonly money: readonly Money[];
  readonly unknownPrices: number;
}

export interface UserCostRow extends CostRow {
  readonly title: string;
  readonly tgId: number | null;
}

export interface Costs {
  readonly days: number;
  readonly byStage: readonly CostRow[];
  readonly byModel: readonly CostRow[];
  readonly byUser: readonly UserCostRow[];
  readonly userCount: number;
  readonly unattributed: readonly Money[];
  readonly perDump: readonly Money[];
  readonly perUser: readonly Money[];
  readonly dumps: number;
  readonly calls: number;
  /** Ложь означает, что суммы — нижняя граница: часть цен неизвестна. */
  readonly complete: boolean;
}

/** Расход в разрезах за последние `days` дней (§21 п.14). */
export function costs(days: number): Promise<Costs> {
  return call<Costs>(`/costs?days=${String(days)}`);
}

// ── Обзор, люди, карточка (§15, задача 4.6) ──────────────────────────

export interface Overview {
  readonly days: number;
  readonly activeUsers: number;
  readonly totalUsers: number;
  readonly newUsers: number;
  readonly dumps: number;
  readonly spend: readonly Money[];
  /** Чего в обзоре ещё нет и почему — словами, а не пустыми колонками. */
  readonly missing: readonly string[];
}

export interface PersonRow {
  readonly id: string;
  readonly tgId: number;
  readonly title: string;
  readonly username: string | null;
  readonly source: string | null;
  readonly registeredAt: string;
  readonly lastActiveAt: string | null;
  readonly dumps: number;
  readonly trialSpent: number;
  readonly spend: readonly Money[];
  readonly blocked: boolean;
}

export interface PeoplePage {
  readonly rows: readonly PersonRow[];
  readonly total: number;
}

export interface CardDump {
  readonly id: string;
  readonly openedAt: string;
  readonly status: string;
  readonly said: string | null;
  readonly trialCounted: boolean;
  readonly error: string | null;
  readonly results: readonly {
    readonly id: string;
    readonly text: string;
    readonly type: string;
    readonly topic: string | null;
    readonly isDraft: boolean;
    readonly draftReason: string | null;
  }[];
  readonly prompts: readonly { readonly stage: string; readonly version: string | null }[];
}

export interface PersonCard {
  readonly person: PersonRow;
  readonly dumps: readonly CardDump[];
  readonly changes: readonly {
    readonly id: string;
    readonly at: string;
    readonly changedBy: string;
    readonly reason: string | null;
    readonly reverted: boolean;
    readonly itemText: string | null;
  }[];
  readonly questions: readonly {
    readonly id: string;
    readonly at: string;
    readonly segment: string;
    readonly outcome: string | null;
    readonly resolvedAt: string | null;
  }[];
}

export function overview(days: number): Promise<Overview> {
  return call<Overview>(`/overview?days=${String(days)}`);
}

export function peoplePage(params: {
  readonly limit: number;
  readonly offset: number;
  readonly query?: string;
}): Promise<PeoplePage> {
  const search = params.query === undefined ? '' : `&q=${encodeURIComponent(params.query)}`;

  return call<PeoplePage>(
    `/people?limit=${String(params.limit)}&offset=${String(params.offset)}${search}`,
  );
}

export function personCard(userId: string): Promise<PersonCard> {
  return call<PersonCard>(`/people/${encodeURIComponent(userId)}`);
}

/** Кто вошёл. Отказ означает, что пропуска нет. */
export function whoAmI(): Promise<{ login: string }> {
  return call<{ login: string }>('/me');
}
