import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import { appSettings } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Системные значения продукта, меняемые без выкладки (§14 и §15 ТЗ,
 * задача 4.3).
 *
 * §14 требует, чтобы размер пробного периода настраивался в админке без
 * выкладки новой версии, §15 — того же для цен, лимитов, окна ожидания
 * тишины, порогов резолвера, числа тем и частоты напоминаний. До этой
 * задачи механизма не было: числа живут в переменных окружения и
 * константами в коде, и то и другое меняется только выкладкой.
 *
 * **Значение по умолчанию живёт в коде, а не в таблице.** Пустая таблица
 * означает «работаем как работали», а не «бот не поднялся»: выкладка не
 * должна зависеть от того, успел ли кто-то заполнить настройки. И
 * наоборот — забытая строка в таблице не должна тихо менять поведение.
 *
 * **Мусор в значении не роняет бота, а откатывает к умолчанию.** Эту
 * таблицу правит человек из админки, и однажды в поле числа окажется
 * «десять» или пустая строка. Падать на этом нельзя: настройка правится
 * на живом продукте, и цена опечатки не должна равняться простою.
 * Поэтому непонятное значение — предупреждение в журнал и умолчание.
 */

/** Сколько держать значение в памяти, не перечитывая. */
const DEFAULT_TTL_MS = 60_000;

/**
 * Известные значения: имя в таблице и умолчание в коде.
 *
 * Перечнем, а не свободными строками: опечатка в имени ключа иначе
 * читалась бы как «настройки нет» и молча возвращала умолчание — самая
 * неприятная ошибка настроек, потому что выглядит как работающая.
 */
export const SETTINGS = {
  /**
   * Размер пробного периода — в **выгрузках**, а не в днях (§14).
   *
   * Десять — наше предложение, а не решение заказчицы: оно записано в
   * таблице значений разбора ТЗ и ждёт подтверждения. Код работает на
   * любом числе, включая ноль: ноль означает «пробного периода нет».
   */
  trialDumps: { key: 'trial.dumps', fallback: 10 },
} as const;

export type SettingName = keyof typeof SETTINGS;

interface Cached {
  readonly value: string | undefined;
  readonly until: number;
}

export interface SettingsDeps {
  readonly db: Executor;
  readonly ttlMs?: number | undefined;
  readonly logger?: Logger | undefined;
  /** Часы — для тестов кэша: без них истечение не проверить. */
  readonly now?: () => number;
}

/**
 * Читалка значений с кэшем.
 *
 * Кэш нужен потому, что размер пробного периода спрашивается на **каждом
 * входящем сообщении**: без него горячий путь получил бы лишний запрос в
 * базу на каждое слово человека. Минута задержки при правке из админки —
 * приемлемая цена; §14 просит «без выкладки», а не «мгновенно».
 */
export class SettingsRegistry {
  private readonly cache = new Map<string, Cached>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: SettingsDeps) {
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Целое неотрицательное значение. Непонятное — умолчание из кода. */
  async number(name: SettingName): Promise<number> {
    const setting = SETTINGS[name];
    const raw = await this.raw(setting.key);

    if (raw === undefined) return setting.fallback;

    const trimmed = raw.trim();

    /**
     * Только цифры — и это строже, чем `Number()`, нарочно.
     *
     * `Number('')` даёт ноль, `Number('10.5')` — дробь, `Number('-1')` —
     * отрицательное, а `Number('1e3')` — тысячу. Последнее и заставило
     * ужесточить правило: поле «сколько выгрузок даёт пробный период»
     * заполняет человек в админке, и «1e3» там куда вероятнее опечатка,
     * чем осознанная тысяча. Молча раздать тысячу разборов по опечатке —
     * дороже, чем откатиться к умолчанию и сказать об этом в журнал.
     *
     * Заодно правило становится объяснимым в одну фразу: цифры, и всё.
     */
    const parsed = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;

    if (!Number.isInteger(parsed)) {
      this.deps.logger?.warn(
        { key: setting.key, raw, fallback: setting.fallback },
        'Значение настройки не похоже на целое неотрицательное число, беру умолчание из кода',
      );

      return setting.fallback;
    }

    return parsed;
  }

  /** Сырое значение по ключу. `undefined` — строки нет. */
  private async raw(key: string): Promise<string | undefined> {
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.until > this.now()) return cached.value;

    const [row] = await this.deps.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);

    // Отсутствие строки кэшируется тоже: иначе до первой правки из
    // админки каждое сообщение человека стоило бы запроса в базу.
    this.cache.set(key, { value: row?.value, until: this.now() + this.ttlMs });

    return row?.value;
  }

  /** Забыть накопленное. Нужно правке из админки и тестам. */
  forget(): void {
    this.cache.clear();
  }
}

/**
 * Записать значение.
 *
 * Отдельной функцией, а не методом читалки: писать будет админка
 * (задача 4.9), а читает бот, и смешивать эти два права в одном объекте
 * значит однажды дать боту записать то, что он только что прочитал.
 *
 * `updatedBy` заполняется, когда у админки появится вход (4.11): §16
 * требует журналировать доступ к данным, а правку значения продукта —
 * тем более то, о чём потом спросят «кто это поменял».
 */
export async function putSetting(
  db: Executor,
  params: { readonly name: SettingName; readonly value: string; readonly by?: string | undefined },
): Promise<void> {
  const key = SETTINGS[params.name].key;

  await db
    .insert(appSettings)
    .values({ key, value: params.value, updatedBy: params.by ?? null })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: params.value, updatedAt: new Date(), updatedBy: params.by ?? null },
    });
}
