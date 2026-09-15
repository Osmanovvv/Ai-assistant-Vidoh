import { requestStructured, type AiClientDeps } from '../ai/client.js';
import { toShortId } from '../shared/short-id.js';
import type { ItemType, PresenterAcknowledgement } from '../ai/schemas/index.js';
import { textsFor, type TextProfile } from '../../texts/index.js';
import { contentRefusal } from '../../texts/rules.js';

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
   * Не задавать свой вопрос.
   *
   * Нужно одному случаю: сразу после этого ответа начинается онбординг
   * (§12.2), и его первый вопрос станет единственным. Иначе у человека
   * оказалось бы два открытых вопроса подряд, чего §13.9 не допускает.
   * Кнопки остаются — они не вопрос, а выход к делам.
   */
  readonly omitQuestion?: boolean | undefined;
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
    return { text: params.acknowledgement, buttons: [] };
  }

  const lines: string[] = [params.acknowledgement];
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

/** §13.2 требует одной фразы, §13.9 — одной-двух на реплику вне выдачи. */
const MAX_LENGTH = 200;

export interface SanitizedAcknowledgement {
  readonly text: string;
  /** Заменено ли признание словарным. Ненулевое — повод к промпту. */
  readonly replaced: boolean;
  readonly reason?: string;
}

export function sanitizeAcknowledgement(
  raw: string,
  texts: TextProfile,
  options: { readonly tired: boolean },
): SanitizedAcknowledgement {
  /**
   * Замена здесь не перепроверяется, и это не пробел.
   *
   * Правила ниже — про ответ модели. Словарная замена приходит либо из
   * кода, где её стерегут проверки словаря, либо из правки в панели —
   * а правку судят на записи тем же §13, и вопроса в ней быть не может:
   * она стоит в одном ответе с нашим вопросом (`BESIDE_QUESTION` в
   * `texts/rules.ts`). Второй судья на выходе считал бы одно и то же
   * дважды и однажды разошёлся бы с первым молча.
   */
  const fallback = options.tired
    ? texts.answer.acknowledgementTiredFallback
    : texts.answer.acknowledgementFallback;

  const reject = (reason: string): SanitizedAcknowledgement => ({
    text: fallback,
    replaced: true,
    reason,
  });

  const text = raw.trim();

  /**
   * Общее правило судит первым, и оно то же, что на записи в панели:
   * пустота, серия восклицательных (§13.9), фразы из запретов §13.7,
   * украшательские эмодзи. Оно зовётся, а не переписывается, — иначе
   * следующее правило §13 приедет в панель и не приедет сюда, как уже
   * было с серией восклицательных. Причина отказа тоже его: в журнале
   * она читается так же, как в панели.
   */
  const shared = contentRefusal(text);
  if (shared !== undefined) return reject(shared);

  // Дальше признание строже словарной реплики: общее правило разрешает
  // один «?», а здесь и один означал бы два вопроса в ответе — свой у
  // нас уже есть, и §13.9 этого не допускает.
  if (text.includes('?')) return reject('вопрос в признании');

  if (text.includes('\n')) return reject('признание в несколько строк');
  if (text.length > MAX_LENGTH) return reject('признание длиннее одной фразы');

  // §13.9: эмодзи только как маркеры приоритета и статуса, то есть не в
  // тексте реплики. Общее правило пускает звезду тарифа; в признании
  // ей взяться неоткуда.
  if (/\p{Extended_Pictographic}/u.test(text)) return reject('эмодзи в признании');

  return { text, replaced: false };
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
  /** См. `BuildReplyParams.omitQuestion`. */
  readonly omitQuestion?: boolean | undefined;
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
  readonly promptVersion: string | null;
  /** Признание заменено словарным: либо модель молчит, либо нарушила правила. */
  readonly replaced: boolean;
  readonly reason?: string;
}

/** Что видит модель. Полных текстов здесь нет — только состав и заголовки. */
function buildInput(params: PresentParams): string {
  const { composition: parts } = params;

  const lines = [
    'Состав выгрузки:',
    `- дел: ${String(parts.tasks)}`,
    `- желаний: ${String(parts.desires)}`,
    `- идей: ${String(parts.ideas)}`,
    `- фактов: ${String(parts.infos)}`,
    `- высказанных состояний: ${String(parts.emotions)}`,
    `- большая составная цель среди дел: ${parts.hasProject ? 'есть' : 'нет'}`,
  ];

  if (params.actions.length > 0) {
    lines.push('', 'Что будет предложено сделать:');
    lines.push(...params.actions.map((text, index) => `${String(index + 1)}. ${text}`));
  }

  lines.push('', `Остаётся сохранённым, без показа: ${String(params.hidden)}.`);

  return lines.join('\n');
}

export async function presentDump(
  deps: AiClientDeps,
  params: PresentParams,
): Promise<PresentResult> {
  const texts = textsFor(params.profile);
  const tired = params.composition.emotions > 0;

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
      promptVersion: null,
      replaced: false,
      reason: 'быстрое добавление',
    };
  }

  let raw = '';
  let promptVersion: string | null = null;
  let problem: string | undefined;

  /**
   * Недоступность модели здесь не пробрасывается наружу — единственное
   * место в конвейере, где это так.
   *
   * На остальных этапах отказ означает «выгрузка не разобрана», её надо
   * вернуть в очередь и попробовать снова. Здесь разбор уже сделан и
   * записи уже сохранены: повтор прогнал бы заново маршрутизатор,
   * извлечение и классификацию — второй раз за чужие деньги и с риском
   * создать те же записи дважды. И всё это ради одной фразы, которая в
   * словаре и так есть.
   */
  try {
    const outcome = await requestStructured<PresenterAcknowledgement>(deps, {
      stage: 'presenter',
      input: buildInput(params),
      userId: params.userId,
      batchId: params.batchId,
    });

    promptVersion = outcome.promptVersion;
    if (outcome.ok) raw = outcome.value.acknowledgement;
    else problem = outcome.problem;
  } catch (error) {
    problem = error instanceof Error ? error.message : 'модель недоступна';
  }

  const checked = sanitizeAcknowledgement(raw, texts, { tired });

  if (checked.replaced) {
    deps.logger?.warn(
      { promptVersion, reason: problem ?? checked.reason },
      'Признание заменено словарным',
    );
  }

  return {
    reply: buildReply({
      texts,
      acknowledgement: checked.text,
      batchId: params.batchId,
      omitQuestion: params.omitQuestion,
      feelingsOnly: params.feelingsOnly,
    }),
    promptVersion,
    replaced: checked.replaced,
    ...(problem === undefined && checked.reason === undefined
      ? {}
      : { reason: problem ?? checked.reason ?? '' }),
  };
}

/**
 * Сколько вопросов в реплике. Инвариант 10 и §13.9: не больше одного.
 * Проверяется тестами на каждый случай сборки.
 */
export function countQuestions(text: string): number {
  return (text.match(/\?/gu) ?? []).length;
}
