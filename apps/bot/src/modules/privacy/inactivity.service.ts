import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { messagesRaw, users } from '../../db/schema.js';
import type { QuestionSender } from '../presenter/telegram-sender.js';
import { textProfileOf } from '../users/settings.repo.js';
import { textsFor } from '../../texts/index.js';
import { eraseUser, type EraseDeps } from './erase.service.js';

/**
 * Удаление после тишины (решение заказчицы 12.09.2026, ответ 15;
 * Политика п. 11.2, Согласие п. 4.4).
 *
 * Сервис хранит записи, пока человек им пользуется, — память о сказанном
 * и есть услуга. Но 24 месяца без единого обращения — это не пауза, и
 * хранить дальше значило бы держать чужие мысли без цели (ч. 7 ст. 5
 * 152-ФЗ). Порядок обещан документами дословно: предупредить сообщением
 * в Сервисе, через 30 дней без обращения — удалить.
 *
 * Обращение — любое: сообщение или нажатие (`last_active_at`, как у
 * серии молчания в напоминаниях). Удаление — тем же путём, что
 * /delete_my_data: продления, база, ветки (`eraseUser`).
 */
export const INACTIVE_AFTER_MONTHS = 24;
export const DELETE_AFTER_WARNING_DAYS = 30;

export interface InactivityDeps extends EraseDeps {
  readonly sender: QuestionSender;
}

export interface RetireOutcome {
  /** Предупреждено — отправлено или попытка сделана. */
  readonly warned: number;
  readonly deleted: number;
  /** Обратился после предупреждения — отметка снята. */
  readonly spared: number;
}

/** Последняя активность любого рода: сообщение или нажатие. */
function lastActivity(): ReturnType<typeof sql<Date>> {
  return sql<Date>`greatest(
    ${users.lastActiveAt},
    coalesce((select max(${messagesRaw.receivedAt}) from ${messagesRaw} where ${messagesRaw.userId} = ${users.id}), ${users.lastActiveAt})
  )`;
}

function monthsBefore(now: Date, months: number): Date {
  const at = new Date(now);
  at.setUTCMonth(at.getUTCMonth() - months);
  return at;
}

export async function retireInactive(
  deps: InactivityDeps,
  params: { readonly now?: Date } = {},
): Promise<RetireOutcome> {
  const now = params.now ?? new Date();
  const { db, logger } = deps;
  const outcome = { warned: 0, deleted: 0, spared: 0 };

  // ── Предупреждение ──────────────────────────────────────────────────
  const silent = await db
    .select({ id: users.id, tgId: users.tgId, isBlocked: users.isBlocked })
    .from(users)
    .where(
      and(
        isNull(users.inactivityWarnedAt),
        lt(lastActivity(), monthsBefore(now, INACTIVE_AFTER_MONTHS)),
      ),
    );

  for (const person of silent) {
    /**
     * Заблокировавшему бота сообщение не доставить, и отправитель вернёт
     * ноль. Отметка ставится всё равно: срок от недоставки не
     * останавливается, иначе данные заблокировавших хранились бы вечно —
     * а политика обещает обратное. Порядок для них — у юриста, код делает
     * то, что написано: попытка и отметка.
     */
    const texts = textsFor(await textProfileOf(db, person.id));
    const messageId = person.isBlocked
      ? 0
      : await deps.sender.ask({
          chatId: person.tgId,
          text: texts.privacy.inactivityWarning,
          rows: [],
        });

    await db.update(users).set({ inactivityWarnedAt: now }).where(eq(users.id, person.id));
    outcome.warned += 1;

    if (messageId === 0) {
      logger.warn(
        { userId: person.id, blocked: person.isBlocked },
        'Предупреждение об удалении после тишины не доставлено; срок идёт',
      );
    } else {
      logger.info({ userId: person.id }, 'Предупреждение об удалении после тишины отправлено');
    }
  }

  // ── Удаление или помилование ────────────────────────────────────────
  const due = await db
    .select({
      id: users.id,
      tgId: users.tgId,
      warnedAt: users.inactivityWarnedAt,
      lastActivity: lastActivity(),
    })
    .from(users)
    .where(
      and(
        isNotNull(users.inactivityWarnedAt),
        lt(
          users.inactivityWarnedAt,
          new Date(now.getTime() - DELETE_AFTER_WARNING_DAYS * 24 * 60 * 60_000),
        ),
      ),
    );

  for (const person of due) {
    const warnedAt = person.warnedAt;
    if (warnedAt === null) continue;

    if (new Date(person.lastActivity).getTime() > warnedAt.getTime()) {
      // Обратился — значит, пользуется. Отсчёт начинается заново.
      await db.update(users).set({ inactivityWarnedAt: null }).where(eq(users.id, person.id));
      outcome.spared += 1;
      logger.info(
        { userId: person.id },
        'После предупреждения человек обратился — данные остаются',
      );
      continue;
    }

    await eraseUser(deps, {
      userId: person.id,
      tgId: person.tgId,
      chatId: person.tgId,
      why: 'после 24 месяцев тишины (Политика п. 11.2)',
    });
    outcome.deleted += 1;
  }

  return outcome;
}

/**
 * Проход раз в несколько часов. Чаще незачем: сроки здесь — месяцы и
 * дни. Первый проход — сразу, чтобы выкладка не откладывала обещанное.
 */
export function startInactivityLoop(
  deps: InactivityDeps,
  params: { readonly intervalMs?: number } = {},
): () => void {
  const intervalMs = params.intervalMs ?? 6 * 60 * 60_000;
  let inFlight: Promise<void> | null = null;

  const pass = (): void => {
    if (inFlight !== null) return;
    inFlight = retireInactive(deps)
      .then((outcome) => {
        if (outcome.warned > 0 || outcome.deleted > 0 || outcome.spared > 0) {
          deps.logger.info(outcome, 'Проход удаления после тишины');
        }
      })
      .catch((error: unknown) => {
        deps.logger.error({ err: error }, 'Проход удаления после тишины не удался');
      })
      .finally(() => {
        inFlight = null;
      });
  };

  pass();
  const timer = setInterval(pass, intervalMs);
  return () => {
    clearInterval(timer);
  };
}
