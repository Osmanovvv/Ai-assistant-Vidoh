import type { Logger } from 'pino';

import type { Executor } from '../../infra/db.js';
import type { ModelPricing } from '../metering/pricing.js';
import type { SpendGuard } from '../metering/spend-guard.js';
import { embedText, setItemEmbedding } from './embedder.service.js';
import type { EmbeddingProvider } from './providers/types.js';

/**
 * Пересчёт вектора у существующей записи (задача 2.9).
 *
 * План обещает дословно: «Считается при создании записи **и при
 * изменении заголовка**» (`docs/03-plan-razrabotki.md:976`). Вторая
 * половина не работала вовсе: `setItemEmbedding` из боя не звал никто —
 * написана, покрыта тестами, недостижима. После правки «не к врачу, а к
 * стоматологу» смысловой источник кандидатов §7.2 продолжал искать
 * запись по словам, которых в ней уже нет.
 *
 * Отдельным местом, а не строкой в резолвере, потому что тем же путём
 * ходит ручной досчёт (`scripts/backfill-embeddings.ts`), а назначение
 * вектора — `'document'`, не `'query'` — обязано решаться один раз.
 * Перепутать их — это поиск, который не падает и не ругается, а тихо
 * возвращает случайное.
 */

/** Кому считать и на чьи деньги. Провайдера нет — пересчёт выключен. */
export interface ReembedDeps {
  readonly db: Executor;
  readonly provider?: EmbeddingProvider | undefined;
  /** Потолок расхода (задача 3.79): вектор — платный вызов, как модель. */
  readonly spendGuard?: SpendGuard | undefined;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * Сколько ждать вектор при пересчёте.
 *
 * Пять секунд, а не тридцать как у создания записи: пересчёт стоит на
 * пути ответа человеку. Правка уже применена и записана — «сохранить
 * раньше, чем думать», — а человек ждёт реплику «Поправила». Ждать её
 * полминуты ради того, чего человеку не видно вовсе, нельзя.
 */
export const REEMBED_TIMEOUT_MS = 5_000;

/**
 * Пересчитывает вектор записи. Возвращает, получилось ли.
 *
 * **Одна отправка, без повторов, и это не экономия на надёжности.**
 * Платит отправка, а не результат (память проекта: повтор распознавания
 * платил за тот же звук трижды). Три захода по пять секунд с паузами в
 * секунду и две — это восемнадцать секунд молчания бота на каждой
 * правке заголовка и тройная цена за один и тот же текст. Вектор при
 * этом — не слова человека: он восстановим ручным досчётом, а слова —
 * нет.
 *
 * **Отказ не роняет правку и не молчит.** Правка человека уже
 * сохранена; уронить ответ из-за индекса значило бы поменять местами
 * важное и служебное. Но и промолчать нельзя: запись с устаревшим
 * вектором ищется по словам, которых в ней больше нет, и заметить это
 * можно только по этой строке журнала.
 */
export async function reembedItem(
  deps: ReembedDeps,
  params: { readonly itemId: string; readonly text: string; readonly userId: string },
): Promise<boolean> {
  const { provider } = deps;

  if (provider === undefined) return false;
  if (params.text.trim().length === 0) return false;

  try {
    const vector = await embedText(
      {
        db: deps.db,
        provider,
        timeoutMs: REEMBED_TIMEOUT_MS,
        // Один заход: см. разбор выше.
        retry: { attempts: 1 },
        ...(deps.pricing === undefined ? {} : { pricing: deps.pricing }),
        ...(deps.spendGuard === undefined ? {} : { spendGuard: deps.spendGuard }),
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      },
      { text: params.text, purpose: 'document', userId: params.userId },
    );

    await setItemEmbedding(deps.db, params.itemId, vector);

    return true;
  } catch (error) {
    deps.logger?.warn(
      { err: error, itemId: params.itemId },
      'Вектор не пересчитан: запись останется в поиске по прежним словам',
    );

    return false;
  }
}
