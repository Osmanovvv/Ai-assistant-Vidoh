import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

/**
 * Распределённая блокировка на Redis (задача 1.11).
 *
 * §9.1 ТЗ: обработка внутри одного пользователя строго последовательна.
 * Разбиение очереди по ключу — платная возможность BullMQ Pro, поэтому
 * порядок обеспечивается блокировкой: воркер берёт задание, захватывает
 * замок пользователя и не отпускает до конца работы.
 *
 * Замок живёт ограниченное время и продлевается, пока работа идёт. Так
 * упавший воркер не замораживает пользователя навсегда: замок протухнет
 * сам, и следующий воркер подхватит работу.
 */

/** Снять замок можно только своим токеном: иначе чужой воркер снимет наш. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

export interface LockHandle {
  readonly key: string;
  readonly token: string;
}

export interface WithLockOptions {
  readonly ttlMs?: number;
  /** Как часто продлевать замок во время работы. По умолчанию треть TTL. */
  readonly renewIntervalMs?: number;
}

const DEFAULT_TTL_MS = 30_000;

/**
 * Почему замок перестал быть нашим.
 *
 * Поводы разные, и правда у них разная. `renew-denied`: ключа с нашим
 * токеном в Redis нет — замок точно чужой или протух. `renew-failed`: до
 * Redis не достучались, наш ли ещё замок — неизвестно. `release-denied`:
 * снимать было нечего, замок ушёл раньше первого продления.
 */
export type LockLostReason = 'renew-denied' | 'renew-failed' | 'release-denied';

export interface LockLost {
  /** Имя замка без приставки: в бою это `user:<id>`. */
  readonly name: string;
  readonly reason: LockLostReason;
  readonly error?: unknown;
}

/**
 * Кому рассказать о потерянном замке.
 *
 * Прежде `renew` возвращал `false` в пустоту, и работа дорабатывала без
 * замка: §9.1 — строгая последовательность внутри одного человека —
 * переставал держаться **молча**. Цена известна: досмотр возвращает
 * выгрузку в очередь, второй воркер разбирает её заново, человек
 * получает ответ дважды, а модель оплачена дважды. В журнале при этом не
 * было ни строки, и связать жалобу с причиной было нечем.
 *
 * Обратный вызов, а не логгер: своего pino у `infra` нет, а решать, куда
 * это идёт — в журнал, в мониторинг или в оба, — дело запуска.
 */
export type LockLostHandler = (event: LockLost) => void;

export class RedisLock {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'lock:',
    /** Без него класс ведёт себя как прежде: молча. */
    private readonly onLost?: LockLostHandler,
  ) {}

  async acquire(name: string, ttlMs: number = DEFAULT_TTL_MS): Promise<LockHandle | null> {
    const key = this.prefix + name;
    const token = randomUUID();

    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? { key, token } : null;
  }

  async renew(handle: LockHandle, ttlMs: number = DEFAULT_TTL_MS): Promise<boolean> {
    const result = await this.redis.eval(RENEW_SCRIPT, 1, handle.key, handle.token, String(ttlMs));
    return result === 1;
  }

  async release(handle: LockHandle): Promise<boolean> {
    const result = await this.redis.eval(RELEASE_SCRIPT, 1, handle.key, handle.token);
    return result === 1;
  }

  /**
   * Выполняет работу под замком. Если замок занят — возвращает
   * { acquired: false } и не ждёт: очередь поставит задание заново.
   */
  async withLock<T>(
    name: string,
    fn: () => Promise<T>,
    options: WithLockOptions = {},
  ): Promise<{ acquired: false } | { acquired: true; result: T }> {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const renewIntervalMs = options.renewIntervalMs ?? Math.max(1_000, Math.floor(ttlMs / 3));

    const handle = await this.acquire(name, ttlMs);
    if (!handle) {
      return { acquired: false };
    }

    /**
     * О каждом поводе — ровно один раз за заход.
     *
     * Продление идёт каждые несколько секунд, а потерянный замок обратно
     * нашим не становится: без отметки один отказ дал бы строку на каждый
     * удар сердца до конца разбора, и громкость превратилась бы в шум.
     *
     * **Отметка на повод, а не одна на всех.** Общая глушила бы настоящую
     * потерю после случайной сетевой заминки: Redis моргнул на десятой
     * секунде долгого разбора, связь вернулась, замок цел — а на
     * семидесятой его отобрали по-настоящему, и об этом уже никто не
     * сказал бы. Ровно тот класс отказа, который тут и чинится.
     */
    const told = new Set<LockLostReason>();
    const tellLost = (reason: LockLostReason, error?: unknown): void => {
      if (told.has(reason)) return;
      told.add(reason);
      this.onLost?.(error === undefined ? { name, reason } : { name, reason, error });
    };

    // Продление на случай долгой работы: расшифровка длинного голосового
    // может занять больше TTL, и замок не должен протухнуть под нами.
    const heartbeat = setInterval(() => {
      void this.renew(handle, ttlMs).then(
        (renewed) => {
          if (renewed) return;

          /**
           * Ключа с нашим токеном больше нет. Продлевать нечего — удары
           * сердца прекращаются, но работа дорабатывает: бросить разбор
           * посреди значит потерять слова человека (§17), а замок этого
           * не стоит. Зато теперь об этом знают.
           */
          clearInterval(heartbeat);
          tellLost('renew-denied');
        },
        (error: unknown) => {
          // До Redis не достучались: наш ли ещё замок — неизвестно.
          // Удары сердца продолжаются, связь может вернуться раньше, чем
          // истечёт срок.
          tellLost('renew-failed', error);
        },
      );
    }, renewIntervalMs);
    heartbeat.unref();

    try {
      return { acquired: true, result: await fn() };
    } finally {
      clearInterval(heartbeat);

      // Снять было нечего — тот же отказ, замеченный на выходе: короткая
      // работа не успевает даже до первого продления, и без этой проверки
      // такая потеря не видна вообще ничем.
      if (!(await this.release(handle))) tellLost('release-denied');
    }
  }
}
