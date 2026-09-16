import { toShortId } from '../shared/short-id.js';
import type { ItemType } from '../ai/schemas/index.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import type { DumpSummary } from './summary.js';

/**
 * Ответ на выгрузку (задача 2.11).
 *
 * §13.2 ТЗ задаёт форму: признание одной фразой, ограниченный список
 * действий, одна фраза о том, что остальное сохранено, ровно один вопрос,
 * кнопки. Раздел прямо назван частью требований, а не рекомендацией по
 * стилю, поэтому форма собирается кодом и проверяется тестами.
 *
 * **Модель пишет здесь одну фразу — признание.** Всё остальное код:
 * список даёт фильтр выдачи (2.10), вопрос и кнопки лежат в словаре.
 * Причина та же, по которой фильтр — не модель: собранный моделью ответ
 * плавал бы между запусками, и критерии приёмки 1 и 7 стали бы
 * непроверяемыми. А вопрос, придуманный моделью, однажды окажется в
 * реплике вторым, что запрещает §13.9.
 *
 * **Признание проверяется, а не принимается на веру.** §13.7 — прямое
 * требование заказчика: бот не работает терапевтом. Промпт об этом
 * просит, но промпт — просьба. Единственный кусок ответа, который пишет
 * модель, проходит проверку, и при нарушении заменяется нейтральной
 * фразой из словаря. Нейтральное признание хуже удачного, но лучше
 * запрещённого.
 *
 * **Отказ модели не отменяет ответ.** Признание — украшение, а список
 * действий — суть. Если модель недоступна или ответила мимо схемы,
 * реплика уходит с фразой из словаря: человек ждёт разбор, а не
 * извинения.
 */

/**
 * Обратные вызовы кнопок под ответом (§13.2 ТЗ).
 *
 * Кнопки строились здесь с самого начала, а до человека не доходили:
 * отправитель статусного сообщения клавиатуру не умел, и обработчиков
 * для этих строк не было. Нашлось сверкой с ТЗ 28.08.2026 — и оказалось
 * тем самым, из-за чего человек не понимал, куда делись остальные дела.
 */
export const ANSWER_ACTION = {
  /** «Сделать сейчас» — ведёт в режим выполнения. */
  now: 'answer:now',
  /** «Разобрать все» — полный бэклог по темам. */
  all: 'answer:all',
  /** «Оставить на потом» — закрывает сессию без упреков. */
  later: 'answer:later',
  /**
   * Под разбором (решение заказчицы 15.09.2026): «Оставить как есть» —
   * дел не показывать; «Выбрать главное» (`answer:pick:<код выгрузки>`)
   * — показать 2–3 самых актуальных.
   */
  keep: 'answer:keep',
  pick: 'answer:pick',
} as const;

export interface ReplyButton {
  readonly label: string;
  readonly action: string;
}

export interface Reply {
  readonly text: string;
  readonly buttons: readonly ReplyButton[];
}

/** Состав выгрузки — то, что признание называет одной фразой. */
export interface DumpComposition {
  readonly tasks: number;
  readonly desires: number;
  readonly ideas: number;
  readonly infos: number;
  readonly emotions: number;
  /** §13.2: большая цель упоминается отдельно от обычных дел. */
  readonly hasProject: boolean;
}

export function composeOf(
  items: readonly { readonly type: ItemType; readonly isProject?: boolean }[],
): DumpComposition {
  const count = (type: ItemType): number => items.filter((item) => item.type === type).length;

  return {
    tasks: count('TASK'),
    desires: count('DESIRE'),
    ideas: count('IDEA'),
    infos: count('INFO'),
    emotions: count('EMOTION'),
    hasProject: items.some((item) => item.type === 'TASK' && item.isProject === true),
  };
}

export interface BuildReplyParams {
  readonly texts: TextProfile;
  /** Признание — уже проверенное. Проверку делает `sanitizeAcknowledgement`. */
  readonly acknowledgement: string;
  /**
   * Выгрузка, под которой стоит ответ: код едет в кнопке «Выбрать
   * главное», чтобы обработчик поставил сказанное в ней вперёд (3.24).
   * Пусто — общее действие без кода.
   */
  readonly batchId?: string | undefined;
  /**
   * Впереди уже стоит вопрос — опроса или уточнения: своего ответ не
   * задаёт (§13.9: один вопрос на обмен), кнопки остаются.
   */
  readonly omitQuestion?: boolean | undefined;
  /** Раскладка по сферам и сроки на сегодня/завтра (п. 3, 16.09.2026). */
  readonly summary?: DumpSummary | undefined;
  /**
   * В выгрузке одни чувства, новых дел нет (правка заказчицы
   * 14.09.2026, п. 1.5). Ответ — одно признание: без вопроса и кнопок.
   */
  readonly feelingsOnly?: boolean | undefined;
}

/**
 * Собирает ответ на выгрузку. Чистая функция: ни модели, ни базы, ни
 * времени — иначе форму ответа нельзя проверить таблицей случаев.
 *
 * **Дел в ответе нет — по решению заказчицы 15.09.2026.** §13.2 её ТЗ
 * показывал под признанием до трёх дел и спрашивал «с чего начнём»; она
 * это отменила: «после разбора действия автоматически не показываем;
 * сначала результат разбора и кнопки „Оставить как есть“ / „Выбрать
 * главное“; только по „Выбрать главное“ — 2–3 пункта». Результат
 * разбора — само признание: оно называет состав выгрузки (промпт
 * презентера). Список по кнопке собирает `buildActionsReply`.
 */
/** От скольких дел выгрузка считается длинной — и закрывается с 🤍. */
export const LONG_DUMP_TASKS = 5;

export function buildReply(params: BuildReplyParams): Reply {
  const { texts } = params;
  const answer = texts.answer;

  /**
   * Одни чувства — только признание (правка заказчицы 14.09.2026,
   * п. 1.5; продолжение решения 13.09.2026, ответ 1.4): «не пытаемся
   * превращать эмоциональную выгрузку в продуктивность… отвечаем коротко
   * и спокойно». Кнопки к делам — то самое превращение, только вежливое.
   * Кризис сюда не доходит: остановлен раньше своим сценарием.
   */
  if (params.feelingsOnly === true) {
    // Поделилась личным — одна фраза её словами, с 🤍 (16.09.2026).
    return { text: answer.feelingsOnly, buttons: [] };
  }

  /**
   * Одно компактное сообщение по образцам заказчицы (16.09.2026): открытие
   * со счётом, сферы с числами, что на сегодня и на завтра — и вопрос
   * «Оставить как есть или выбрать главное?», которым кончается её образец
   * тона. Впереди уже есть вопрос (опрос, уточнение) — своего нет: §13.9,
   * один вопрос на обмен.
   */
  const lines: string[] = [params.acknowledgement];

  const spheres = (params.summary?.spheres ?? []).map((sphere) => {
    const name = sphere.name.charAt(0).toUpperCase() + sphere.name.slice(1);
    const line = answer.sphereLine(name, String(sphere.count));
    return sphere.icon === undefined ? line : `${sphere.icon} ${line}`;
  });
  if (spheres.length > 0) lines.push('', ...spheres);

  const inline = (items: readonly string[]): string =>
    items.map((text) => text.charAt(0).toLowerCase() + text.slice(1)).join(', ');
  const today = params.summary?.today ?? [];
  const tomorrow = params.summary?.tomorrow ?? [];
  const due: string[] = [];
  if (today.length > 0) due.push(answer.dueToday(inline(today)));
  if (tomorrow.length > 0) due.push(answer.dueTomorrow(inline(tomorrow)));
  if (due.length > 0) lines.push('', ...due);

  if (params.omitQuestion !== true) lines.push('', answer.keepOrPick);

  const pick =
    params.batchId === undefined
      ? ANSWER_ACTION.pick
      : `${ANSWER_ACTION.pick}:${toShortId(params.batchId)}`;

  return {
    text: lines.join('\n'),
    buttons: [
      { label: answer.buttonKeep, action: ANSWER_ACTION.keep },
      { label: answer.buttonPick, action: pick },
    ],
  };
}

export interface ActionsReplyParams {
  readonly texts: TextProfile;
  /** Заголовки дел из фильтра выдачи, в его порядке. */
  readonly actions: readonly string[];
  /**
   * Первое показанное дело — к нему ведёт «Сделать сейчас» (ревизия
   * этапа 3, E2).
   *
   * Список строится очередью выдачи с упомянутым в выгрузке, а «Сегодня»
   * — другой очередью; без кода кнопка открывала «первое на сегодня»,
   * которого в показанном списке могло не быть, и отвечала «На сегодня
   * ничего срочного» под только что показанными делами. Пусто — у
   * кнопки нет своего дела, и она ведёт к первому на сегодня.
   */
  readonly firstItemId?: string | undefined;
  /** Сколько дел осталось за пределами выдачи. */
  readonly hidden: number;
}

/**
 * Список по кнопке «Выбрать главное» (решение заказчицы 15.09.2026) —
 * прежняя выдача §13.2: подводка, до трёх дел, фраза о сохранённом, три
 * кнопки. Вопроса нет: его человек уже получил кнопками и ответил.
 */
export function buildActionsReply(params: ActionsReplyParams): Reply {
  const { texts, actions, hidden } = params;
  const answer = texts.answer;

  if (actions.length === 0) return { text: answer.nothingToPick, buttons: [] };

  const lines: string[] = [
    actions.length === 1 ? answer.actionsLeadSingle : answer.actionsLead,
    ...actions.map((text) => answer.bullet(text)),
    '',
    hidden > 0 ? answer.restSaved : answer.nothingHidden,
  ];

  const doNow = {
    label: answer.buttonDoNow,
    action:
      params.firstItemId === undefined
        ? ANSWER_ACTION.now
        : `${ANSWER_ACTION.now}:${toShortId(params.firstItemId)}`,
  };

  return {
    text: lines.join('\n'),
    buttons: [
      doNow,
      { label: answer.buttonShowAll, action: ANSWER_ACTION.all },
      { label: answer.buttonLater, action: ANSWER_ACTION.later },
    ],
  };
}

/*
  Правило §13 по содержанию живёт в `texts/rules.ts`, а здесь зовётся.

  Причина — редактор текстов в панели (§13.9: тексты меняются без
  выкладки). Правку заказчицы надо проверять в момент сохранения тем же
  правилом, которым проверяется ответ модели, — значит у правила должен
  быть один дом, и это дом словаря, а не презентера.

  Сначала переехал только список запретов §13.7, а остальное правило
  здесь переписывалось своими словами — и одна проверка потерялась:
  серию восклицательных отвергала панель и ловил тест словаря, а
  признание от модели — единственный текст ответа, который пишем не мы,
  — уходило человеку с «Услышала!!». Найдено ревизией второго этапа.
*/

/**
 * Признание — из состава, кодом (заказчица, 16.09.2026).
 *
 * До этого признание просилось у модели (presenter@1) и проверялось
 * правилами §13; на видео заказчицы модель сказала «У тебя шесть дел,
 * все обычные», и она ответила: «достаточно сразу: „Я тебя услышала.
 * У тебя шесть дел"». Ровно это и собирается — без вызова, без расхода и
 * без сюрпризов в формулировке. Тон усталости остаётся словарным
 * (§13.7), счёт дел — цифрой и со склонением, как в её образце от
 * 16.09.2026 («Записала 6 дел»): 1 дело, 2 дела, 5 дел.
 */
function tasksPhrase(count: number): string {
  const number = String(count);
  const tail = count % 100;
  const last = count % 10;
  const noun =
    tail >= 11 && tail <= 14
      ? 'дел'
      : last === 1
        ? 'дело'
        : last >= 2 && last <= 4
          ? 'дела'
          : 'дел';

  return `${number} ${noun}`;
}

export function acknowledgementOf(composition: DumpComposition, texts: TextProfile): string {
  /**
   * Открытие — по её тексту о характере (16.09.2026): «Всё, забрала».
   * Длинная выгрузка (от пяти дел) — с фирменным 🤍 в этой же строке;
   * при высказанном состоянии — спокойнее и без сердечка: «серьёзная
   * усталость — никаких шуточек, которые могут обесценить».
   */
  const opening =
    composition.emotions > 0
      ? texts.answer.acknowledgementTiredFallback
      : composition.tasks >= LONG_DUMP_TASKS
        ? texts.answer.acknowledgementLong
        : texts.answer.acknowledgementFallback;

  if (composition.tasks <= 0) return opening;

  return `${opening} ${texts.answer.acknowledgementTasks(tasksPhrase(composition.tasks))}`;
}

export interface PresentParams {
  readonly composition: DumpComposition;
  readonly actions: readonly string[];
  /** См. `BuildReplyParams.firstItemId`. */
  readonly firstItemId?: string | undefined;
  readonly hidden: number;
  /** Профиль текстов пользователя. Неизвестный — берётся по умолчанию. */
  readonly profile?: string | null | undefined;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
  /**
   * Впереди уже стоит вопрос — опроса или уточнения: своего ответ не
   * задаёт (§13.9: один вопрос на обмен), кнопки остаются.
   */
  readonly omitQuestion?: boolean | undefined;
  /** См. `BuildReplyParams.omitQuestion`. */
  /** Раскладка по сферам и сроки на сегодня/завтра (п. 3, 16.09.2026). */
  readonly summary?: DumpSummary | undefined;
  /** См. `BuildReplyParams.feelingsOnly`. */
  readonly feelingsOnly?: boolean | undefined;
  /**
   * Быстрое добавление (§13.3, задача 3.9).
   *
   * Человек вспомнил одно дело на ходу. Ответ — одна строка, без выдачи
   * действий и без вопроса: предлагать ему в этот момент три дела на
   * сегодня значит превратить полсекунды в разговор.
   */
  readonly quickAdd?: boolean | undefined;
}

export interface PresentResult {
  readonly reply: Reply;
  readonly reason?: string;
}

/**
 * Ответ на выгрузку: признание из состава, вопрос «оставить или выбрать»
 * и две кнопки. Модели здесь нет с 16.09.2026 (`acknowledgementOf`).
 */
export function presentDump(params: PresentParams): PresentResult {
  const texts = textsFor(params.profile);

  /**
   * Быстрое добавление отвечает до всякой модели.
   *
   * Не только ради экономии, хотя и она есть: реплика «Записала» не
   * зависит ни от чего, что модель могла бы сказать. Обращение к ней
   * означало бы риск получить вместо одной строки разбор — ровно то,
   * чего §13.3 просит не делать.
   */
  if (params.quickAdd === true) {
    return {
      reply: { text: texts.answer.added, buttons: [] },
      reason: 'быстрое добавление',
    };
  }

  return {
    reply: buildReply({
      texts,
      acknowledgement: acknowledgementOf(params.composition, texts),
      batchId: params.batchId,
      omitQuestion: params.omitQuestion,
      feelingsOnly: params.feelingsOnly,
      summary: params.summary,
    }),
  };
}

/**
 * Сколько вопросов в реплике. Инвариант 10 и §13.9: не больше одного.
 * Проверяется тестами на каждый случай сборки.
 */
export function countQuestions(text: string): number {
  return (text.match(/\?/gu) ?? []).length;
}
