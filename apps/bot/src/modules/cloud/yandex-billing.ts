import { createSign } from 'node:crypto';

import type { Logger } from 'pino';
import { z } from 'zod';

import type { Alert } from '../../infra/monitoring.js';

/**
 * Баланс Yandex Cloud в панели (проджект, 21.09.2026: «сколько на
 * балансе щас»).
 *
 * **Зачем.** 05.09.2026 у облака кончились деньги, бот встал, и узнали
 * об этом из отказа. Потолки расхода (`account-spend.ts`) считают, что
 * **потратили**; сколько **осталось**, знает только облако. Панель
 * показывает остаток и порог; ниже порога — оповещение в чат
 * мониторинга, чтобы пополнить до остановки.
 *
 * **Как.** API-ключ, которым ходят модели, к биллингу не пускает: нужен
 * IAM-токен. Он получается обменом JWT, подписанного ключом сервисного
 * аккаунта (файл `authorized_key.json` от заказчицы, роль
 * `billing.accounts.viewer` на платёжном счёте). Токен живёт до
 * `expiresAt` (до 12 часов), баланс читается списком счетов — так
 * заказчице не надо искать идентификатор счёта.
 *
 * **Секреты.** Ключ читается из файла, не из `.env` (многострочный PEM
 * в `.env` ломается о Compose). Ни ключ, ни токен не попадают ни в
 * журнал, ни в текст ошибок: отказ облака описывается статусом.
 */

const IAM_TOKENS_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';
const BILLING_ACCOUNTS_URL = 'https://billing.api.cloud.yandex.net/billing/v1/billingAccounts';

/** JWT живёт недолго: он нужен только на обмен. */
const JWT_TTL_SECONDS = 10 * 60;
/** Токен считается истёкшим заранее, чтобы не поймать отказ на границе. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Столько баланс держится в памяти: чаще облако спрашивать незачем. */
const BALANCE_MAX_AGE_MS = 10 * 60_000;
/** Пока баланс ниже порога, напоминание повторяется раз в сутки. */
const REALERT_MS = 24 * 60 * 60_000;
/** Ключ дребезга предупреждения о балансе. */
const LOW_BALANCE_ALERT = 'yandex-balance-low';

const RSA_PKCS1_PSS_PADDING = 6;
const PSS_SALT_LENGTH = 32;

export interface ServiceAccountKey {
  readonly id: string;
  readonly serviceAccountId: string;
  /** PEM без строки-предупреждения, которой Yandex начинает файл. */
  readonly privateKey: string;
}

const keyFileSchema = z.object({
  id: z.string().min(1),
  service_account_id: z.string().min(1),
  private_key: z.string().min(1),
});

/** Читает файл ключа. Отказ называет файл, но не его содержимое. */
export function parseServiceAccountKey(text: string, source: string): ServiceAccountKey {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`файл ключа сервисного аккаунта ${source} не разбирается как JSON`);
  }

  const parsed = keyFileSchema.safeParse(payload);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`в файле ключа сервисного аккаунта ${source} не хватает полей: ${fields}`);
  }

  const pem = parsed.data.private_key.slice(parsed.data.private_key.indexOf('-----BEGIN'));
  if (!pem.startsWith('-----BEGIN')) {
    throw new Error(`в файле ключа сервисного аккаунта ${source} нет PEM-ключа`);
  }

  return {
    id: parsed.data.id,
    serviceAccountId: parsed.data.service_account_id,
    privateKey: pem,
  };
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** JWT для обмена на IAM-токен: PS256, как требует Yandex. */
export function signServiceAccountJwt(key: ServiceAccountKey, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'PS256', kid: key.id }));
  const payload = base64url(
    JSON.stringify({
      iss: key.serviceAccountId,
      aud: IAM_TOKENS_URL,
      iat: issuedAt,
      exp: issuedAt + JWT_TTL_SECONDS,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(
    { key: key.privateKey, padding: RSA_PKCS1_PSS_PADDING, saltLength: PSS_SALT_LENGTH },
    'base64url',
  );

  return `${header}.${payload}.${signature}`;
}

export interface BillingBalance {
  readonly accountId: string;
  readonly accountName: string;
  /** Рубли с копейками: облако отдаёт строку с семью знаками. */
  readonly balanceRub: number;
  readonly currency: string;
  readonly active: boolean;
}

const tokenSchema = z.object({ iamToken: z.string().min(1), expiresAt: z.string().min(1) });

const accountsSchema = z.object({
  billingAccounts: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().default(''),
        active: z.boolean().default(false),
        currency: z.string().default('RUB'),
        balance: z.string().default('0'),
      }),
    )
    .default([]),
});

export interface BillingClientDeps {
  readonly key: ServiceAccountKey;
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
}

export class YandexBillingClient {
  private token: { readonly value: string; readonly until: number } | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly deps: BillingClientDeps) {
    this.fetcher = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  private async iamToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.token !== undefined && this.token.until - TOKEN_MARGIN_MS > nowMs) {
      return this.token.value;
    }

    const response = await this.fetcher(IAM_TOKENS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jwt: signServiceAccountJwt(this.deps.key, this.now()) }),
    });
    if (!response.ok) {
      throw new Error(`обмен ключа на IAM-токен: облако ответило ${String(response.status)}`);
    }

    const parsed = tokenSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('обмен ключа на IAM-токен: ответ без токена');

    this.token = { value: parsed.data.iamToken, until: Date.parse(parsed.data.expiresAt) };
    return this.token.value;
  }

  /** Остаток на платёжном счёте. Счетов несколько — берётся активный. */
  async balance(): Promise<BillingBalance> {
    const token = await this.iamToken();
    const response = await this.fetcher(BILLING_ACCOUNTS_URL, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      // Токен мог отозваться: следующий запрос обменяет ключ заново.
      if (response.status === 401) this.token = undefined;
      throw new Error(`платёжные счета: облако ответило ${String(response.status)}`);
    }

    const parsed = accountsSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('платёжные счета: ответ не разбирается');

    const accounts = parsed.data.billingAccounts;
    const account = accounts.find((one) => one.active) ?? accounts[0];
    if (account === undefined) {
      throw new Error('у сервисного аккаунта не видно ни одного платёжного счёта');
    }

    return {
      accountId: account.id,
      accountName: account.name,
      balanceRub: Math.round(Number(account.balance) * 100) / 100,
      currency: account.currency,
      active: account.active,
    };
  }
}

export type BalanceStatus =
  | {
      readonly ok: true;
      readonly balanceRub: number;
      readonly currency: string;
      readonly accountName: string;
      readonly thresholdRub: number;
      /** Ниже порога. Порог ноль — сторож выключен, и «низко» не бывает. */
      readonly low: boolean;
      readonly fetchedAt: string;
      /** Облако не ответило, число — прошлое; причина — в `why`. */
      readonly stale: boolean;
      readonly why?: string | undefined;
    }
  | { readonly ok: false; readonly why: string; readonly thresholdRub: number };

export interface BalanceWatchDeps {
  readonly client: Pick<YandexBillingClient, 'balance'>;
  /** Порог в рублях — из настроек панели, читается на каждую проверку. */
  readonly thresholdRub: () => Promise<number>;
  /** Кто доставляет оповещение: `Monitor.alert` в бою. */
  readonly alert: (alert: Alert) => Promise<boolean>;
  /**
   * Стереть память о предупреждении, когда баланс снова выше порога:
   * `Monitor.forget` в бою. Память живёт вне процесса (бой 25.09.2026), и
   * без этого следующее падение ждало бы суток с прошлого.
   */
  readonly forget?: ((key: string) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly logger?: Logger | undefined;
}

function rubles(value: number): string {
  return `${value.toFixed(2)} ₽`;
}

/**
 * Сторож баланса: держит последнее известное число, спрашивает облако
 * не чаще раза в десять минут и оповещает, когда остаток ниже порога.
 */
export class YandexBalanceWatch {
  private known: { readonly balance: BillingBalance; readonly at: number } | undefined;
  private lastProblem: string | undefined;
  private alertedAt: number | undefined;
  private readonly now: () => Date;

  constructor(private readonly deps: BalanceWatchDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async refresh(): Promise<void> {
    const nowMs = this.now().getTime();
    if (this.known !== undefined && nowMs - this.known.at < BALANCE_MAX_AGE_MS) return;

    try {
      this.known = { balance: await this.deps.client.balance(), at: nowMs };
      this.lastProblem = undefined;
    } catch (error) {
      this.lastProblem = error instanceof Error ? error.message : String(error);
      this.deps.logger?.warn({ why: this.lastProblem }, 'Баланс Yandex Cloud не прочитался');
    }
  }

  async status(): Promise<BalanceStatus> {
    await this.refresh();
    const thresholdRub = await this.deps.thresholdRub();

    if (this.known === undefined) {
      return { ok: false, why: this.lastProblem ?? 'облако ещё не спрашивали', thresholdRub };
    }

    const { balance, at } = this.known;
    return {
      ok: true,
      balanceRub: balance.balanceRub,
      currency: balance.currency,
      accountName: balance.accountName,
      thresholdRub,
      low: thresholdRub > 0 && balance.balanceRub < thresholdRub,
      fetchedAt: new Date(at).toISOString(),
      stale: this.lastProblem !== undefined,
      ...(this.lastProblem === undefined ? {} : { why: this.lastProblem }),
    };
  }

  /** Периодическая проверка: ниже порога — оповещение, раз в сутки, пока низко. */
  async check(): Promise<void> {
    const status = await this.status();
    if (!status.ok) return;

    if (!status.low) {
      this.alertedAt = undefined;
      await this.deps.forget?.(LOW_BALANCE_ALERT);
      return;
    }

    const nowMs = this.now().getTime();
    if (this.alertedAt !== undefined && nowMs - this.alertedAt < REALERT_MS) return;

    this.alertedAt = nowMs;
    await this.deps.alert({
      key: LOW_BALANCE_ALERT,
      title: 'Yandex Cloud: баланс ниже порога — пора пополнить',
      details: { баланс: rubles(status.balanceRub), порог: `${String(status.thresholdRub)} ₽` },
      // Сутки и через перезапуск (бой 25.09.2026: повтор через четыре
      // минуты после выкладки) — паузу помнит мониторинг вне процесса.
      cooldownMs: REALERT_MS,
    });
  }
}
