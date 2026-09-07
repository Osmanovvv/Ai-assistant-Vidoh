import { and, count, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';

import {
  batches,
  broadcastDeliveries,
  broadcasts,
  users,
  type Broadcast,
  type BroadcastDelivery,
} from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';

/**
 * Рассылка: кому, что и чем кончилось (§15 ТЗ, задача 4.10).
 *
 * **Список получателей закрепляется в момент подтверждения, а не
 * считается на ходу.** Иначе «рассылка на 1000 человек» означала бы
 * разное на разных минутах: кто-то зарегистрировался, кто-то
 * заблокировал бота. Предпросмотр показывал бы одно число, отчёт — другое,
 * и объяснить разницу было бы нечем.
 *
 * Заодно это делает повтор безопасным: перезапуск бота посреди рассылки
 * не рассылает заново, а берёт то, что осталось `pending`.
 */

export type BroadcastStatus = 'draft' | 'running' | 'stopped' | 'done' | 'failed';

/**
 * `sending` — строку взял воркер и вот-вот отправит.
 *
 * Взятие нужно потому, что защита от двойной отправки обязана стоять
 * **до** отправки, а не после. Отметка после отправки не спасает: два
 * воркера, взявшие одну порцию, оба уже написали человеку, и вторая
 * отметка лишь скрывает это от отчёта.
 *
 * Два воркера здесь не выдумка: очередь пускает одного, но задание, не
 * уложившееся в замок BullMQ, считается зависшим и запускается вторым.
 */
export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'skipped' | 'failed';

/**
 * Сколько держится взятая строка.
 *
 * Воркер, умерший между взятием и отправкой, оставил бы строку взятой
 * навсегда — то есть человека без письма, и молча. Через пять минут
 * строку берут снова. Цена — второе сообщение в узком случае «процесс
 * умер после отправки, но до отметки»; она заметно меньше, чем цена
 * потерянного человека или удвоенной рассылки на зависшем задании.
 */
export const LEASE_MS = 5 * 60_000;

/**
 * Сегменты (§15: «всем или сегменту»).
 *
 * Заведены только те, у которых есть однозначное определение в базе
 * **сегодня**. Сегмента «кто платит» здесь нет: оплаты ещё нет вовсе
 * (задачи 4.1 и 4.2), и такой сегмент дал бы пустой список или, хуже,
 * молча совпал бы с «всем».
 *
 * «Активные за неделю» напрашивается, но требует решения, что считать
 * активностью, — а рассылка не то место, где такое решение принимают
 * молча.
 *
 * Самый нужный из имеющихся — «у кого пробный период кончился»: именно
 * им пишут, когда оплата наконец открылась.
 */
export const SEGMENTS = {
  all: 'всем',
  trialLeft: 'у кого пробный период ещё не кончился',
  trialSpent: 'у кого пробный период кончился',
} as const;

export type Segment = keyof typeof SEGMENTS;

export function isSegment(value: unknown): value is Segment {
  return typeof value === 'string' && value in SEGMENTS;
}

/** Кому уйдёт: незаблокированные, попадающие в сегмент. */
export async function recipientsOf(
  db: Executor,
  params: { readonly segment: Segment; readonly trialLimit: number },
): Promise<readonly { readonly userId: string; readonly tgId: number }[]> {
  const rows = await db
    .select({ userId: users.id, tgId: users.tgId })
    .from(users)
    .where(
      and(
        /**
         * Заблокировавшие пропускаются **до** отправки, а не по 403.
         *
         * §15 требует пропускать их прямо. По 403 это тоже ловится (см.
         * `isBlockedError`), но каждый такой ответ — потраченный запрос
         * из общего лимита Telegram: на тысяче адресатов, где половина
         * заблокировала бота, рассылка шла бы вдвое дольше и вдвое
         * ближе к 429.
         */
        eq(users.isBlocked, false),
        segmentWhere(params),
      ),
    )
    .orderBy(users.createdAt, users.id);

  return rows;
}

/**
 * Условие сегмента.
 *
 * Пробный период считается **выгрузками, а не днями** (§14) — тем же
 * подсчётом, что `trialSpent`. Своё определение здесь разошлось бы с
 * тем, по которому человека действительно пускают или не пускают, и
 * рассылка «пробный кончился» ушла бы не тем людям.
 */
function segmentWhere(params: {
  readonly segment: Segment;
  readonly trialLimit: number;
}): ReturnType<typeof sql> | undefined {
  const spent = sql`(
    select count(*) from ${batches}
    where ${batches.userId} = ${users.id} and ${batches.trialCountedAt} is not null
  )`;

  switch (params.segment) {
    case 'all':
      return undefined;
    case 'trialLeft':
      return sql`${spent} < ${params.trialLimit}`;
    case 'trialSpent':
      return sql`${spent} >= ${params.trialLimit}`;
  }
}

/** Завести черновик и закрепить получателей. Ничего не отправляет. */
export async function createBroadcast(
  db: Executor,
  params: {
    readonly text: string;
    readonly segment: Segment;
    readonly by: string;
    readonly trialLimit: number;
  },
): Promise<{ readonly id: string; readonly recipients: number }> {
  const text = params.text.trim();
  if (text === '') throw new Error('Пустой текст рассылки');

  const [made] = await db
    .insert(broadcasts)
    .values({ text, segment: params.segment, createdBy: params.by })
    .returning({ id: broadcasts.id });

  if (made === undefined) throw new Error('Рассылка не создалась');

  const people = await recipientsOf(db, {
    segment: params.segment,
    trialLimit: params.trialLimit,
  });

  if (people.length > 0) {
    // Пачками: тысяча строк одним запросом упирается в предел числа
    // параметров, а десять запросов по сто — не упираются.
    for (let at = 0; at < people.length; at += 100) {
      await db.insert(broadcastDeliveries).values(
        people.slice(at, at + 100).map((one) => ({
          broadcastId: made.id,
          userId: one.userId,
          tgId: one.tgId,
        })),
      );
    }
  }

  return { id: made.id, recipients: people.length };
}

export async function broadcastById(db: Executor, id: string): Promise<Broadcast | undefined> {
  const [row] = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).limit(1);
  return row;
}

/**
 * Попросили ли остановиться. Одно поле, а не вся строка.
 *
 * Спрашивается перед каждой отправкой — тысячу раз за рассылку, — и
 * тащить ради этого текст сообщения было бы расточительно.
 */
export async function stopRequested(db: Executor, id: string): Promise<boolean> {
  const [row] = await db
    .select({ at: broadcasts.stopRequestedAt })
    .from(broadcasts)
    .where(eq(broadcasts.id, id))
    .limit(1);

  // Пропавшая рассылка — тоже повод встать: слать от имени того,
  // чего нет, нельзя.
  if (row === undefined) return true;

  return row.at !== null;
}

export interface BroadcastCounts {
  readonly pending: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly total: number;
}

export async function countsOf(db: Executor, id: string): Promise<BroadcastCounts> {
  const rows = await db
    .select({ status: broadcastDeliveries.status, howMany: count() })
    .from(broadcastDeliveries)
    .where(eq(broadcastDeliveries.broadcastId, id))
    .groupBy(broadcastDeliveries.status);

  const by = new Map(rows.map((row) => [row.status, row.howMany]));
  const pick = (status: DeliveryStatus): number => by.get(status) ?? 0;

  return {
    pending: pick('pending'),
    sent: pick('sent'),
    skipped: pick('skipped'),
    failed: pick('failed'),
    total: [...by.values()].reduce((sum, one) => sum + one, 0),
  };
}

/**
 * Взять следующую порцию неотправленных.
 *
 * Сюда попадают и строки, взятые кем-то давно: воркер мог умереть между
 * взятием и отправкой, и без этого человек остался бы без письма молча.
 *
 * Порядок по `id` — устойчивый: без него две порции могли бы пересечься
 * или пропустить строку, а «пропустить» здесь означает человека, который
 * не получил письма, и никто об этом не узнает.
 */
export async function nextPending(
  db: Executor,
  id: string,
  howMany: number,
  now = new Date(),
): Promise<readonly BroadcastDelivery[]> {
  const stale = new Date(now.getTime() - LEASE_MS);

  return await db
    .select()
    .from(broadcastDeliveries)
    .where(
      and(
        eq(broadcastDeliveries.broadcastId, id),
        or(
          eq(broadcastDeliveries.status, 'pending'),
          and(eq(broadcastDeliveries.status, 'sending'), lt(broadcastDeliveries.at, stale)),
        ),
      ),
    )
    .orderBy(broadcastDeliveries.id)
    .limit(howMany);
}

/**
 * Взять строку себе — **перед** отправкой.
 *
 * Ложь означает «её уже взял кто-то другой»: тогда отправлять нельзя, и
 * человек не получит второго сообщения. Это и есть защита от двойной
 * отправки; отметка после отправки её не заменяет.
 */
export async function claimDelivery(
  db: Executor,
  deliveryId: string,
  now = new Date(),
): Promise<boolean> {
  const stale = new Date(now.getTime() - LEASE_MS);

  const taken = await db
    .update(broadcastDeliveries)
    .set({ status: 'sending', at: now })
    .where(
      and(
        eq(broadcastDeliveries.id, deliveryId),
        or(
          eq(broadcastDeliveries.status, 'pending'),
          and(eq(broadcastDeliveries.status, 'sending'), lt(broadcastDeliveries.at, stale)),
        ),
      ),
    )
    .returning({ id: broadcastDeliveries.id });

  return taken.length > 0;
}

/** Вернуть строку в очередь: 429 — не вина получателя. */
export async function releaseDelivery(db: Executor, deliveryId: string): Promise<void> {
  await db
    .update(broadcastDeliveries)
    .set({ status: 'pending', at: null })
    .where(and(eq(broadcastDeliveries.id, deliveryId), eq(broadcastDeliveries.status, 'sending')))
    .returning({ id: broadcastDeliveries.id });
}

/**
 * Отметить исход отправки — у строки, которую этот воркер взял.
 *
 * Условие «строка взята» держит учёт честным: отметка от воркера,
 * потерявшего строку по истечении срока, не должна затирать исход того,
 * кто её перехватил.
 */
export async function markDelivery(
  db: Executor,
  deliveryId: string,
  outcome: { readonly status: DeliveryStatus; readonly error?: string | undefined },
): Promise<boolean> {
  const done = await db
    .update(broadcastDeliveries)
    .set({
      status: outcome.status,
      error: outcome.error ?? null,
      at: new Date(),
    })
    .where(and(eq(broadcastDeliveries.id, deliveryId), eq(broadcastDeliveries.status, 'sending')))
    .returning({ id: broadcastDeliveries.id });

  return done.length > 0;
}

/**
 * Подтвердить и запустить. Возвращает ложь, если подтверждать нечего.
 *
 * Условие `status = 'draft'` — защита от двойного подтверждения: две
 * нажатые кнопки не должны дать двух воркеров на одной рассылке.
 */
export async function startBroadcast(db: Executor, id: string): Promise<boolean> {
  const done = await db
    .update(broadcasts)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(broadcasts.id, id), eq(broadcasts.status, 'draft')))
    .returning({ id: broadcasts.id });

  return done.length > 0;
}

/**
 * Попросить остановиться.
 *
 * Просьба, а не приказ: воркер может быть в середине порции. Статус
 * поставит он сам, когда встанет, — иначе панель показывала бы
 * «остановлено» раньше, чем отправка прекратилась.
 */
export async function requestStop(db: Executor, id: string): Promise<boolean> {
  const done = await db
    .update(broadcasts)
    .set({ stopRequestedAt: new Date() })
    .where(
      and(
        eq(broadcasts.id, id),
        eq(broadcasts.status, 'running'),
        isNull(broadcasts.stopRequestedAt),
      ),
    )
    .returning({ id: broadcasts.id });

  return done.length > 0;
}

export async function finishBroadcast(
  db: Executor,
  id: string,
  status: 'stopped' | 'done' | 'failed',
): Promise<void> {
  await db
    .update(broadcasts)
    .set({ status, finishedAt: new Date() })
    .where(and(eq(broadcasts.id, id), ne(broadcasts.status, status)));
}

/** Список рассылок для панели, свежие сверху. */
export async function listBroadcasts(
  db: Executor,
  howMany = 20,
): Promise<readonly (Broadcast & { readonly counts: BroadcastCounts })[]> {
  const rows = await db
    .select()
    .from(broadcasts)
    .orderBy(desc(broadcasts.createdAt), desc(broadcasts.id))
    .limit(howMany);

  const out: (Broadcast & { counts: BroadcastCounts })[] = [];
  for (const row of rows) {
    out.push({ ...row, counts: await countsOf(db, row.id) });
  }

  return out;
}

/** Неудачные отправки одной рассылки — для журнала ошибок. */
export async function failedOf(
  db: Executor,
  id: string,
  howMany = 50,
): Promise<readonly BroadcastDelivery[]> {
  return await db
    .select()
    .from(broadcastDeliveries)
    .where(and(eq(broadcastDeliveries.broadcastId, id), eq(broadcastDeliveries.status, 'failed')))
    .orderBy(desc(broadcastDeliveries.at))
    .limit(howMany);
}

/**
 * Вернуть неудачные в очередь — «повторный запуск» из §15.
 *
 * Повторяются **только** `failed`. Пропущенные не повторяются никогда:
 * человек заблокировал бота, и повтор — это ещё один запрос из общего
 * лимита за тем же самым 403.
 */
export async function retryFailed(db: Executor, id: string): Promise<number> {
  const back = await db
    .update(broadcastDeliveries)
    .set({ status: 'pending', error: null, at: null })
    .where(and(eq(broadcastDeliveries.broadcastId, id), eq(broadcastDeliveries.status, 'failed')))
    .returning({ id: broadcastDeliveries.id });

  if (back.length > 0) {
    await db
      .update(broadcasts)
      .set({ status: 'running', stopRequestedAt: null, finishedAt: null })
      .where(eq(broadcasts.id, id));
  }

  return back.length;
}

/**
 * Рассылки, которые числятся идущими.
 *
 * Нужны при старте бота: выкладка посреди рассылки убивает воркер, а
 * задание BullMQ уходит вместе с ним. Без этого рассылка встала бы
 * навсегда в состоянии «идёт», и половина людей не получила бы письма —
 * молча, что здесь худшая из возможностей.
 */
export async function runningBroadcasts(db: Executor): Promise<readonly string[]> {
  const rows = await db
    .select({ id: broadcasts.id })
    .from(broadcasts)
    .where(and(eq(broadcasts.status, 'running'), isNull(broadcasts.stopRequestedAt)))
    .orderBy(broadcasts.createdAt);

  return rows.map((row) => row.id);
}
