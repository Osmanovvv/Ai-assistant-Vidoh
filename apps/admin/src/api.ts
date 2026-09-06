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

// ── Настройки (§15, задача 4.9) ──────────────────────────────────────

export interface SettingRow {
  readonly name: string;
  readonly key: string;
  readonly value: number;
  readonly fallback: number;
  /** Значение получено замером: правка вслепую ломает проверенное. */
  readonly measured: boolean;
  /** Задано в базе или работает умолчание из кода. */
  readonly set: boolean;
}

export interface SettingsPage {
  readonly rows: readonly SettingRow[];
  /** Чего §15 просит, а здесь пока нет — словами. */
  readonly missing: readonly string[];
}

export function settings(): Promise<SettingsPage> {
  return call<SettingsPage>('/settings');
}

export function putSetting(name: string, value: string): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>('/settings', { name, value });
}

/** Кто вошёл. Отказ означает, что пропуска нет. */
export function whoAmI(): Promise<{ login: string }> {
  return call<{ login: string }>('/me');
}

// ── Промпты (§15, задача 4.8) ────────────────────────────────────────

export interface PromptRow {
  readonly stage: string;
  readonly version: string;
  readonly isActive: boolean;
  readonly note: string | null;
  readonly schemaName: string;
  /** Длина текста: список показывает размер, но не сам промпт. */
  readonly length: number;
  readonly createdAt: string;
}

export type Freshness =
  | { readonly ok: true; readonly runs: readonly string[]; readonly unmeasured: readonly string[] }
  | { readonly ok: false; readonly reasons: readonly string[]; readonly runs: readonly string[] };

export type EvalRun =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly startedAt: string;
      readonly measuring?: { readonly stage: string; readonly version: string } | undefined;
    }
  | {
      readonly kind: 'finished';
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly ok: boolean;
      readonly tail: string;
      readonly measuring?: { readonly stage: string; readonly version: string } | undefined;
    };

export interface PromptsPage {
  readonly versions: readonly PromptRow[];
  /** Прогнан ли набор на том, что включено сейчас. */
  readonly freshness: Freshness;
  readonly run: EvalRun;
}

export function prompts(): Promise<PromptsPage> {
  return call<PromptsPage>('/prompts');
}

/** Текст версии — отдельным запросом: он самое ценное, что есть. */
export function promptText(
  stage: string,
  version: string,
): Promise<{ readonly prompt: string; readonly schemaName: string }> {
  return call(
    `/prompts/text?stage=${encodeURIComponent(stage)}&version=${encodeURIComponent(version)}`,
  );
}

export function createHotfix(params: {
  readonly stage: string;
  readonly basedOn: string;
  readonly prompt: string;
}): Promise<{ readonly ok: boolean; readonly version: string }> {
  return post('/prompts/hotfix', params);
}

/**
 * Отказ включить непрогнанную версию (§10.3).
 *
 * Отдельным типом, а не строкой: у отказа есть причины, и показать их
 * человеку — половина смысла заслона. «Не получилось» без объяснения
 * заставляет искать обход, а не прогонять набор.
 */
export class NotMeasured extends Error {
  constructor(readonly reasons: readonly string[]) {
    super('Набор на этой версии не прогнан');
    this.name = 'NotMeasured';
  }
}

export async function activatePrompt(params: {
  readonly stage: string;
  readonly version: string;
  readonly acknowledged?: boolean;
}): Promise<{ readonly ok: boolean }> {
  const response = await fetch(`${ROOT}/prompts/activate`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (response.status === 401) throw new NotSignedIn();

  if (response.status === 409) {
    const body = (await response.json()) as { readonly reasons?: readonly string[] };
    throw new NotMeasured(body.reasons ?? []);
  }

  if (!response.ok) throw new Error(`Панель ответила ${String(response.status)}`);

  return (await response.json()) as { readonly ok: boolean };
}

/** Прогнать набор на конкретной версии. Стоит денег — отсюда и вопрос. */
export function runEval(params: {
  readonly stage: string;
  readonly version: string;
}): Promise<{ readonly started: boolean; readonly run: EvalRun }> {
  return post('/prompts/run-eval', params);
}
