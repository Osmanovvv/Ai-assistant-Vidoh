import type { Logger } from 'pino';

import type { ChangedBy } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import { reembedIfRetitled } from '../embedder/reembed.js';
import type { EmbeddingProvider } from '../embedder/providers/types.js';
import type { ModelPricing } from '../metering/pricing.js';
import type { SpendGuard } from '../metering/spend-guard.js';
import { applyDecision, emptyChanges, type Applied } from '../resolver/patch.js';
import type { TopicGateway } from '../topics/gateway.js';
import { refreshSummaries } from '../topics/summary.service.js';
import { withCapital } from './item-text.js';

/**
 * Новое название по кнопке «Изменить» (заказчица, 30.09.2026).
 *
 * Её скрин: «Изменить» у «Купить молоко» — и голосом «Назови это
 * молочко». Название — «Молочко»: слова-команды в начале срезаются по
 * закрытому списку («назови», «переименуй в», «пусть будет», «поменяй
 * на», «название:»), вводные «ну», «давай» перед ними — тоже. «Назвать»
 * в списке нет: «Назвать сына Мишей» — само дело.
 */
const COMMAND = new RegExp(
  String.raw`^(?:(?:ну|давай|пожалуйста|так)\s*,?\s+)*` +
    String.raw`(?:(?:назови|переименуй)(?:\s+(?:это|его|её|ее|дело))?(?:\s+в)?|пусть\s+(?:будет|называется)|поменяй(?:\s+название)?\s+на|измени(?:\s+название)?\s+на|исправь(?:\s+название)?\s+на|название)` +
    String.raw`(?:\s*[:,—–-]\s*|\s+|$)`,
  'iu',
);

/** Новое название из сказанного; ничего не осталось — `undefined`, не выдумывать. */
export function newTitleFrom(spoken: string): string | undefined {
  const cut = spoken
    .trim()
    .replace(COMMAND, '')
    .replace(/^[«"„“'\s]+|[»"”'\s.!…]+$/gu, '')
    .trim();
  if (!/\p{L}/u.test(cut)) return undefined;
  return withCapital(cut);
}

/** Больше слов — это уже выгрузка, а не название. */
const MAX_TITLE_WORDS = 10;

/**
 * Голосовое похоже на название, а не на выгрузку: коротко и одной фразой.
 * Несколько мыслей («Назови это молочко. И ещё купить хлеб…») разбираются
 * как обычно — сказанное не должно пропасть в название.
 */
export function looksLikeNewTitle(spoken: string): boolean {
  const text = spoken.trim();
  const words = text.split(/\s+/u).filter((word) => /\p{L}/u.test(word));
  if (words.length === 0 || words.length > MAX_TITLE_WORDS) return false;
  // Конец предложения внутри — уже вторая мысль.
  return !/[.!?…]\s+\p{L}/u.test(text);
}

export interface RenameDeps {
  readonly db: Database;
  readonly logger?: Logger | undefined;
  /** Вектор заголовка после правки (A5). */
  readonly embedder?: EmbeddingProvider | undefined;
  readonly spendGuard?: SpendGuard | undefined;
  readonly pricing?: Readonly<Record<string, ModelPricing>> | undefined;
  /** Сводка ветки после правки (30.09.2026: в «Покупках» оставалось старое название). */
  readonly topics?: TopicGateway | undefined;
}

export type RenameOutcome =
  | { readonly kind: 'applied'; readonly applied: Applied }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unchanged' };

/**
 * Переписать название записи и всё, что за ним тянется: вектор и сводку
 * её ветки. Одна функция на текст и голос — иначе они разойдутся.
 */
export async function renameItem(
  deps: RenameDeps,
  params: {
    readonly userId: string;
    readonly itemId: string;
    readonly title: string;
    readonly spoken: string;
    readonly timeZone: string;
    readonly textProfile: string | null;
    readonly chatId?: number | undefined;
    /** Почему и кто — в историю правок; по умолчанию правка человека из карточки. */
    readonly reason?: string | undefined;
    readonly changedBy?: ChangedBy | undefined;
  },
): Promise<RenameOutcome> {
  const { db } = deps;
  const outcome = await applyDecision(db, {
    userId: params.userId,
    itemId: params.itemId,
    action: 'update',
    mode: 'replace',
    // Меняется один заголовок; остальные поля пустые, как их присылает
    // резолвер, когда правит только текст.
    changes: { ...emptyChanges(), text: params.title },
    spoken: params.spoken,
    timeZone: params.timeZone,
    reason: params.reason ?? 'правка словами из карточки',
    changedBy: params.changedBy ?? 'user',
  });

  if (outcome.kind !== 'applied') return { kind: outcome.kind === 'gone' ? 'gone' : 'unchanged' };

  const { applied } = outcome;

  await reembedIfRetitled(
    {
      db,
      ...(deps.embedder === undefined ? {} : { provider: deps.embedder }),
      ...(deps.spendGuard === undefined ? {} : { spendGuard: deps.spendGuard }),
      ...(deps.pricing === undefined ? {} : { pricing: deps.pricing }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    },
    applied,
  );

  /**
   * Сводка ветки — сразу (её скрин 30.09.2026: переименовала «Купить
   * молоко» в «Молочка», а в «Покупках» осталось старое). Кнопки
   * карточки сводку перечитывали, правка словами — нет. Сбой сводки
   * правку не отменяет: запись уже поправлена.
   */
  const topic = applied.after.topic;
  if (deps.topics !== undefined && params.chatId !== undefined && topic !== null) {
    try {
      await refreshSummaries(
        { db, gateway: deps.topics, ...(deps.logger === undefined ? {} : { logger: deps.logger }) },
        {
          userId: params.userId,
          chatId: params.chatId,
          topicNames: [topic],
          timeZone: params.timeZone,
          profile: params.textProfile,
        },
      );
    } catch (error) {
      deps.logger?.warn({ err: error }, 'Сводка ветки после правки названия не обновилась');
    }
  }

  return { kind: 'applied', applied };
}
