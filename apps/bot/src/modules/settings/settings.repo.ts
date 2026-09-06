import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import { appSettings } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { BufferLimits } from '../buffer/buffer.service.js';

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
 *
 * **`measured` означает «значение получено замером».** Такое нельзя
 * править вслепую: вред от правки видно только на контрольном наборе, а
 * он платный. Панель обязана предупредить об этом до того, как даст
 * поле для ввода, — иначе «настройка без выкладки» превращается в
 * способ молча уронить качество. Тот же принцип, что у задачи 4.8 с
 * непрогнанным набором.
 */
export const SETTINGS = {
  /**
   * Размер пробного периода — в **выгрузках**, а не в днях (§14).
   *
   * Десять — наше предложение, а не решение заказчицы: оно записано в
   * таблице значений разбора ТЗ и ждёт подтверждения. Код работает на
   * любом числе, включая ноль: ноль означает «пробного периода нет».
   */
  trialDumps: { key: 'trial.dumps', fallback: 10, measured: false },

  /**
   * Окно ожидания тишины, миллисекунды (§9.1, §15).
   *
   * Условие готовности задачи 4.9 названо именно про него: изменение из
   * админки применяется **без перезапуска**. Поэтому значение читается
   * в момент, когда нужно, а не запоминается при старте.
   */
  silenceWindowMs: { key: 'limits.silence_window_ms', fallback: 30_000, measured: true },

  /** Потолок выгрузок в сутки на человека (§10.5). */
  dumpsPerDay: { key: 'limits.dumps_per_day', fallback: 30, measured: false },

  /** Сколько тем бот заводит человеку (§8, §15). */
  maxTopics: { key: 'topics.max', fallback: 8, measured: false },

  /**
   * Пороги уверенности резолвера — в сотых долях (§7, §15).
   *
   * Целыми числами, а не дробями: настройки хранятся строкой и правятся
   * человеком, а «0.8» в поле ввода однажды окажется «0,8» и станет
   * непонятным значением. Восемьдесят — это 0,80.
   *
   * **Все три помечены измеренными**, и это важнее самой возможности их
   * менять: 0,35 у близости выполненного получен замером на десяти
   * живых парах 30.08.2026, и от него зависит §21 п.8. Правка вслепую
   * ломает то, что проверено, — панель обязана сказать это, прежде чем
   * даст поле для ввода.
   */
  resolverApply: { key: 'resolver.apply_pct', fallback: 80, measured: true },
  resolverCreate: { key: 'resolver.create_pct', fallback: 45, measured: true },
  resolverSimilarity: { key: 'resolver.similarity_pct', fallback: 50, measured: true },
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

  /**
   * Все известные значения разом — для страницы настроек.
   *
   * Отдаёт и текущее, и умолчание из кода, и признак «получено
   * замером»: панель обязана показать всё три, иначе человек правит
   * число, не зная ни откуда оно взялось, ни чем грозит правка.
   */
  async all(): Promise<
    readonly {
      readonly name: SettingName;
      readonly key: string;
      readonly value: number;
      readonly fallback: number;
      readonly measured: boolean;
      /** Задано ли значение в базе или работает умолчание из кода. */
      readonly set: boolean;
    }[]
  > {
    const names = Object.keys(SETTINGS) as SettingName[];
    const out: {
      name: SettingName;
      key: string;
      value: number;
      fallback: number;
      measured: boolean;
      set: boolean;
    }[] = [];

    for (const name of names) {
      const setting = SETTINGS[name];

      out.push({
        name,
        key: setting.key,
        value: await this.number(name),
        fallback: setting.fallback,
        measured: setting.measured,
        set: (await this.raw(setting.key)) !== undefined,
      });
    }

    return out;
  }
}

/**
 * Действующие ограничения буфера: из настроек, с умолчаниями из кода.
 *
 * **Читается в момент, когда нужно, а не запоминается при старте.**
 * Условие готовности задачи 4.9 названо именно про это: изменение окна
 * тишины из админки применяется без перезапуска сервиса. Значение,
 * прочитанное один раз при подъёме процесса, требовало бы перезапуска —
 * то есть выкладки, — а §15 просит обойтись без неё.
 *
 * Кэш реестра делает это дешёвым: на горячем пути один поход в память.
 */
export async function effectiveLimits(
  settings: SettingsRegistry | undefined,
  base: BufferLimits,
): Promise<BufferLimits> {
  if (settings === undefined) return base;

  return {
    ...base,
    silenceWindowMs: await settings.number('silenceWindowMs'),
    maxDumpsPerDay: await settings.number('dumpsPerDay'),
  };
}

/**
 * Пороги резолвера из настроек — в долях, как их ждёт решатель.
 *
 * Хранятся сотыми долями целым числом (см. `SETTINGS`), здесь делятся.
 * Возвращается частичный набор: остальные пороги остаются теми, что в
 * коде, и настраивать их §15 не просит.
 */
export async function effectiveThresholds(
  settings: SettingsRegistry | undefined,
): Promise<{ apply: number; create: number; similarity: number } | undefined> {
  if (settings === undefined) return undefined;

  return {
    apply: (await settings.number('resolverApply')) / 100,
    create: (await settings.number('resolverCreate')) / 100,
    similarity: (await settings.number('resolverSimilarity')) / 100,
  };
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
