/**
 * Мониторинг и оповещения (задача 1.21).
 *
 * §18 ТЗ: оповещение в Telegram при росте ошибок, недоступности модели
 * и падении сервиса.
 *
 * Логика вынесена в чистые классы без сети и таймеров реального времени:
 * «сработает ли оповещение» проверяется тестами, а не наблюдением.
 */

export interface Alert {
  /** Ключ дребезга: оповещения с одним ключом не повторяются подряд. */
  readonly key: string;
  readonly title: string;
  readonly details?: Record<string, string | number> | undefined;
}

export interface AlertSink {
  deliver(alert: Alert): Promise<void>;
}

/**
 * Скользящее окно ошибок.
 *
 * Считать долю, а не количество: десять ошибок на десять запросов — это
 * авария, десять на десять тысяч — обычный шум. Порог по количеству
 * срабатывал бы в обоих случаях одинаково.
 */
export class ErrorRateWindow {
  private readonly events: { at: number; failed: boolean }[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly minSamples = 10,
  ) {}

  record(failed: boolean, now: number): void {
    this.events.push({ at: now, failed });
    this.prune(now);
  }

  private prune(now: number): void {
    const threshold = now - this.windowMs;
    while (this.events.length > 0 && (this.events[0]?.at ?? 0) < threshold) {
      this.events.shift();
    }
  }

  /** Доля ошибок в окне или null, если наблюдений слишком мало. */
  rate(now: number): number | null {
    this.prune(now);
    if (this.events.length < this.minSamples) return null;

    const failed = this.events.filter((event) => event.failed).length;
    return failed / this.events.length;
  }

  get size(): number {
    return this.events.length;
  }
}

export interface MonitorOptions {
  readonly sink: AlertSink;
  /** Доля ошибок, выше которой шлём оповещение. */
  readonly errorRateThreshold?: number;
  readonly windowMs?: number;
  readonly minSamples?: number;
  /** Сколько молчать после оповещения с тем же ключом. */
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

const DEFAULTS = {
  errorRateThreshold: 0.3,
  windowMs: 5 * 60_000,
  minSamples: 10,
  cooldownMs: 15 * 60_000,
};

export class Monitor {
  private readonly window: ErrorRateWindow;
  private readonly lastAlertAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: MonitorOptions) {
    this.window = new ErrorRateWindow(
      options.windowMs ?? DEFAULTS.windowMs,
      options.minSamples ?? DEFAULTS.minSamples,
    );
    this.now = options.now ?? (() => Date.now());
  }

  /** Учитывает исход операции и при необходимости шлёт оповещение. */
  async recordOutcome(ok: boolean): Promise<void> {
    const now = this.now();
    this.window.record(!ok, now);

    const rate = this.window.rate(now);
    const threshold = this.options.errorRateThreshold ?? DEFAULTS.errorRateThreshold;
    if (rate === null || rate < threshold) return;

    await this.alert({
      key: 'error-rate',
      title: 'Выросла доля ошибок обработки',
      details: {
        доля: `${String(Math.round(rate * 100))}%`,
        наблюдений: this.window.size,
        порог: `${String(Math.round(threshold * 100))}%`,
      },
    });
  }

  /**
   * Отправляет оповещение с учётом дребезга. Возвращает false, если
   * промолчали: без этого одна авария породит сотню сообщений.
   */
  async alert(alert: Alert): Promise<boolean> {
    const now = this.now();
    const cooldownMs = this.options.cooldownMs ?? DEFAULTS.cooldownMs;
    const last = this.lastAlertAt.get(alert.key);

    if (last !== undefined && now - last < cooldownMs) {
      return false;
    }

    this.lastAlertAt.set(alert.key, now);
    await this.options.sink.deliver(alert);
    return true;
  }
}

/** Человекочитаемый текст оповещения для чата эксплуатации. */
export function formatAlert(alert: Alert): string {
  const lines = [`⚠️ ${alert.title}`];

  for (const [key, value] of Object.entries(alert.details ?? {})) {
    lines.push(`${key}: ${String(value)}`);
  }

  return lines.join('\n');
}
