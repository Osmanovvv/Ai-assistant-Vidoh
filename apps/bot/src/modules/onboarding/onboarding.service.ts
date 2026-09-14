import { eq } from 'drizzle-orm';

import { userSettings, users } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { dropPending } from '../scheduler/reminders.repo.js';

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
 * значило бы вернуть ту же развилку, а поменять имя можно в настройках —
 * кнопка «Имя» на экране §12.1 (`bot/handlers/menu.ts`). Прежде здесь
 * стояла ссылка на задачу 4.9, но 4.9 оказалась про админку заказчицы, а
 * не про человека: обещание жило в коде без владельца, пока его не нашла
 * ревизия второго этапа.
 *
 * **Один вопрос в реплике** — §13.9. Поэтому шаги идут по одному, каждый
 * своей репликой, и ответ на предыдущий правит ту же реплику.
 */

/**
 * Шаги по порядку. Ноль — не начинался, последний плюс один — закончен.
 *
 * До 14.09.2026 пятым шёл вопрос «какие сферы важны», а «закончен» был
 * шестым. Заказчица шаг убрала (её правка, п. 1.1: сферы — внутренняя
 * организация бота, он заводит их по содержанию сам); миграция 0053
 * перевела прежние 5 и 6 в 5.
 */
export const STEP = {
  name: 1,
  timezone: 2,
  morning: 3,
  evening: 4,
  done: 5,
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
  /** «Напишу своё» — дальше ответ приходит сообщением (задача 3.61). */
  nameOwn: 'onb:name:own',
  morningOwn: 'onb:morning:own',
  eveningOwn: 'onb:evening:own',
  timezoneMoscow: 'onb:tz:msk',
  timezoneOther: 'onb:tz:other',
  /** «Напишу город» — дальше название приходит сообщением (3.70). */
  timezoneOwn: 'onb:tz:own',
  /** `onb:tz:zone:Asia/Omsk` — 26 байт, лимит callback_data 64. */
  timezonePrefix: 'onb:tz:zone:',
  morningPrefix: 'onb:morning:',
  eveningPrefix: 'onb:evening:',
  eveningOff: 'onb:evening:off',
} as const;

export interface QuestionContext {
  readonly texts: TextProfile;
  readonly name: string;
  /**
   * Это первый вопрос опроса — к нему добавляется рамка.
   *
   * Ставит тот, кто опрос начинает: обработчик `/start` или конвейер,
   * если человек заговорил, не нажимая ничего. Сам `questionFor` этого
   * знать не может — его зовут и на переспрос.
   */
  readonly opening?: boolean | undefined;
}

/**
 * Есть ли в имени хоть одна буква.
 *
 * Имя приходит от Telegram, и там бывает что угодно: пусто, точка, одни
 * эмодзи, «·». Подтверждать в таком имени нечего — вопрос «называть тебя
 * .?» выглядит как сбой, а не как знакомство. Проверка на пустоту это не
 * ловила: у живого человека 27.08.2026 имя оказалось одной точкой, и бот
 * спросил ровно так.
 */
function hasLetters(name: string): boolean {
  return /\p{L}/u.test(name);
}

/**
 * С какого шага начинать. Всегда с имени (правка заказчика 04.09.2026).
 *
 * **Раньше человека с именем без букв не спрашивали вовсе**, и шаг
 * пропускался. Довод был верен для своего времени: написать своё имя было
 * нельзя, и единственным исходом оставался вопрос «Называть тебя .?» —
 * а он читается как сбой, а не как знакомство.
 *
 * С задачи 3.61 своё имя написать можно, и правило перевернулось: человек
 * с точкой в профиле стал единственным, у кого имени не спрашивают
 * никогда. Заказчик заметил это на своём же аккаунте: «какая разница,
 * вдруг человек хочет, чтобы его называли ","».
 *
 * Спрашиваем всех. Что именно спросить — решает `questionFor`: с именем
 * из профиля его подтверждают, без имени спрашивают прямо.
 */
export function firstStep(_name: string): StepNumber {
  return STEP.name;
}

export function questionFor(step: number, context: QuestionContext): Question | undefined {
  const { texts, name } = context;
  const onboarding = texts.onboarding;

  /** Рамка перед первым вопросом: см. `opening` в контексте. */
  const framed = (text: string): string =>
    context.opening === true
      ? `${onboarding.opening}

${text}`
      : text;

  switch (step) {
    case STEP.name:
      /**
       * Имя из профиля годится в вопрос — подтверждаем его.
       *
       * Не годится (пусто, точка, одни знаки) — спрашиваем прямо, не
       * показывая человеку его же непригодное имя. Кнопка «Напишу своё»
       * там единственный способ ответить, поэтому «Да» в этом случае
       * нет: подтверждать нечего.
       */
      if (!hasLetters(name)) {
        return {
          text: framed(onboarding.nameUnknown),
          rows: [
            [
              { label: onboarding.buttonNameOwn, action: ACTION.nameOwn },
              { label: onboarding.buttonNameSkip, action: ACTION.nameLater },
            ],
          ],
        };
      }

      /**
       * Три кнопки в два ряда, а не в один (задача 3.61).
       *
       * «Напишу своё» рядом с «Да» и «Поправлю потом» в одну строку не
       * влезает на телефоне: подписи обрезаются, и человек не понимает,
       * что ему предлагают.
       */
      return {
        text: framed(onboarding.nameConfirm(name)),
        rows: [
          [
            { label: onboarding.buttonNameYes, action: ACTION.nameYes },
            { label: onboarding.buttonNameOwn, action: ACTION.nameOwn },
          ],
          [{ label: onboarding.buttonNameLater, action: ACTION.nameLater }],
        ],
      };

    case STEP.timezone:
      return {
        text: framed(onboarding.timezoneMoscow),
        rows: [
          [
            { label: onboarding.buttonTimezoneMoscow, action: ACTION.timezoneMoscow },
            { label: onboarding.buttonTimezoneOther, action: ACTION.timezoneOther },
          ],
        ],
      };

    case STEP.morning:
      return {
        text: framed(onboarding.morning),
        rows: [
          MORNING_TIMES.map((time) => ({
            label: time,
            action: `${ACTION.morningPrefix}${time}`,
          })),
          // Четыре круглых часа закрывают большинство, но не всех: кому
          // нужно 7:30, тот пишет словами (задача 3.61).
          [{ label: onboarding.buttonTimeOwn, action: ACTION.morningOwn }],
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
          [
            { label: onboarding.buttonTimeOwn, action: ACTION.eveningOwn },
            { label: onboarding.buttonEveningOff, action: ACTION.eveningOff },
          ],
        ],
      };

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

  /**
   * «Напишу город» — последней строкой (задача 3.70).
   *
   * Замечание проджекта: «Другой город не выбирается, как ввести к примеру
   * Краснодар». Кнопок одиннадцать, и это не города, а все часовые пояса
   * России; он искал свой город и не нашёл. Теперь можно ответить так, как
   * человек думает — названием своего города.
   *
   * Внизу, а не вверху: одиннадцать кнопок закрывают страну целиком, и
   * большинству хватит их. Название — путь для того, кто не нашёл себя.
   */
  rows.push([{ label: texts.onboarding.buttonCityOwn, action: ACTION.timezoneOwn }]);

  return { text: texts.onboarding.timezoneChoose, rows };
}

/**
 * Название пояса словами: «Europe/Moscow» → «Москва».
 *
 * Нужно, чтобы сказать человеку, какое время выбрано: справочник городов
 * может быть неполон или устареть, и выбор он должен увидеть.
 */
export function cityOfZone(zone: string): string | undefined {
  return TIMEZONES.find((item) => item.zone === zone)?.city;
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
      preferred: userSettings.preferredName,
      profile: userSettings.textProfile,
    })
    .from(userSettings)
    .innerJoin(users, eq(users.id, userSettings.userId))
    .where(eq(userSettings.userId, userId))
    .limit(1);

  /**
   * Имя, названное человеком, сильнее имени из Telegram (задача 3.61).
   *
   * И хранится отдельно не для порядка: `upsertUser` перезаписывает
   * `users.first_name` тем, что пришло от Telegram, на каждом сообщении.
   */
  const preferred = row?.preferred?.trim() ?? '';

  return {
    step: row?.step ?? STEP.done,
    // Имя из Telegram может отсутствовать: у части аккаунтов его нет.
    name: preferred === '' ? (row?.firstName?.trim() ?? '') : preferred,
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

  /**
   * Разложенное по прежнему поясу снимается (ревизия этапа 3, D11).
   *
   * Иначе после переезда утреннее приходило в 15:30 по новому времени, а
   * в 08:30 — ничего: ключ дня был занят старым заданием. То же, что у
   * `setMorning`: настройка обязана действовать сразу.
   */
  await dropPending(db, userId);

  return {
    from: before?.zone ?? 'Europe/Moscow',
    to: zone,
    firstConfirmation: before?.confirmed !== true,
  };
}

/**
 * Выбранное время вступает в силу сразу, а не через сутки (задача 3.26).
 *
 * **Найдено ручным прогоном на боевом 01.09.2026.** Человек выбрал утро
 * 09:00, а задание в `reminders` осталось на 08:30 — значение по
 * умолчанию. Причина в порядке: онбординг идёт **после** первой выгрузки
 * (§12.2), а планировщик к этому времени уже разложил ближайшие полтора
 * суток по прежним настройкам. `storePlanned` вставляет через
 * `onConflictDoNothing`, поэтому существующую строку новое время не
 * заменяет.
 *
 * Человеку это видно один раз и необъяснимо: первое напоминание приходит
 * не тогда, когда он попросил, а дальше всё верно.
 *
 * **Снятие стоит здесь, а не в обработчике, и это решение.** В `menu.ts`
 * оно вызывается руками после каждого переключателя §11 — и ровно так же
 * руками его забыли позвать здесь. Пока снятие живёт внутри самой
 * установки, забыть его нельзя.
 */
export async function setMorning(db: Executor, userId: string, time: string): Promise<void> {
  await db
    .update(userSettings)
    .set({ morningTime: time, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));

  await dropPending(db, userId);
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

  // То же, что у утреннего: см. `setMorning`.
  await dropPending(db, userId);
}
