import type { Logger } from 'pino';

import { requestStructured, type AiClientDeps } from '../ai/client.js';
import type {
  ClassifiedItems,
  DeadlineAccuracy,
  ItemType,
  Priority,
} from '../ai/schemas/classifier.js';
import type { ExtractedUnit } from '../extractor/extractor.service.js';
import { sourceOf } from '../recurrence/asked.js';
import { resolveRecurrence, type ResolvedRecurrence } from '../recurrence/recurrence.js';
import { describeToday, resolveDeadline, type ResolvedDeadline } from './dates.js';

/**
 * Классификация записей (задача 2.6).
 *
 * §6.2 ТЗ задаёт признаки типов, §6.3 — приоритеты, §6.4 — темы, задача
 * 2.7 — сроки. Всё это один вызов модели: типы и приоритеты связаны, и
 * разносить их по разным вызовам значило бы платить дважды за одно
 * рассуждение.
 *
 * Три правила проверяются в коде, а не только в промпте. Промпт — это
 * просьба, а не гарантия, и на трёх вещах цена ошибки слишком велика:
 *
 * 1. **Желание не становится задачей.** §6.2 прямо называет это правилом,
 *    которое модели нарушают чаще всего. Приоритет у не-TASK принудительно
 *    `NONE` — тогда такая запись не попадёт в выдачу даже если модель
 *    поставила ей `NOW`.
 * 2. **Тема — только из списка человека.** §6.4 запрещает создавать темы
 *    без спроса, поэтому незнакомая тема заменяется темой по умолчанию.
 * 3. **Срок проверяется и привязывается к поясу.** Неверный срок хуже
 *    отсутствующего: напоминание, пришедшее не вовремя, хуже
 *    не пришедшего.
 */

export interface ClassifyParams {
  /** Единицы, полученные извлечением (задача 2.5). */
  readonly units: readonly ExtractedUnit[];
  /** Темы человека. §6.4: они создаются на онбординге по его ответам. */
  readonly topics: readonly string[];
  /** Куда девать запись, не попавшую ни в одну тему (§6.4). */
  readonly defaultTopic: string;
  readonly timeZone: string;
  /**
   * Сказанное человеком целиком, до извлечения (задача 3.8б).
   *
   * Извлечение переписывает «запомни, садик оплачивается пятого» в
   * «оплатить садик», и просьба запомнить из текста единицы исчезает. А
   * различить «попросили запомнить» и «назвали мимоходом» можно только
   * по исходным словам.
   */
  readonly spoken?: string | undefined;
  readonly now?: Date | undefined;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
}

export interface ClassifiedItem {
  readonly text: string;
  readonly type: ItemType;
  readonly priority: Priority;
  readonly topic: string;
  readonly isProject: boolean;
  readonly deadline?: ResolvedDeadline | undefined;
  /** Регулярность (задача 2.18а). Поле у `TASK`, как и признак проекта. */
  readonly recurrence?: ResolvedRecurrence | undefined;
}

/** Что пришлось поправить за моделью. Ненулевое — повод к промпту. */
export interface Corrections {
  /** Приоритет у не-TASK, который модель поставила не `NONE`. */
  readonly priority: number;
  /** Тема не из списка человека. */
  readonly topic: number;
  /** Срок не прошёл проверку и был отброшен. */
  readonly deadline: number;
  /** Признак проекта у записи, которая не задача. */
  readonly project: number;
  /** Регулярность у записи, которая не задача, либо без правила. */
  readonly recurrence: number;
}

interface ClassifySuccess {
  readonly ok: true;
  readonly items: readonly ClassifiedItem[];
  readonly promptVersion: string;
  readonly corrections: Corrections;
}

interface ClassifyFailure {
  readonly ok: false;
  readonly promptVersion: string;
  readonly raw: string;
  readonly problem: string;
}

export type ClassifyResult = ClassifySuccess | ClassifyFailure;

/** §6.3 ТЗ: важность бывает только у задачи. */
function isActionable(type: ItemType): boolean {
  return type === 'TASK';
}

function normalizeTopic(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е').trim();
}

/**
 * Что отправляем модели: дата, темы, **исходная речь** и разобранные мысли.
 *
 * **Речь целиком добавлена 02.09.2026, и без неё классификация датировала
 * слепо.** Живая выгрузка проджекта: «сегодня надо сходить в магазин…
 * завтра отнести ноутбук… в пятницу помыть машину» — одиннадцать дней из
 * тринадцати не дошли до записей. Извлечение переписывает мысль в чистое
 * повеление и ведущее слово о времени выбрасывает: остаётся «Погулять с
 * собакой», и узнать из него про «сегодня вечером» уже нельзя ниоткуда.
 *
 * Уцелевали только сроки внутри самой фразы — «забрать посылку **до 6
 * вечера**»: переписыванию они не мешают.
 *
 * **Делить поток — работа извлечения, датировать — работа классификации.**
 * Вторая не может делать своё, не видя, что человек сказал. Поэтому речь
 * идёт сюда целиком, а не пересказом.
 */
function buildInput(params: ClassifyParams, now: Date): string {
  const units = params.units.map((unit, index) => `${String(index + 1)}. ${unit.text}`).join('\n');
  const spoken = params.spoken?.trim() ?? '';

  return [
    describeToday(now, params.timeZone),
    '',
    `Доступные темы: ${params.topics.join(', ')}.`,
    '',
    ...(spoken === '' ? [] : ['Человек сказал так:', spoken, '']),
    'Мысли:',
    units,
  ].join('\n');
}

/** Что нужно поправкам, кроме самого ответа модели. */
export interface CorrectionContext {
  /** Сказанное целиком: по нему видно, просили ли запомнить (3.8б). */
  readonly spoken?: string | undefined;
  readonly topics: readonly string[];
  readonly defaultTopic: string;
  readonly timeZone: string;
  readonly now: Date;
  /**
   * Тексты единиц, пришедших на вход, в том же порядке (задача 2.7).
   *
   * Нужны проверке срока. Проверять только ответ модели нельзя: она
   * перефразирует, и слово о времени из речи человека может в пересказе
   * исчезнуть — тогда настоящий срок отбросился бы как выдуманный.
   * Поймано тестом: подменённая модель вернула «дело», и проверка съела
   * законный срок.
   *
   * Сопоставление по порядку: схема требует столько же записей, сколько
   * пришло единиц, и в том же порядке. Если числа разошлись, входные
   * тексты не используются — гадать, кто с кем, нельзя.
   */
  readonly said?: readonly string[] | undefined;
  /** Идёт в предупреждения: без версии непонятно, какой промпт виноват. */
  readonly promptVersion: string;
  readonly logger?: Logger | undefined;
}

/**
 * Поправки за моделью — отдельной функцией, а не внутри вызова.
 *
 * Понадобилось на 2.20: §10.1 разрешает объединить извлечение и
 * классификацию в один вызов, но сравнивать пути можно только при
 * одинаковых правилах после модели. Правила §6.2, §6.3, §5.1 и §6.4 не
 * зависят от того, одним вызовом получен ответ или двумя, — значит и код
 * не должен от этого зависеть.
 */
export function correctItems(
  raw: ClassifiedItems,
  ctx: CorrectionContext,
): { readonly items: readonly ClassifiedItem[]; readonly corrections: Corrections } {
  const { now, promptVersion, logger } = ctx;

  // Сверка тем идёт по нормализованному виду, а возвращается название из
  // списка человека: в базе должно лежать ровно то, что он видит.
  const byNormalized = new Map(ctx.topics.map((topic) => [normalizeTopic(topic), topic]));

  const corrections: { -readonly [K in keyof Corrections]: Corrections[K] } = {
    priority: 0,
    topic: 0,
    deadline: 0,
    project: 0,
    recurrence: 0,
  };

  const items: ClassifiedItem[] = [];

  // Входные тексты годятся только при совпадении числа записей.
  const aligned = ctx.said?.length === raw.items.length;

  for (const [index, item] of raw.items.entries()) {
    const type = item.type;

    // §6.3 ТЗ и §6.2: желание, идея, информация и эмоция в выдачу не
    // попадают. Это то самое правило, которое модели нарушают чаще всего.
    let priority: Priority = item.priority;
    if (!isActionable(type) && priority !== 'NONE') {
      priority = 'NONE';
      corrections.priority++;
    }

    // §5.1 ТЗ: проект — поле у TASK. У остальных типов оно не значит ничего.
    let isProject = item.isProject;
    if (isProject && !isActionable(type)) {
      isProject = false;
      corrections.project++;
    }

    // §6.4 ТЗ: создавать темы без спроса запрещено.
    const topic = byNormalized.get(normalizeTopic(item.topic));
    if (topic === undefined) corrections.topic++;

    const accuracy: DeadlineAccuracy = item.deadlineAccuracy;
    const resolved = resolveDeadline(
      { deadline: item.deadline, accuracy },
      {
        now,
        timeZone: ctx.timeZone,
        // Слова человека и пересказ модели вместе: слово о времени хоть
        // в одном из них — уже основание для срока.
        said: `${aligned ? (ctx.said[index] ?? '') : ''} ${item.text}`,
        /**
         * Вторая дорога к сроку (задача 3.37): цитата модели и речь, в
         * которой код её проверит. Без речи ветка не работает — и это
         * верно, проверять цитату тогда нечем.
         */
        quoted: item.deadlineText,
        ...(ctx.spoken === undefined ? {} : { spoken: ctx.spoken }),
      },
    );

    let deadline: ResolvedDeadline | undefined;
    if (resolved.ok) {
      deadline = resolved.deadline;
      if (resolved.deadline !== undefined && resolved.corrected === 'weekday') {
        corrections.deadline++;
        logger?.info(
          { promptVersion },
          'День недели у срока не совпал с названным, дата пересчитана',
        );
      }
    } else {
      corrections.deadline++;
      logger?.warn(
        { promptVersion, reason: resolved.reason },
        'Срок не прошёл проверку, запись сохраняется без срока',
      );
    }

    /**
     * §5.1 и задача 2.18а: регулярность — поле у `TASK`. У желания,
     * идеи, факта и эмоции она не значит ничего, и база это же запрещает
     * ограничением — но полагаться на то, что до базы дойдёт правильное,
     * нельзя: отказ вставки уронил бы всю выгрузку из-за одной записи.
     */
    let recurrence: ResolvedRecurrence | undefined;
    if (isActionable(type)) {
      const resolvedRecurrence = resolveRecurrence({
        kind: item.recurrenceKind,
        interval: item.recurrenceInterval,
        text: item.recurrenceText,
        deadline: item.deadline,
      });

      if (resolvedRecurrence.text !== undefined) {
        /**
         * Задача 3.8б: «запомни» поднимает источник до `asked`.
         *
         * Разбор видит правило, но не видит, просили его запомнить или
         * назвали мимоходом. А различие важное: правило, о котором
         * попросили, бот не имеет права менять без спроса. Задним числом
         * источник не восстановить, поэтому уточняем здесь.
         *
         * Смотрим на сказанное человеком, а не на формулировку единицы:
         * извлечение переписывает «запомни, садик пятого» в «оплатить
         * садик», и просьба из текста единицы исчезает.
         */
        recurrence = {
          ...resolvedRecurrence,
          source: sourceOf(ctx.spoken ?? item.text, resolvedRecurrence.source),
        };
      }

      if (resolvedRecurrence.problem !== undefined) {
        corrections.recurrence++;
        logger?.warn(
          { promptVersion, reason: resolvedRecurrence.problem },
          'Регулярность названа, но правило не получилось — сохраняю фразой',
        );
      }
    } else if (item.recurrenceKind !== 'none') {
      corrections.recurrence++;
    }

    /**
     * У регулярного дела срок всегда дневной (задача 3.30).
     *
     * **Найдено разбором наблюдения с ручного прогона 31.08.2026.** «Каждый
     * вторник вожу сына на плавание» получало точность `week`, и
     * планировщик такому делу напоминание накануне не ставил: `remindable`
     * пропускает только `day`. В утреннюю сводку дело попадало, отдельного
     * напоминания с кнопками не было — а человек заводил «каждый вторник»
     * ровно затем, чтобы ему напомнили.
     *
     * **Это не спор с моделью, а следствие из устройства.** Правило
     * регулярности вообще не строится без конкретной даты: `resolveRecurrence`
     * требует `ГГГГ-ММ-ДД` и без него возвращает «нет срока, на который
     * опереться». Значит у дела с правилом дата точная по построению, и
     * `week` здесь — не оценка точности, а несогласованность ответа.
     * Дальше выполнение двигает срок через `nextOccurrence`, и там дата
     * тоже всегда конкретная.
     */
    const withRule =
      recurrence?.rule !== undefined && deadline !== undefined && deadline.accuracy !== 'day'
        ? { ...deadline, accuracy: 'day' as const }
        : deadline;

    if (withRule !== deadline) corrections.deadline++;

    items.push({
      text: item.text,
      type,
      priority,
      topic: topic ?? ctx.defaultTopic,
      isProject,
      deadline: withRule,
      recurrence,
    });
  }

  const total =
    corrections.priority +
    corrections.topic +
    corrections.deadline +
    corrections.project +
    corrections.recurrence;
  if (total > 0) {
    logger?.info({ promptVersion, ...corrections }, 'Ответ классификации пришлось поправить');
  }

  return { items, corrections };
}

export async function classifyUnits(
  deps: AiClientDeps,
  params: ClassifyParams,
): Promise<ClassifyResult> {
  const now = params.now ?? new Date();

  const outcome = await requestStructured<ClassifiedItems>(deps, {
    stage: 'classifier',
    input: buildInput(params, now),
    userId: params.userId,
    batchId: params.batchId,
  });

  if (!outcome.ok) {
    deps.logger?.warn(
      { promptVersion: outcome.promptVersion, problem: outcome.problem },
      'Классификация не удалась, записи пойдут в черновик',
    );

    return {
      ok: false,
      promptVersion: outcome.promptVersion,
      raw: outcome.raw,
      problem: outcome.problem,
    };
  }

  const { items, corrections } = correctItems(outcome.value, {
    ...(params.spoken === undefined ? {} : { spoken: params.spoken }),
    topics: params.topics,
    defaultTopic: params.defaultTopic,
    timeZone: params.timeZone,
    now,
    said: params.units.map((unit) => unit.text),
    promptVersion: outcome.promptVersion,
    logger: deps.logger,
  });

  return { ok: true, items, promptVersion: outcome.promptVersion, corrections };
}
