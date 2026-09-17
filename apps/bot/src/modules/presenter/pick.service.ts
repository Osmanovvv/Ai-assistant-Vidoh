import { and, eq } from 'drizzle-orm';

import { batches, items } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { dueWords } from '../items/deadline-words.js';
import { openItemsFor } from '../items/items.repo.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { selectForOutput } from '../output/filter.js';
import { withNextSteps } from '../projects/projects.service.js';

/**
 * «Выбрать главное» (решение заказчицы 15.09.2026).
 *
 * Прежде до трёх дел показывались сразу под признанием — той же очередью
 * выдачи, что собирается здесь. Теперь они показываются по кнопке, и
 * собирать их приходится **в момент нажатия**, а не в момент разбора:
 * между ними человек мог закрыть дело, поправить срок или наговорить
 * ещё — список обязан быть про то, что открыто сейчас.
 *
 * Что сохраняется от разбора — только память о том, что сказано в этой
 * выгрузке (`batches.mentioned_item_ids`: заведённое, узнанное как повтор,
 * поправленное словами): очередь ставит упомянутое вперёд (задача 3.24),
 * и код выгрузки для этого едет в кнопке. Заведённое добирается и по
 * `source_batch_id` — на случай выгрузок, разобранных до этой колонки.
 */
export interface PickedActions {
  readonly actions: readonly string[];
  readonly hidden: number;
  readonly firstItemId?: string | undefined;
}

export async function pickMain(
  db: Executor,
  params: {
    readonly userId: string;
    readonly batchId?: string | undefined;
    readonly now: Date;
    readonly timeZone: string;
    readonly texts?: TextProfile | undefined;
  },
): Promise<PickedActions> {
  const mentioned = params.batchId === undefined ? undefined : await mentionedIn(db, params);

  const open = await openItemsFor(db, params.userId);
  const selection = selectForOutput(open, {
    now: params.now,
    timeZone: params.timeZone,
    mentioned,
  });

  // §13.2: большая цель занимает строку своим первым шагом, не заголовком.
  const shown = await withNextSteps(db, selection.shown);

  /**
   * Срок — после дела (Никита, 17.09.2026).
   *
   * Бой: «На сегодня я бы взяла: — В пятницу надо забрать справку» — день
   * был виден только потому, что модель оставила его в заголовке. С
   * чистыми заголовками список читался бы как «сделай сегодня», а справка
   * в пятницу. Хвост — как в списке ветки: «· завтра», «· на неделе с
   * 21.09», «· в октябре»; у сегодняшних и бессрочных хвоста нет.
   */
  const texts = params.texts ?? textsFor(null);
  const withDue = (item: (typeof shown)[number]): string => {
    if (item.deadlineAt === null) return item.text;
    const when = dueWords({ ...item, deadlineAt: item.deadlineAt }, params, texts);
    return when === undefined ? item.text : `${item.text} · ${when}`;
  };

  return {
    actions: shown.map(withDue),
    hidden: selection.hidden,
    firstItemId: selection.shown[0]?.id,
  };
}

/** Упомянутое в выгрузке: запомненное при разборе плюс заведённое ею. */
async function mentionedIn(
  db: Executor,
  params: { readonly userId: string; readonly batchId?: string | undefined },
): Promise<ReadonlySet<string>> {
  const [batch] =
    params.batchId === undefined
      ? []
      : await db
          .select({ ids: batches.mentionedItemIds })
          .from(batches)
          .where(and(eq(batches.id, params.batchId), eq(batches.userId, params.userId)))
          .limit(1);

  const created =
    params.batchId === undefined
      ? []
      : await db
          .select({ id: items.id })
          .from(items)
          .where(and(eq(items.userId, params.userId), eq(items.sourceBatchId, params.batchId)));

  return new Set([...(batch?.ids ?? []), ...created.map((row) => row.id)]);
}

/** Конвейер запоминает, о чём была выгрузка, — для очереди по кнопке. */
export async function rememberMentioned(
  db: Executor,
  batchId: string,
  itemIds: readonly string[],
): Promise<void> {
  await db
    .update(batches)
    .set({ mentionedItemIds: [...itemIds] })
    .where(eq(batches.id, batchId));
}
