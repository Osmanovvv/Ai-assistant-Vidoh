import { requestStructured, type AiClientDeps } from '../ai/client.js';
import type { ItemType, PresenterAcknowledgement } from '../ai/schemas/index.js';
import { textsFor, type TextProfile } from '../../texts/index.js';

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
  /** Заголовки дел из фильтра выдачи, в его порядке. */
  readonly actions: readonly string[];
  /** Сколько дел осталось за пределами выдачи. */
  readonly hidden: number;
  /**
   * §13.7: в выгрузке есть эмоция или силы на нуле. Тогда объём
   * сокращается, а разговор закрывается вместо вопроса.
   */
  readonly tired: boolean;
}

/**
 * Собирает реплику. Чистая функция: ни модели, ни базы, ни времени —
 * иначе форму ответа нельзя проверить таблицей случаев.
 */
export function buildReply(params: BuildReplyParams): Reply {
  const { texts, actions, hidden, tired } = params;
  const answer = texts.answer;
  const lines: string[] = [params.acknowledgement];

  if (actions.length === 0) {
    // Разбирать было что, но срочного нет. Вопрос «с чего начнём» здесь
    // бессмысленен, поэтому спрашиваем о другом — но всё равно один раз.
    lines.push('', hidden > 0 ? answer.nothingUrgent : answer.nothingHidden);
    lines.push('', answer.questionEmotionOnly);

    return {
      text: lines.join('\n'),
      buttons: [
        { label: answer.buttonShowAll, action: 'answer:all' },
        { label: answer.buttonLater, action: 'answer:later' },
      ],
    };
  }

  lines.push('', actions.length === 1 ? answer.actionsLeadSingle : answer.actionsLead);
  lines.push(...actions.map((text) => answer.bullet(text)));

  if (tired) {
    // §13.7 требует сокращения объёма: в эталонном ответе про усталость
    // фразы о сохранённом нет вовсе, и добавлять её значило бы удлинять
    // ровно там, где надо укорачивать.
    lines.push('', answer.closingTired);

    return {
      text: lines.join('\n'),
      buttons: [
        { label: answer.buttonDoNow, action: 'answer:now' },
        { label: answer.buttonLater, action: 'answer:later' },
      ],
    };
  }

  lines.push('', hidden > 0 ? answer.restSaved : answer.nothingHidden);
  lines.push('', answer.question);

  return {
    text: lines.join('\n'),
    buttons: [
      { label: answer.buttonDoNow, action: 'answer:now' },
      { label: answer.buttonShowAll, action: 'answer:all' },
      { label: answer.buttonLater, action: 'answer:later' },
    ],
  };
}

/**
 * Формулировки, запрещённые §13.7.
 *
 * Список закрытый и составлен по самому §13.7: советы отдохнуть и
 * подышать, рассуждения про ресурс и выгорание, похвала без повода,
 * благодарность за то, что человек поделился. Это фразы, а не отдельные
 * слова, — «ванна» в деле «купить ванну» законна, а «прими ванну» нет.
 */
const FORBIDDEN = [
  'отдохни',
  'отдохнуть',
  'подыши',
  'подышать',
  'прими ванну',
  'полежи',
  'побудь с собой',
  'выгорание',
  'выгораешь',
  'твой ресурс',
  'ресурсное состояние',
  'слишком много на себя',
  'расскажи подробнее',
  'как ты себя чувствуешь',
  'спасибо, что поделилась',
  'спасибо что поделилась',
  'ты молодец',
  'ты справишься',
  'все будет хорошо',
  'не переживай',
  'береги себя',
] as const;

/** «Ё» приравнивается к «е»: живая расшифровка даёт и то и другое. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е');
}

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
  const fallback = options.tired
    ? texts.answer.acknowledgementTiredFallback
    : texts.answer.acknowledgementFallback;

  const reject = (reason: string): SanitizedAcknowledgement => ({
    text: fallback,
    replaced: true,
    reason,
  });

  const text = raw.trim();
  if (text === '') return reject('пустое признание');

  // Вопрос в признании означал бы два вопроса в реплике: свой у нас уже
  // есть. §13.9 этого не допускает.
  if (text.includes('?')) return reject('вопрос в признании');

  if (text.includes('\n')) return reject('признание в несколько строк');
  if (text.length > MAX_LENGTH) return reject('признание длиннее одной фразы');

  // §13.9: эмодзи только как маркеры приоритета и статуса, то есть не в
  // тексте реплики.
  if (/\p{Extended_Pictographic}/u.test(text)) return reject('эмодзи в признании');

  const normalized = normalize(text);
  const found = FORBIDDEN.find((phrase) => normalized.includes(phrase));
  if (found !== undefined) return reject(`запрещённая формулировка §13.7: «${found}»`);

  return { text, replaced: false };
}

export interface PresentParams {
  readonly composition: DumpComposition;
  readonly actions: readonly string[];
  readonly hidden: number;
  /** Профиль текстов пользователя. Неизвестный — берётся по умолчанию. */
  readonly profile?: string | null | undefined;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
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
      actions: params.actions,
      hidden: params.hidden,
      tired,
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
