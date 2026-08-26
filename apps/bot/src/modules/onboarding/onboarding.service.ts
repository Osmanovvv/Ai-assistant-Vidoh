import { eq } from 'drizzle-orm';

import { userSettings, users } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { createTopics, DEFAULT_TOPIC_NAMES, FALLBACK_TOPIC } from '../topics/topics.repo.js';

/**
 * Онбординг (задача 2.13).
 *
 * §12.2 ТЗ: запускается **после** первой выгрузки, не до неё. Первый экран
 * §13.1 — это приветствие и две кнопки, и никаких вопросов, пока человек
 * не наговорил. Поэтому онбординг это не «регистрация», а несколько
 * вопросов задним числом.
 *
 * В ТЗ он не назван ни в одном этапе плана работ, хотя несущий: без
 * списка тем не работает классификация, без пояса неверны все сроки, без
 * времени напоминаний планировщик третьего этапа не знает, когда писать.
 *
 * **Весь онбординг на кнопках, ни одного свободного ответа.** Причина не
 * в удобстве: свободный ответ приходит обычным сообщением и попадает в
 * буфер выгрузки. Пришлось бы либо угадывать, ответ это или новая мысль,
 * — и однажды угадать неверно, потеряв мысль или записав в имя «надо
 * купить продукты», — либо перехватывать все сообщения, пока онбординг
 * открыт, и тогда терялась бы выгрузка. Кнопки убирают выбор совсем.
 *
 * Отсюда же решение по имени: берётся то, что уже дал Telegram, и
 * подтверждается кнопкой. Спросить «как тебя называть» свободным текстом
 * значило бы вернуть ту же развилку, а поменять имя можно будет в
 * настройках (задача 4.9).
 *
 * **Один вопрос в реплике** — §13.9. Поэтому шаги идут по одному, каждый
 * своей репликой, и ответ на предыдущий правит ту же реплику.
 */

/** Шаги по порядку. Ноль — не начинался, последний плюс один — закончен. */
export const STEP = {
  name: 1,
  timezone: 2,
  morning: 3,
  evening: 4,
  topics: 5,
  done: 6,
} as const;

export type StepNumber = (typeof STEP)[keyof typeof STEP];

/**
 * Пояса России по городам.
 *
 * Список закрытый и по городам, а не по смещениям: «UTC+7» человеку ни о
 * чём не говорит, а «Красноярск» говорит. Названия зон системные — `Intl`
 * знает по ним все переходы, и своя таблица была бы устаревшей копией.
 */
export const TIMEZONES: readonly { readonly city: string; readonly zone: string }[] = [
  { city: 'Калининград', zone: 'Europe/Kaliningrad' },
  { city: 'Москва', zone: 'Europe/Moscow' },
  { city: 'Самара', zone: 'Europe/Samara' },
  { city: 'Екатеринбург', zone: 'Asia/Yekaterinburg' },
  { city: 'Омск', zone: 'Asia/Omsk' },
  { city: 'Красноярск', zone: 'Asia/Krasnoyarsk' },
  { city: 'Иркутск', zone: 'Asia/Irkutsk' },
  { city: 'Якутск', zone: 'Asia/Yakutsk' },
  { city: 'Владивосток', zone: 'Asia/Vladivostok' },
  { city: 'Магадан', zone: 'Asia/Magadan' },
  { city: 'Камчатка', zone: 'Asia/Kamchatka' },
];

/** Варианты времени. Четыре кнопки — выбор в один тап, а не в три. */
export const MORNING_TIMES = ['07:00', '08:00', '09:00', '10:00'] as const;
export const EVENING_TIMES = ['20:00', '21:00', '22:00'] as const;

/**
 * Сферы на выбор: базовый набор §6.4 плюс те, что чаще всего называют
 * отдельно. Автоматически создавать темы §6.4 запрещает, поэтому здесь
 * только предложение, а решает человек.
 */
export const TOPIC_CHOICES = [
  'семья',
  'здоровье',
  'работа',
  'покупки',
  'дом',
  'дети',
  'деньги',
  'учёба',
  'личное',
] as const;

export interface Button {
  readonly label: string;
  readonly action: string;
}

export interface Question {
  readonly text: string;
  /** Ряды кнопок: внешний массив — строки клавиатуры. */
  readonly rows: readonly (readonly Button[])[];
}

export const ACTION = {
  nameYes: 'onb:name:yes',
  nameLater: 'onb:name:later',
  timezoneMoscow: 'onb:tz:msk',
  timezoneOther: 'onb:tz:other',
  /** `onb:tz:zone:Asia/Omsk` — 26 байт, лимит callback_data 64. */
  timezonePrefix: 'onb:tz:zone:',
  morningPrefix: 'onb:morning:',
  eveningPrefix: 'onb:evening:',
  eveningOff: 'onb:evening:off',
  topicPrefix: 'onb:topic:',
  topicsDone: 'onb:topics:done',
} as const;

export interface QuestionContext {
  readonly texts: TextProfile;
  readonly name: string;
  /** Уже отмеченные сферы: состояние живёт в клавиатуре самой реплики. */
  readonly chosen?: readonly string[] | undefined;
}

/**
 * С какого шага начинать.
 *
 * Имя приходит от Telegram, но у части аккаунтов его нет — поле в базе
 * пустое. Подтверждать нечего, а вопрос «называть тебя ?» хуже, чем его
 * отсутствие, поэтому такой человек начинает сразу с пояса.
 */
export function firstStep(name: string): StepNumber {
  return name.trim() === '' ? STEP.timezone : STEP.name;
}

export function questionFor(step: number, context: QuestionContext): Question | undefined {
  const { texts, name } = context;
  const onboarding = texts.onboarding;

  switch (step) {
    case STEP.name:
      // Подтверждать нечего: см. firstStep.
      if (name.trim() === '') return undefined;

      return {
        text: onboarding.nameConfirm(name),
        rows: [
          [
            { label: onboarding.buttonNameYes, action: ACTION.nameYes },
            { label: onboarding.buttonNameLater, action: ACTION.nameLater },
          ],
        ],
      };

    case STEP.timezone:
      return {
        text: onboarding.timezoneMoscow,
        rows: [
          [
            { label: onboarding.buttonTimezoneMoscow, action: ACTION.timezoneMoscow },
            { label: onboarding.buttonTimezoneOther, action: ACTION.timezoneOther },
          ],
        ],
      };

    case STEP.morning:
      return {
        text: onboarding.morning,
        rows: [
          MORNING_TIMES.map((time) => ({
            label: time,
            action: `${ACTION.morningPrefix}${time}`,
          })),
        ],
      };

    case STEP.evening:
      return {
        text: onboarding.evening,
        rows: [
          EVENING_TIMES.map((time) => ({
            label: time,
            action: `${ACTION.eveningPrefix}${time}`,
          })),
          [{ label: onboarding.buttonEveningOff, action: ACTION.eveningOff }],
        ],
      };

    case STEP.topics:
      return { text: onboarding.topics, rows: topicRows(texts, context.chosen ?? []) };

    default:
      return undefined;
  }
}

/** Города по три в ряд: длинный столбец из одиннадцати кнопок неудобен. */
export function timezoneQuestion(texts: TextProfile): Question {
  const rows: Button[][] = [];

  for (let index = 0; index < TIMEZONES.length; index += 3) {
    rows.push(
      TIMEZONES.slice(index, index + 3).map((item) => ({
        label: item.city,
        action: `${ACTION.timezonePrefix}${item.zone}`,
      })),
    );
  }

  return { text: texts.onboarding.timezoneChoose, rows };
}

/**
 * Клавиатура выбора сфер. Отмеченные помечаются галочкой в подписи, и
 * это же служит хранилищем: состояние выбора живёт в самой реплике, а не
 * в базе. Так оно не теряется при перезапуске и не требует колонки.
 */
export function topicRows(
  texts: TextProfile,
  chosen: readonly string[],
): readonly (readonly Button[])[] {
  const marked = new Set(chosen);
  const rows: Button[][] = [];

  for (let index = 0; index < TOPIC_CHOICES.length; index += 3) {
    rows.push(
      TOPIC_CHOICES.slice(index, index + 3).map((name) => ({
        label: marked.has(name) ? texts.onboarding.topicChosen(name) : name,
        action: `${ACTION.topicPrefix}${name}`,
      })),
    );
  }

  rows.push([{ label: texts.onboarding.buttonTopicsDone, action: ACTION.topicsDone }]);

  return rows;
}

/** Обратно из подписи: галочка — признак выбора. */
export function chosenFromLabels(labels: readonly string[], texts: TextProfile): string[] {
  const chosen: string[] = [];

  for (const name of TOPIC_CHOICES) {
    if (labels.includes(texts.onboarding.topicChosen(name))) chosen.push(name);
  }

  return chosen;
}

export interface OnboardingState {
  readonly step: number;
  readonly name: string;
  readonly texts: TextProfile;
}

/** Состояние онбординга и всё, что нужно вопросу. Одним запросом. */
export async function onboardingStateOf(db: Executor, userId: string): Promise<OnboardingState> {
  const [row] = await db
    .select({
      step: userSettings.onboardingStep,
      firstName: users.firstName,
      profile: userSettings.textProfile,
    })
    .from(userSettings)
    .innerJoin(users, eq(users.id, userSettings.userId))
    .where(eq(userSettings.userId, userId))
    .limit(1);

  return {
    step: row?.step ?? STEP.done,
    // Имя из Telegram может отсутствовать: у части аккаунтов его нет.
    name: row?.firstName?.trim() ?? '',
    texts: textsFor(row?.profile),
  };
}

export async function setStep(db: Executor, userId: string, step: number): Promise<void> {
  await db
    .update(userSettings)
    .set({ onboardingStep: step, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

export async function finish(db: Executor, userId: string, at: Date): Promise<void> {
  await db
    .update(userSettings)
    .set({ onboardingStep: STEP.done, onboardingDoneAt: at, updatedAt: at })
    .where(eq(userSettings.userId, userId));
}

export interface TimezoneChange {
  readonly from: string;
  readonly to: string;
  /**
   * Пояс подтверждён впервые.
   *
   * По этому признаку задача 2.14 решает, пересчитывать ли сроки. Только
   * при первом подтверждении: если человек потом переедет и сменит пояс в
   * настройках, сдвигать старые сроки нельзя — они были верны, когда он
   * их называл. Разница между «мы угадали неверно» и «человек переехал»
   * принципиальная.
   */
  readonly firstConfirmation: boolean;
}

export async function setTimezone(
  db: Executor,
  userId: string,
  zone: string,
): Promise<TimezoneChange> {
  const [before] = await db
    .select({ zone: users.timezone, confirmed: users.timezoneConfirmed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  await db
    .update(users)
    .set({ timezone: zone, timezoneConfirmed: true })
    .where(eq(users.id, userId));

  return {
    from: before?.zone ?? 'Europe/Moscow',
    to: zone,
    firstConfirmation: before?.confirmed !== true,
  };
}

export async function setMorning(db: Executor, userId: string, time: string): Promise<void> {
  await db
    .update(userSettings)
    .set({ morningTime: time, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

export async function setEvening(db: Executor, userId: string, time: string | null): Promise<void> {
  await db
    .update(userSettings)
    .set(
      time === null
        ? // «Не надо вечером» выключает вечернее и только его. Общий
          // выключатель здесь трогать нельзя: человек просил не писать
          // вечером, а не молчать вовсе.
          { eveningOn: false, updatedAt: new Date() }
        : { eveningTime: time, eveningOn: true, updatedAt: new Date() },
    )
    .where(eq(userSettings.userId, userId));
}

export interface TopicsResult {
  readonly created: number;
  /** Человек не выбрал ничего, взят базовый набор §6.4. */
  readonly fallback: boolean;
}

/**
 * Создаёт темы по выбору человека.
 *
 * Ничего не выбрано — берётся базовый набор §6.4. Оставить человека без
 * тем нельзя: классификация без списка не работает, а спорить с ним,
 * заставляя выбрать, значит превращать разгрузку в анкету.
 */
export async function createChosenTopics(
  db: Executor,
  userId: string,
  chosen: readonly string[],
): Promise<TopicsResult> {
  const names = chosen.length > 0 ? chosen : [...DEFAULT_TOPIC_NAMES];

  // Тема по умолчанию нужна §6.4: туда уходит всё, что не подошло ни к
  // одной. Если человек не выбрал «личное», ею становится последняя.
  const withDefault = names.includes(FALLBACK_TOPIC) ? names : [...names, FALLBACK_TOPIC];

  const created = await createTopics(
    db,
    userId,
    withDefault.map((name) => ({ name, isDefault: name === FALLBACK_TOPIC })),
  );

  return { created, fallback: chosen.length === 0 };
}
