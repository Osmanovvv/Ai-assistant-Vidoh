import type { Alert } from '../../infra/monitoring.js';
import type { FallbackKind } from '../../texts/rules.js';

/**
 * Суточная сводка непонятого в чат мониторинга (22.09.2026).
 *
 * Журнал непонятого завели 16.09.2026 по просьбе заказчицы, и смотреть
 * его надо было руками — то есть никто не смотрел: про «Напиши мне все,
 * что накопилось» (её экран, 21.09) я узнал скриншотом на следующий
 * день. Сводка раз в сутки делает журнал тем, чем он задуман: разбором
 * в тот же день, а не по жалобе.
 *
 * Слова человека в сводку идут как есть — это чат мониторинга, он
 * закрытый, и без слов разбирать нечего. Строк не больше восьми:
 * остальное в панели, а сводка должна читаться с телефона.
 */
export interface DigestRow {
  readonly at: Date;
  readonly who: string;
  readonly said: string;
  readonly replied: string;
  readonly reason: string;
  readonly kind: FallbackKind;
}

const MAX_LINES = 8;
const MAX_SAID = 90;

function short(text: string): string {
  const one = text.replace(/\s+/gu, ' ').trim();
  return one.length > MAX_SAID ? `${one.slice(0, MAX_SAID)}…` : one;
}

export function misunderstoodDigest(rows: readonly DigestRow[]): Alert | undefined {
  if (rows.length === 0) return undefined;

  const system = rows.filter((row) => row.kind === 'system').length;
  const meaning = rows.length - system;

  const details: Record<string, string> = {};
  for (const [index, row] of rows.slice(0, MAX_LINES).entries()) {
    const said = row.said.trim() === '' ? '(без слов)' : short(row.said);
    details[`${String(index + 1)}. ${row.who}`] = `«${said}» → ${row.reason}`;
  }
  if (rows.length > MAX_LINES) {
    details['и ещё'] = `${String(rows.length - MAX_LINES)} — смотреть в панели, «Ошибки»`;
  }

  return {
    key: 'misunderstood_daily',
    title:
      `За сутки бот не понял ${String(rows.length)} ${plural(rows.length)}` +
      (system > 0 ? ` (из них сбоев: ${String(system)}, непонятых слов: ${String(meaning)})` : ''),
    details,
  };
}

function plural(count: number): string {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return 'раз';
  if (last === 1) return 'раз';
  if (last >= 2 && last <= 4) return 'раза';
  return 'раз';
}

/** Раз в сутки: журнал за прошедшие сутки — в чат мониторинга. */
const EVERY_MS = 24 * 60 * 60_000;

export interface DigestWatchParams {
  readonly list: () => Promise<readonly DigestRow[]>;
  readonly alert: (alert: Alert) => Promise<boolean>;
  readonly logger?: { warn: (context: object, message: string) => void } | undefined;
  readonly everyMs?: number | undefined;
}

export interface DigestWatchHandle {
  /** Один проход: нужен проверке и первому запуску. */
  readonly check: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

export function startMisunderstoodDigest(params: DigestWatchParams): DigestWatchHandle {
  const inFlight = new Set<Promise<void>>();
  const pass = async (): Promise<void> => {
    try {
      const digest = misunderstoodDigest(await params.list());
      if (digest === undefined) return;
      await params.alert(digest);
    } catch (error) {
      // Сводка — удобство разбора: её отказ не должен ронять бота.
      params.logger?.warn({ err: error }, 'Сводка непонятого не ушла');
    }
  };

  const check = (): Promise<void> => {
    const pending = pass();
    inFlight.add(pending);
    void pending.then(
      () => inFlight.delete(pending),
      () => inFlight.delete(pending),
    );
    return pending;
  };

  const timer = setInterval(() => void check(), params.everyMs ?? EVERY_MS);
  timer.unref();

  return {
    check,
    stop: async () => {
      clearInterval(timer);
      await Promise.allSettled([...inFlight]);
    },
  };
}
