import { and, eq } from 'drizzle-orm';

import { items, type ChangedBy, type Item } from '../../db/schema.js';
import type { Database } from '../../infra/db.js';
import type { ResolverAction, ResolverAnswer, ResolverMode } from '../ai/schemas/index.js';
import { resolveDeadline } from '../classifier/dates.js';
import { sourceOf } from '../recurrence/asked.js';
import { resolveRecurrence } from '../recurrence/recurrence.js';
import { isRecurring, nextDeadlineAfterDone } from '../recurrence/recurrence.service.js';

import { recordRevision } from './revisions.repo.js';
import { withCapital } from '../items/item-text.js';

/**
 * Применение изменения (§7.3 ТЗ, задача 3.3).
 *
 * Инвариант 7: каждое автоматическое изменение записи оставляет ревизию
 * со снимком «до». Здесь это не «не забыть записать», а единственный
 * путь: изменение и ревизия происходят в одной транзакции, и запись без
 * ревизии не может получиться даже при падении посередине.
 *
 * **Изменение, которое ничего не меняет, не применяется.** Модель может
 * вернуть «поправить срок» на тот же самый срок. Ревизия с одинаковыми
 * «до» и «после» — это кнопка отмены, которая ничего не отменяет, и
 * сообщение человеку о том, чего не было.
 */

/**
 * Поля, которые умеет менять резолвер.
 *
 * Каждое обязано быть в `RESTORABLE_FIELDS`: то, что бот меняет сам, он
 * обязан уметь вернуть. Проверяется тестом, а не памятью.
 */
export const PATCHABLE_FIELDS = [
  'text',
  'body',
  'recurrenceRule',
  'recurrenceText',
  'recurrenceSource',
  'status',
  'completedAt',
  'deadlineAt',
  'deadlineAccuracy',
] as const;

export type PatchableField = (typeof PATCHABLE_FIELDS)[number];

/** Правка записи: только те поля, что резолвер имеет право менять. */
type ItemPatch = Partial<Pick<Item, PatchableField>>;

export interface ApplyParams {
  readonly userId: string;
  readonly itemId: string;
  /** «Новая мысль» сюда не приходит: применять нечего. */
  readonly action: Exclude<ResolverAction, 'new'>;
  readonly changes: ResolverAnswer['changes'];
  /**
   * Сказанное человеком: по нему видно, просили ли запомнить (3.8б).
   *
   * Без него правило, о котором попросили, легло бы в базу как названное
   * мимоходом, и различить их потом стало бы нечем.
   */
  readonly spoken?: string | undefined;
  /**
   * §7.4: дополняем подробности или заменяем поля.
   *
   * По умолчанию замена — так работали все, кто звал применение до
   * задачи 3.7, и менять их поведение молча нельзя.
   */
  readonly mode?: ResolverMode | undefined;
  readonly timeZone: string;
  readonly now?: Date | undefined;
  readonly reason?: string | undefined;
  readonly sourceMessageId?: string | undefined;
  /** По умолчанию `resolver`: сюда приходят автоматические решения. */
  readonly changedBy?: ChangedBy | undefined;
}

export interface Applied {
  readonly revisionId: string;
  /** Что делали: реплика человеку у выполнения и правки разная. */
  readonly action: Exclude<ResolverAction, 'new'>;
  readonly before: Item;
  readonly after: Item;
  /** Что именно поменялось — для реплики человеку и для журнала. */
  readonly fields: readonly PatchableField[];
}

/** Что станет с записью. Пустой объект означает «ничего не меняется». */
function plan(item: Item, params: ApplyParams, now: Date): ItemPatch {
  const next: ItemPatch = {};

  if (params.action === 'complete') {
    /**
     * Задача 3.8а: у регулярного дела выполнение двигает срок, а не
     * закрывает запись. Иначе на месте одного «оплатить садик» вырастет
     * стена из двенадцати — ровно та вина, которую продукт снимает.
     */
    const moved = nextDeadlineAfterDone(item, { timeZone: params.timeZone, now });

    if (moved !== undefined) {
      if (item.deadlineAt?.getTime() !== moved.getTime()) {
        next.deadlineAt = moved;
        next.deadlineAccuracy = 'day';
      }
      return next;
    }

    if (item.status !== 'done') {
      next.status = 'done';
      next.completedAt = now;
    }
    return next;
  }

  if (params.action === 'cancel') {
    /**
     * Задача 3.8а: «больше не надо» у регулярного дела снимает правило,
     * а не отменяет запись. Человек имел в виду «перестань напоминать»,
     * а не «этого дела не было»: садик оплачивался год, и это правда,
     * даже если больше не оплачивается.
     */
    if (isRecurring(item)) {
      next.recurrenceRule = null;
      next.recurrenceText = null;
      next.recurrenceSource = null;
      return next;
    }

    // §13.5: «убрать» — это отменённая запись, а не удалённая строка.
    if (item.status !== 'cancelled') next.status = 'cancelled';
    return next;
  }

  /**
   * Дополнение (§7.4): подробность дописывается, заголовок и срок целы.
   *
   * «А ещё туда надо взять карту прививок» не заменяет «Записать сына к
   * врачу» и не двигает четверг. Правка полей здесь не рассматривается
   * вовсе, даже если модель их заполнила: смешивать замену с дополнением
   * — значит однажды переписать заголовок под видом уточнения.
   */
  if (params.mode === 'append') {
    const note = params.changes.note.trim();
    if (note.length === 0) return next;

    // Подробности копятся строками: каждая — отдельная мысль человека, и
    // склеивать их в один абзац значит терять границы.
    const already = item.body ?? '';

    // Одно и то же уточнение дважды — не изменение. Человек мог повторить
    // сказанное, а список подробностей с дублями читать невозможно.
    if (already.split('\n').includes(note)) return next;

    next.body = already.length === 0 ? note : `${already}\n${note}`;
    return next;
  }

  const { text, deadline, deadlineAccuracy } = params.changes;

  /**
   * Правка правила повторения (задача 3.8б).
   *
   * «Запомни, это у меня каждый месяц» про существующее дело — правка,
   * а не новая запись. Ведёт себя как правка срока: показывается
   * человеку и откатывается одним тапом.
   *
   * Правило опирается на срок: без даты неизвестно, какой день недели и
   * какое число месяца повторять. Поэтому берётся новый срок, если он
   * назван, иначе нынешний.
   */
  if (params.changes.recurrenceKind !== 'none') {
    const anchor =
      deadline.length > 0 ? deadline : (item.deadlineAt?.toISOString().slice(0, 10) ?? '');

    const resolved = resolveRecurrence({
      kind: params.changes.recurrenceKind,
      interval: params.changes.recurrenceInterval,
      text: params.changes.recurrenceText,
      deadline: anchor,
    });

    if (resolved.rule !== undefined && resolved.text !== undefined) {
      next.recurrenceRule = resolved.rule;
      next.recurrenceText = resolved.text;
      next.recurrenceSource = sourceOf(params.spoken ?? '', resolved.source);
    }
  }

  // Пустая строка означает «не трогать»: так же устроена схема
  // классификации, и модели такой ответ даётся надёжнее пропуска ключа.
  // Правило то же, что при сохранении: заголовок не должен менять
  // регистр от того, каким путём он пришёл (задача 3.25).
  const rewritten = withCapital(text);
  if (rewritten.length > 0 && rewritten !== item.text) next.text = rewritten;

  if (deadline.length > 0) {
    /**
     * Срок проверяется тем же кодом, что и при разборе выгрузки:
     * привязка к поясу человека, отказ от прошлого и от дат дальше пяти
     * лет. Проверка «названо ли это в тексте» здесь не включается — она
     * ищет цифры в сказанном, а поправка звучит словами: «нет, в
     * пятницу». Для неё эта проверка отвергала бы верные сроки.
     */
    const outcome = resolveDeadline(
      { deadline, accuracy: deadlineAccuracy },
      { now, timeZone: params.timeZone },
    );

    if (outcome.ok && outcome.deadline !== undefined) {
      const at = outcome.deadline.at;
      if (item.deadlineAt?.getTime() !== at.getTime()) {
        next.deadlineAt = at;
        next.deadlineAccuracy = outcome.deadline.accuracy;
      }
    }
  }

  return next;
}

/**
 * Применяет решение и оставляет ревизию.
 *
 * Возвращает `undefined`, если менять нечего или записи нет: и то, и
 * другое — обычные исходы, а не ошибки.
 */
export async function applyDecision(
  db: Database,
  params: ApplyParams,
): Promise<Applied | undefined> {
  const now = params.now ?? new Date();

  return await db.transaction(async (tx): Promise<Applied | undefined> => {
    /**
     * Запись читается и правится в одной транзакции.
     *
     * Инвариант 9 держит обработку одного человека последовательной, но
     * откат и правка приходят из разных обработчиков: между чтением и
     * записью может лечь чужое изменение, и снимок «до» окажется чужим.
     */
    const [item] = await tx
      .select()
      .from(items)
      .where(and(eq(items.id, params.itemId), eq(items.userId, params.userId)))
      .for('update')
      .limit(1);

    if (!item) return undefined;

    const next = plan(item, params, now);
    const fields = Object.keys(next) as PatchableField[];
    if (fields.length === 0) return undefined;

    const [after] = await tx
      .update(items)
      .set({ ...next, updatedAt: now })
      .where(eq(items.id, item.id))
      .returning();

    if (!after) return undefined;

    const revision = await recordRevision(tx, {
      itemId: item.id,
      userId: params.userId,
      changedBy: params.changedBy ?? 'resolver',
      before: item,
      after,
      reason: params.reason,
      sourceMessageId: params.sourceMessageId,
    });

    return { revisionId: revision.id, action: params.action, before: item, after, fields };
  });
}
