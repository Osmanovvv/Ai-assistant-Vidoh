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
  /** Своя пауза до повтора — у баланса сутки; нет — общая пауза монитора. */
  readonly cooldownMs?: number | undefined;
}

export interface AlertSink {
  deliver(alert: Alert): Promise<void>;
}

/**
 * Память дребезга вне процесса (бой 25.09.2026): «баланс ниже порога»
 * пришёл в 03:47 и снова в 03:51 — выкладка перезапустила бота, а память
 * «уже оповестили» жила в процессе. Хранится в Redis ровно паузу.
 */
export interface AlertMemory {
  /** Когда ушло последнее оповещение с этим ключом; не было — undefined. */
  last(key: string): Promise<number | undefined>;
  remember(key: string, at: number, ttlMs: number): Promise<void>;
  forget(key: string): Promise<void>;
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
  /** Память дребезга, переживающая перезапуск; нет — только в процессе. */
  readonly memory?: AlertMemory | undefined;
  /** Куда сказать, что память недоступна: оповещение от этого не глохнет. */
  readonly warn?: ((why: string) => void) | undefined;
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
    const cooldownMs = alert.cooldownMs ?? this.options.cooldownMs ?? DEFAULTS.cooldownMs;
    // Своя память — первой: она свежее; после перезапуска её нет — тогда
    // память вне процесса. Та недоступна — оповещаем: лучше повтор, чем
    // тишина об аварии.
    const last = this.lastAlertAt.get(alert.key) ?? (await this.remembered(alert.key));

    if (last !== undefined && now - last < cooldownMs) {
      return false;
    }

    this.lastAlertAt.set(alert.key, now);
    await this.quietly('запомнить', () =>
      this.options.memory?.remember(alert.key, now, cooldownMs),
    );
    await this.options.sink.deliver(alert);
    return true;
  }

  /** Забыть оповещение: следующее с этим ключом уйдёт сразу (баланс пополнили). */
  async forget(key: string): Promise<void> {
    this.lastAlertAt.delete(key);
    await this.quietly('забыть', () => this.options.memory?.forget(key));
  }

  private async remembered(key: string): Promise<number | undefined> {
    let last: number | undefined;
    await this.quietly('прочитать', async () => {
      last = await this.options.memory?.last(key);
    });
    return last;
  }

  private async quietly(what: string, run: () => Promise<unknown> | undefined): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.options.warn?.(
        `Память оповещений: не удалось ${what} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
