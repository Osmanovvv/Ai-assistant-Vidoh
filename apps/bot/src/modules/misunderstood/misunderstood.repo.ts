import { and, count, desc, eq, gte } from 'drizzle-orm';

import { misunderstood, users } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { FallbackKind } from '../../texts/rules.js';

/**
 * Журнал непонятого (заказчица, 16.09.2026, панель п. 3 и п. 4).
 *
 * Пишется конвейером в момент отправки реплики сдачи — см.
 * `FALLBACK_REPLIES` в словаре и `tell` в обработчике выгрузки. Два вида
 * строк: `meaning` (не понял формулировку, не нашёл) читает обзор —
 * плитка «Не поняла» и список по клику; `system` (сбой: распознавание,
 * вектор, модель) читает вкладка «Ошибки». Смешивать их нельзя — её
 * слово.
 */

export interface MisunderstoodToRecord {
  readonly userId: string;
  readonly batchId?: string | undefined;
  /** Что человек написал или наговорил — целиком. */
  readonly said: string;
  /** Что ответил бот — дословно. */
  readonly replied: string;
  /** Путь реплики сдачи в словаре; при сбое — с причиной через двоеточие. */
  readonly reason: string;
  readonly kind: FallbackKind;
}

export async function recordMisunderstood(
  db: Executor,
  params: MisunderstoodToRecord,
): Promise<void> {
  await db.insert(misunderstood).values({
    userId: params.userId,
    batchId: params.batchId ?? null,
    said: params.said,
    replied: params.replied,
    reason: params.reason,
    kind: params.kind,
  });
}

/** Сколько раз бот сдался с момента `since` — строк выбранного вида. */
export async function misunderstoodCount(
  db: Executor,
  since: Date,
  kind: FallbackKind,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(misunderstood)
    .where(and(gte(misunderstood.createdAt, since), eq(misunderstood.kind, kind)));

  return row?.total ?? 0;
}

export interface MisunderstoodRow {
  readonly at: Date;
  /** Имя человека, как в списке людей; без имени — телеграмное. */
  readonly who: string;
  readonly userId: string;
  readonly said: string;
  readonly replied: string;
  readonly reason: string;
  readonly kind: FallbackKind;
}

/** Список за период, свежее сверху. Предел — чтобы страница не росла без края. */
export async function misunderstoodList(
  db: Executor,
  params: { readonly days: number; readonly kind?: FallbackKind; readonly limit?: number },
): Promise<MisunderstoodRow[]> {
  const since = new Date(Date.now() - params.days * 24 * 3_600_000);

  const rows = await db
    .select({
      at: misunderstood.createdAt,
      firstName: users.firstName,
      username: users.username,
      userId: misunderstood.userId,
      said: misunderstood.said,
      replied: misunderstood.replied,
      reason: misunderstood.reason,
      kind: misunderstood.kind,
    })
    .from(misunderstood)
    .innerJoin(users, eq(users.id, misunderstood.userId))
    .where(
      and(
        gte(misunderstood.createdAt, since),
        params.kind === undefined ? undefined : eq(misunderstood.kind, params.kind),
      ),
    )
    .orderBy(desc(misunderstood.createdAt))
    .limit(params.limit ?? 200);

  return rows.map((row) => ({
    at: row.at,
    who: row.firstName ?? row.username ?? '—',
    userId: row.userId,
    said: row.said,
    replied: row.replied,
    reason: row.reason,
    kind: row.kind === 'system' ? 'system' : 'meaning',
  }));
}
