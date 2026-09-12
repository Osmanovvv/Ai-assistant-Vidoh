import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import { items, projectSteps, type Item, type ProjectStep } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { openItemsWhere } from '../items/items.repo.js';

/**
 * Проекты и ближайший шаг (§5 и §13.2 ТЗ, задача 3.12).
 *
 * «День рождения сына» — не задача, а большая составная цель. §13.2
 * требует урезать её до посильного первого шага: десять пунктов в ответ
 * на «что сегодня» — это не помощь, а та же гора, только в профиль.
 *
 * **Признак «ближайший» вычисляется, а не хранится.** План называл его
 * колонкой `is_next`, и это на один источник истины больше, чем нужно:
 * колонка и настоящее состояние шагов разъезжаются молча — достаточно
 * одного закрытия, прошедшего мимо кода, который двигает флаг. Ближайший
 * шаг — это первый незакрытый по порядку, и вычислить его дешевле, чем
 * потом искать, почему их оказалось два.
 *
 * Требование плана «закрытие шага двигает ближайший» при этом выполняется
 * само собой, и сломать его нечем.
 */

export interface ProjectContext {
  readonly steps: readonly ProjectStep[];
  /** Что уже сделано: человеку важно видеть, что он не с нуля. */
  readonly done: readonly ProjectStep[];
  readonly remaining: readonly ProjectStep[];
  /** Первый незакрытый по порядку. Пусто — проект закончен. */
  readonly next: ProjectStep | undefined;
}

/**
 * Большие цели человека — для экрана §12.1 «Проекты».
 *
 * Условие «открытых» то же, что у «Всех задач» и «Сегодня»
 * (`openItemsWhere`), а не своё: список проектов, живущий по другому
 * правилу, однажды разошёлся бы с остальными экранами — и человек
 * увидел бы цель, которой нет в задачах, или наоборот.
 *
 * Отсюда же следствие: ушедшая в фон цель здесь не показывается. Она
 * не потеряна — §13.6 держит её доступной поиском и вопросом, — но
 * список «чем я занят» она бы засоряла.
 */
export async function projectsOf(db: Executor, userId: string): Promise<Item[]> {
  return await db
    .select()
    .from(items)
    .where(and(openItemsWhere(userId), eq(items.isProject, true)))
    .orderBy(desc(items.createdAt), asc(items.sourceOrder), desc(items.id));
}

/** Все шаги проекта по порядку. */
export async function stepsOf(db: Executor, itemId: string): Promise<ProjectStep[]> {
  return await db
    .select()
    .from(projectSteps)
    .where(eq(projectSteps.itemId, itemId))
    .orderBy(asc(projectSteps.position));
}

/** Разложенное состояние проекта: что сделано, что осталось, что дальше. */
export async function contextOf(db: Executor, itemId: string): Promise<ProjectContext> {
  const steps = await stepsOf(db, itemId);
  const done = steps.filter((step) => step.doneAt !== null);
  const remaining = steps.filter((step) => step.doneAt === null);

  return { steps, done, remaining, next: remaining[0] };
}

/** Ближайший шаг проекта — то единственное, что уходит в выдачу. */
export async function nextStepOf(db: Executor, itemId: string): Promise<ProjectStep | undefined> {
  const [step] = await db
    .select()
    .from(projectSteps)
    .where(and(eq(projectSteps.itemId, itemId), isNull(projectSteps.doneAt)))
    .orderBy(asc(projectSteps.position))
    .limit(1);

  return step;
}

/**
 * Большая цель в списке — ближайшим шагом, а не заголовком (§13.2;
 * ревизия этапа 3, E17).
 *
 * Выдача разбора так и делала, а «Сегодня», утреннее и ответ «что на
 * сегодня» писали заголовок — «День рождения сына» вместо «Выбрать торт».
 * Одно место на всех: у проекта с шагами в `text` подставляется
 * ближайший, остальное как было. Неразложенный проект показывается как
 * есть — так же, как показывался до третьего этапа.
 */
export async function withNextSteps(db: Executor, list: readonly Item[]): Promise<Item[]> {
  return await Promise.all(
    list.map(async (item) => {
      if (!item.isProject) return item;
      const step = await nextStepOf(db, item.id);
      return step === undefined ? item : { ...item, text: step.text };
    }),
  );
}

export interface SaveStepsParams {
  readonly itemId: string;
  readonly userId: string;
  readonly texts: readonly string[];
}

/**
 * Записывает шаги проекта.
 *
 * Заново, а не поверх: разложение вызывается один раз, при первом
 * обращении. Дописывать шаги к уже существующим значило бы удваивать их
 * при любом повторном вызове, а порядковые номера уникальны — вторая
 * попытка просто упала бы.
 */
/**
 * Срезает нумерацию, которую модель приписывает к шагу.
 *
 * Найдено ручным прогоном 01.09.2026: в базе лежало
 * `[. Определить дату дня рождения]`, и человек видел «— . Решить, где
 * праздновать» в каждой строке. Модель отдаёт шаги пронумерованными,
 * цифра теряется по дороге, точка остаётся.
 *
 * **Срезается образец, а не любые цифры и знаки.** «2 торта купить» —
 * законный шаг, и жадное правило превратило бы его в «торта купить».
 * Поэтому убираются только «1.», «1)», одиночная точка или тире в начале.
 */
function withoutNumbering(text: string): string {
  return text.replace(/^\s*(?:\d+\s*[.)]|[.)\-–—•*])\s*/u, '').trim();
}

export async function saveSteps(db: Executor, params: SaveStepsParams): Promise<ProjectStep[]> {
  const texts = params.texts.map(withoutNumbering).filter((text) => text.length > 0);
  if (texts.length === 0) return [];

  return await db
    .insert(projectSteps)
    .values(
      texts.map((text, index) => ({
        itemId: params.itemId,
        userId: params.userId,
        text,
        position: index,
      })),
    )
    .onConflictDoNothing()
    .returning();
}

export type StepOutcome =
  /** Шаг закрыт, ближайшим стал следующий. */
  | { readonly kind: 'done'; readonly next: ProjectStep | undefined }
  /** Шага нет или он чужой. */
  | { readonly kind: 'gone' }
  /**
   * Шаг уже был закрыт: повторное нажатие ничего не меняет.
   *
   * Ближайший отдаётся и здесь (задача 3.82): повторное нажатие по
   * кнопке, оставшейся в переписке, обязано ответить то же, что первое,
   * а не промолчать. Иначе человек решает, что кнопка сломалась.
   */
  | { readonly kind: 'already'; readonly next: ProjectStep | undefined };

/**
 * Закрывает шаг.
 *
 * Владелец проверяется вместе с идентификатором: код шага приходит из
 * нажатия, то есть снаружи.
 */
export async function completeStep(
  db: Executor,
  params: { readonly stepId: string; readonly userId: string; readonly now?: Date | undefined },
): Promise<StepOutcome> {
  const [step] = await db
    .select()
    .from(projectSteps)
    .where(and(eq(projectSteps.id, params.stepId), eq(projectSteps.userId, params.userId)))
    .limit(1);

  if (!step) return { kind: 'gone' };
  if (step.doneAt !== null) return { kind: 'already', next: await nextStepOf(db, step.itemId) };

  const now = params.now ?? new Date();

  await db.update(projectSteps).set({ doneAt: now }).where(eq(projectSteps.id, step.id));

  /**
   * Закрытый шаг — движение по проекту (ревизия этапа 3, G2).
   *
   * «Нет движения» планировщик считает по `updatedAt` записи, а шаги
   * жили только в своей таблице: человек закрывал шаг за шагом, а бот
   * каждые пять дней спрашивал «как там ремонт?» — как будто месяц
   * ничего не делала. Одно число одним способом: движение — это
   * `updatedAt`, и шаг его двигает.
   */
  await db.update(items).set({ updatedAt: now }).where(eq(items.id, step.itemId));

  return { kind: 'done', next: await nextStepOf(db, step.itemId) };
}

/**
 * Пора ли напомнить о проекте (§11 ТЗ, задача 3.13).
 *
 * «Если по проекту нет движения 7 дней, один вопрос про ближайший шаг,
 * не чаще раза в 5 дней.»
 *
 * Чистая функция: решение зависит от трёх дат и ни от чего больше, а
 * проверять его надо таблицей, а не поднятым планировщиком.
 *
 * **Кто её позовёт, пока некому.** Планировщик — задача 3.14; до него
 * напоминание не приходит, и это записано в плане, а не спрятано. Логика
 * при этом готова и проверена: когда появится тот, кто ходит по часам,
 * добавлять к ней будет нечего.
 */
export const PROJECT_STALE_DAYS = 7;
export const PROJECT_NUDGE_COOLDOWN_DAYS = 5;

const DAY_MS = 24 * 60 * 60_000;

export function nudgeDue(params: {
  /** Когда по проекту в последний раз что-то происходило. */
  readonly lastMovedAt: Date;
  /** Когда о нём в последний раз спрашивали. Не спрашивали — пусто. */
  readonly lastNudgeAt?: Date | undefined;
  /** Есть ли ещё незакрытые шаги: у законченного спрашивать нечего. */
  readonly hasNext: boolean;
  readonly now: Date;
}): boolean {
  if (!params.hasNext) return false;

  const idle = params.now.getTime() - params.lastMovedAt.getTime();
  if (idle < PROJECT_STALE_DAYS * DAY_MS) return false;

  if (params.lastNudgeAt === undefined) return true;

  const since = params.now.getTime() - params.lastNudgeAt.getTime();
  return since >= PROJECT_NUDGE_COOLDOWN_DAYS * DAY_MS;
}
