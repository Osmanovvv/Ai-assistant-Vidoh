import { desc } from 'drizzle-orm';

import { textOverrides } from '../db/schema.js';
import type { Executor } from '../infra/db.js';
import { applyOverrides } from './index.js';

/**
 * Реплики из базы поверх реплик из кода (§13.9, задача 4.13).
 *
 * §13.9 требует менять тексты **без выкладки новой версии**. Словарь
 * отдельный был с задачи 2.11, а правился только выкладкой; здесь
 * появляется второй источник — таблица, которую правит панель.
 *
 * **Почему снимок в памяти, а не запрос на каждое обращение.** Реплики
 * берутся десятками раз за одну выгрузку и из мест, где `await` взять
 * негде: `textsFor` синхронна, и план обещал, что «вызовы менять не
 * придётся». Значит переопределения читаются целиком, редко и в фоне, а
 * `textsFor` продолжает отдавать готовый объект.
 *
 * **Цена названа: правка видна не мгновенно, а в течение окна.** Панель
 * поэтому просит перечитать сразу после сохранения — тогда «без
 * выкладки» означает «сразу», а не «через минуту». Окно остаётся
 * страховкой на случай второго процесса и на случай правки рукой в базе.
 */

/** Как часто перечитывать переопределения, если никто не попросил. */
const DEFAULT_EVERY_MS = 60_000;

export interface TextsDeps {
  readonly db: Executor;
  readonly logger?: {
    readonly info: (payload: unknown, message: string) => void;
    readonly error: (payload: unknown, message: string) => void;
  };
  readonly everyMs?: number | undefined;
}

export class TextsRegistry {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: TextsDeps) {}

  /**
   * Перечитать переопределения и применить их к словарю.
   *
   * Возвращает, сколько реплик переопределено, — панели это нужно, чтобы
   * сказать «правка применена», а не молчать в ответ на сохранение.
   *
   * **Отказ базы не оставляет бота без слов.** Тогда действуют реплики
   * из кода: они всегда на месте и всегда проходят §13. Промолчать в
   * ответ человеку было бы хуже, чем сказать прежними словами, — а
   * тишина в этом месте и есть худший из отказов.
   */
  async refresh(): Promise<number> {
    try {
      const rows = await this.deps.db
        .select({ path: textOverrides.path, value: textOverrides.value })
        .from(textOverrides)
        .orderBy(desc(textOverrides.updatedAt));

      applyOverrides(new Map(rows.map((row) => [row.path, row.value])));

      return rows.length;
    } catch (error: unknown) {
      this.deps.logger?.error(
        { err: error },
        'Не удалось прочитать правки реплик, бот говорит словами из кода',
      );

      return -1;
    }
  }

  /** Читать в фоне: страховка на второй процесс и на правку рукой. */
  start(): void {
    if (this.timer !== undefined) return;

    this.timer = setInterval(() => {
      void this.refresh();
    }, this.deps.everyMs ?? DEFAULT_EVERY_MS);

    // Таймер не должен держать процесс: иначе бот не остановится по
    // сигналу, и выкладка будет ждать его минуту на каждом перезапуске.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === undefined) return;

    clearInterval(this.timer);
    this.timer = undefined;
  }
}
