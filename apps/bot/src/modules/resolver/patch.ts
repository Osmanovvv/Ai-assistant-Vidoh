import { and, eq } from 'drizzle-orm';

import { items, type ChangedBy, type Item } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import type { ResolverAction, ResolverAnswer, ResolverMode } from '../ai/schemas/index.js';
import {
  isoDateIn,
  nearestWeekday,
  resolveDeadline,
  saysDistantWeek,
  startOfDayAfter,
} from '../classifier/dates.js';
import { weekdaysIn } from '../classifier/time-words.js';
import { sourceOf } from '../recurrence/asked.js';
import type { RecurrenceSource } from '../recurrence/recurrence.js';
import { nextOccurrence, resolveRecurrence } from '../recurrence/recurrence.js';
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

/**
 * Что можно сделать с записью.
 *
 * Три действия приходят от резолвера; «отложить» — только с кнопки
 * карточки (ревизия этапа 3, C1): модель его не выбирает, а человек
 * словами говорит «перенеси», и это `update` со сроком. Но решение это
 * того же рода — меняет запись и обязано оставить ревизию, — поэтому идёт
 * тем же путём, а не своей записью в базу.
 */
export type ApplyAction = Exclude<ResolverAction, 'new'> | 'snooze';

/** Сколько ждать отложенное дело. §11 подробностей не задаёт. */
const SNOOZE_DAYS = 3;

/**
 * Пустые изменения: применение ждёт все поля, меняются лишь названные.
 *
 * Точность — `none`, а не `day`: пустой срок применение и так не трогает,
 * но нейтральное значение здесь должно выглядеть нейтральным. Тот, кто
 * однажды добавит сюда срок и забудет про точность, получит `day` молча.
 *
 * Одно место на всех: кнопки под напоминанием, карточка, правка словами
 * и конвейер — раньше у каждого была своя копия, и четвёртая (12.09.2026)
 * была бы лишней.
 */
export function emptyChanges(): ResolverAnswer['changes'] {
  return {
    note: '',
    text: '',
    deadline: '',
    deadlineAccuracy: 'none',
    recurrenceKind: 'none',
    recurrenceInterval: 0,
    recurrenceText: '',
  };
}

export interface ApplyParams {
  readonly userId: string;
  readonly itemId: string;
  /** «Новая мысль» сюда не приходит: применять нечего. */
  readonly action: ApplyAction;
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
  /**
   * Откуда взялось правило повторения, если это известно снаружи.
   *
   * По умолчанию источник выводится из сказанного: попросил запомнить —
   * `asked`, назвал мимоходом — `stated`. Но правило, которое **заметил
   * сам бот** (задача 3.8в), человек не называл вовсе: он только нажал
   * «Да, запомни». Без этого поля такое правило ложилось бы в базу как
   * названное человеком, и способ 3 запроса на изменение №1 стало бы
   * нечем отличить от способа 1.
   */
  readonly recurrenceSource?: RecurrenceSource | undefined;
}

export interface Applied {
  readonly revisionId: string;
  /** Что делали: реплика человеку у выполнения и правки разная. */
  readonly action: ApplyAction;
  readonly before: Item;
  readonly after: Item;
  /** Что именно поменялось — для реплики человеку и для журнала. */
  readonly fields: readonly PatchableField[];
}

/** Начало местного дня через `SNOOZE_DAYS` от сегодняшнего. */
function snoozeUntil(now: Date, timeZone: string): Date {
  return startOfDayAfter(now, SNOOZE_DAYS, timeZone);
}

/**
 * Что станет с записью, или почему не станет.
 *
 * `refused` — правка отвергнута по существу (срок в прошлом, несуществующая
 * дата): это не «менять нечего», а «не смогли», и человек обязан это
 * услышать (ревизия этапа 3, A3). Пустой `next` без `refused` означает
 * «ничего не меняется».
 */
interface Plan {
  readonly next: ItemPatch;
  readonly refused?: string | undefined;
}

function plan(item: Item, params: ApplyParams, now: Date): Plan {
  const next: ItemPatch = {};
  let refused: string | undefined;

  if (params.action === 'complete') {
    /**
     * Задача 3.8а: у регулярного дела выполнение двигает срок, а не
     * закрывает запись. Иначе на месте одного «оплатить садик» вырастет
     * стена из двенадцати — ровно та вина, которую продукт снимает.
     */
    const moved = nextDeadlineAfterDone(item, { timeZone: params.timeZone, now });

    if (moved !== undefined) {
      /**
       * Второе «сделано» в тот же день — повтор, а не второе выполнение
       * (ревизия этапа 3, C2). Раньше каждое считалось от уже сдвинутого
       * срока, и два нажатия уносили садик на два месяца вперёд.
       */
      if (
        item.completedAt !== null &&
        isoDateIn(item.completedAt, params.timeZone) === isoDateIn(now, params.timeZone)
      ) {
        return { next };
      }

      if (item.deadlineAt?.getTime() !== moved.getTime()) {
        next.deadlineAt = moved;
        next.deadlineAccuracy = 'day';
      }
      // Запись не закрывается, но когда её сделали в последний раз —
      // записано: по этому вечерний итог считает сделанное (C9).
      next.completedAt = now;
      return { next };
    }

    if (item.status !== 'done') {
      next.status = 'done';
      next.completedAt = now;
    }
    return { next };
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
      /**
       * И срок, порождённый правилом (ревизия этапа 3, C3).
       *
       * Дата у регулярного дела — не слова человека, а то, что вычислило
       * прошлое «сделано». Оставить её значило прислать «Завтра срок»
       * после «больше не буду напоминать» и держать дело просроченным.
       */
      if (item.deadlineAt !== null) {
        next.deadlineAt = null;
        next.deadlineAccuracy = null;
      }
      return { next };
    }

    // §13.5: «убрать» — это отменённая запись, а не удалённая строка.
    if (item.status !== 'cancelled') next.status = 'cancelled';
    // Убранное — не сделанное: иначе вечерний итог посчитал бы его
    // закрытым сегодня.
    if (item.completedAt !== null) next.completedAt = null;
    return { next };
  }

  if (params.action === 'snooze') {
    /**
     * «Отложить» — это «не сейчас» (ревизия этапа 3, C1).
     *
     * Просроченное или бессрочное уходит на три дня вперёд, к началу
     * местного дня — с дневной точностью, как любой срок: иначе оно
     * осталось бы просроченным и полезло бы в выдачу тем же вечером.
     * Будущий срок не трогается: отложить «к врачу в четверг» — не
     * значит перенести приём. Дело прячется до своего дня, а дата
     * остаётся его датой.
     */
    if (item.status !== 'snoozed') next.status = 'snoozed';

    if (item.deadlineAt === null || item.deadlineAt.getTime() <= now.getTime()) {
      const until = snoozeUntil(now, params.timeZone);

      if (item.deadlineAt?.getTime() !== until.getTime()) {
        next.deadlineAt = until;
        next.deadlineAccuracy = 'day';
      }
    }

    return { next };
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
    if (note.length === 0) return { next };

    // Подробности копятся строками: каждая — отдельная мысль человека, и
    // склеивать их в один абзац значит терять границы.
    const already = item.body ?? '';

    // Одно и то же уточнение дважды — не изменение. Человек мог повторить
    // сказанное, а список подробностей с дублями читать невозможно.
    if (already.split('\n').includes(note)) return { next };

    next.body = already.length === 0 ? note : `${already}\n${note}`;
    return { next };
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
    /**
     * День недели пересчитывается кодом, как при разборе выгрузки
     * (задача 3.65).
     *
     * **Найдено сквозным прогоном 05.09.2026, в субботу.** На «перенеси на
     * пятницу» модель вернула `2026-09-04` — **вчерашнюю** пятницу.
     * Прошлые сроки проверка отбрасывает намеренно, и правка не
     * применялась вовсе: человек сказал «перенеси», и не произошло
     * ничего. В пятницу тот же случай проходил — модель попадала в
     * сегодня, — поэтому дефект держался незамеченным.
     *
     * У разбора выгрузки такое правило есть с задачи 2.7: назван день
     * недели — дата обязана быть этим днём, и считает её код. Здесь оно
     * не работало, потому что проверка получает срок **без слов
     * человека**: вместе со словами включилась бы и лицензия «названо ли
     * это вслух», а она ищет цифры и отвергала бы верные поправки.
     *
     * Поэтому пересчёт стоит здесь, до проверки: тем же `nearestWeekday`,
     * что у классификации, и по тому же условию — назван **ровно один**
     * день недели и точность дневная.
     */
    const named = weekdaysIn(params.spoken ?? '');
    const only = named.length === 1 ? named[0] : undefined;

    // «На следующую пятницу» — дальний день его выбор, ближайшим не
    // подменяется (ревизия этапа 3, A1-средняя); правило то же, что у
    // классификации.
    const corrected =
      only !== undefined && deadlineAccuracy === 'day' && !saysDistantWeek(params.spoken ?? '')
        ? new Intl.DateTimeFormat('sv-SE', { timeZone: params.timeZone }).format(
            nearestWeekday(only, { now, timeZone: params.timeZone }),
          )
        : deadline;

    const outcome = resolveDeadline(
      { deadline: corrected, accuracy: deadlineAccuracy },
      { now, timeZone: params.timeZone },
    );

    if (outcome.ok && outcome.deadline !== undefined) {
      const at = outcome.deadline.at;
      if (item.deadlineAt?.getTime() !== at.getTime()) {
        next.deadlineAt = at;
        next.deadlineAccuracy = outcome.deadline.accuracy;
      }
    } else if (!outcome.ok) {
      // Причина отказа шла в никуда — ни в журнал, ни человеку (A3).
      refused = outcome.reason;
    }
  }

  /**
   * Правка правила повторения (задача 3.8б).
   *
   * «Запомни, это у меня каждый месяц» про существующее дело — правка, а
   * не новая запись. Ведёт себя как правка срока: показывается человеку и
   * откатывается одним тапом.
   *
   * **Стоит после разбора срока, и это не косметика.** Правило опирается
   * на дату, и брать её надо ту, которая у записи действительно будет, —
   * не строку модели. Строку тут же ниже пересчитывает `nearestWeekday`:
   * человек сказал «в четверг», модель ответила средой, срок исправлен, а
   * якорь оставался средой — и «каждый четверг» становилось «каждой
   * средой» навсегда (ревизия этапов 1–2). Порядок — и есть починка.
   *
   * Якорь берётся **в поясе человека** (задача 3.74): схема правила
   * требует этого прямо, а `toISOString()` у москвича делал из четверга
   * среду, у омича промахивался на все шесть часов пояса.
   */
  if (params.changes.recurrenceKind !== 'none') {
    const at = next.deadlineAt ?? item.deadlineAt;

    /**
     * Последняя опора — строка модели, как и раньше.
     *
     * Срока может не быть вовсе: «запомни, это каждый месяц» про запись
     * без даты. Выбросить тут правило значило бы потерять законное
     * `weekdays` у «по будням» — цену такой замены без прогона набора не
     * измерить, а `resolveRecurrence` и сам откажет, если опереться не на
     * что.
     */
    const anchor = at === null ? deadline : isoDateIn(at, params.timeZone);

    const resolved = resolveRecurrence({
      kind: params.changes.recurrenceKind,
      interval: params.changes.recurrenceInterval,
      text: params.changes.recurrenceText,
      deadline: anchor,
    });

    if (resolved.rule !== undefined && resolved.text !== undefined) {
      next.recurrenceRule = resolved.rule;
      next.recurrenceText = resolved.text;
      next.recurrenceSource =
        params.recurrenceSource ?? sourceOf(params.spoken ?? '', resolved.source);

      /**
       * Правило на закрытой записи оживляет её (ревизия этапа 3, C7).
       *
       * Главный сценарий 3.17а: «оплатить садик» четыре раза, все
       * сделаны; бот заметил ритм, человек нажал «Да, запомни» — правило
       * ложилось на закрытую запись, которую не видят ни выдача, ни
       * планировщик. «Запомнила» — и тишина навсегда. Регулярное дело —
       * живое по устройству: запись снова в работе, срок — ближайшее
       * повторение от сегодня.
       */
      const closed = item.status === 'done' || item.status === 'cancelled';
      /**
       * И бессрочной (C6): дата от модели отвергнута, у записи срока
       * не было — правило ложилось, а срок оставался пустым, и
       * планировщик такую запись не видел никогда. Регулярное дело без
       * срока — не регулярное.
       */
      const dateless = (next.deadlineAt ?? item.deadlineAt) === null;

      if (closed) {
        next.status = 'new';
        if (item.completedAt !== null) next.completedAt = null;
      }
      if (closed || dateless) {
        next.deadlineAt = nextOccurrence(resolved.rule, { after: now, timeZone: params.timeZone });
        next.deadlineAccuracy = 'day';
      }
    }
  }

  return refused === undefined ? { next } : { next, refused };
}

/**
 * Исход применения (ревизия этапа 3, A3).
 *
 * Раньше «записи нет», «менять нечего» и «срок отвергнут» схлопывались в
 * один `undefined`, и все вызывающие читали его как «уже в нужном
 * состоянии»: на «перенеси на десятое» с датой в прошлом бот отвечал
 * «Добавила к прошлой», в записи ничего не менялось, кнопки отмены не
 * было. Четыре исхода — четыре ответа.
 */
export type ApplyOutcome =
  /** Изменение применено, есть что отменять. */
  | { readonly kind: 'applied'; readonly applied: Applied }
  /** Запись уже в этом состоянии — менять нечего; это не ошибка. */
  | { readonly kind: 'unchanged' }
  /** Правка отвергнута по существу; причина — словами для журнала. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** Записи нет: чужая, удалённая или выдуманный код. */
  | { readonly kind: 'gone' };

/** Само изменение, если оно было, — для тех, кому исход неважен. */
export function appliedOf(outcome: ApplyOutcome): Applied | undefined {
  return outcome.kind === 'applied' ? outcome.applied : undefined;
}

/**
 * Применяет решение и оставляет ревизию.
 *
 * Исход размечен: «применено», «менять нечего», «отвергнуто с причиной»,
 * «записи нет» — см. `ApplyOutcome`.
 */
export async function applyDecision(db: Executor, params: ApplyParams): Promise<ApplyOutcome> {
  const now = params.now ?? new Date();

  return await db.transaction(async (tx): Promise<ApplyOutcome> => {
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

    if (!item) return { kind: 'gone' };

    const planned = plan(item, params, now);
    const next = planned.next;
    const fields = Object.keys(next) as PatchableField[];

    if (fields.length === 0) {
      return planned.refused === undefined
        ? { kind: 'unchanged' }
        : { kind: 'refused', reason: planned.refused };
    }

    const [after] = await tx
      .update(items)
      .set({ ...next, updatedAt: now })
      .where(eq(items.id, item.id))
      .returning();

    if (!after) return { kind: 'gone' };

    const revision = await recordRevision(tx, {
      itemId: item.id,
      userId: params.userId,
      changedBy: params.changedBy ?? 'resolver',
      before: item,
      after,
      reason: params.reason,
      sourceMessageId: params.sourceMessageId,
    });

    return {
      kind: 'applied',
      applied: { revisionId: revision.id, action: params.action, before: item, after, fields },
    };
  });
}
