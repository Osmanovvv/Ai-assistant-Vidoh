import {
  requestStructured,
  type AiClientDeps,
  type StructuredOutcome,
  type StructuredRequest,
} from '../ai/client.js';
import { TALKER_SCHEMA_NAME, type TalkReply } from '../ai/schemas/index.js';
import type { Item } from '../../db/schema.js';
import { overviewLines } from '../backlog/live-answer.js';
import { DIALOG_TURN_MAX_CHARS, recentDialog, type DialogTurn } from '../dialog/dialog.js';
import { checkVoice, type CheckedLine, type VoiceLimits } from '../presenter/context-line.js';
import { partOfDayIn } from '../presenter/context-pack.js';
import type { Mood } from '../presenter/mood.js';
import { picturesIn } from '../../texts/rules.js';
import type { TextProfile } from '../../texts/index.js';

/**
 * Живой ответ там, где у бота нет своего (план docs/29, 28.09.2026).
 *
 * Никита: бот «зажат» — на болтовню, вопрос про бота, просьбу, чувства
 * без дел и обрывок он отвечал заготовкой («Я здесь. Расскажешь, что в
 * голове?»), сколько ни чини по одной фразе. Здесь модель говорит своими
 * словами, а разделение труда прежнее: **факты даёт код** (её ближайшие
 * дела, время суток, сила чувства по её словам, последние реплики),
 * **ответ проверяет код** — общий страж голоса (`checkVoice`: её запреты,
 * «вы», мужской род, часы и дни только из фактов) плюс то, чего вне
 * сценария особенно легко выдумать: «записала», «напомню». Не прошло или
 * модель молчит — ответ словарный, как раньше.
 *
 * Действия здесь не совершаются: сохранить, перенести, удалить может
 * только код по разбору. Модель может лишь предложить.
 */

/** «Ок», «понятно», 👍 — смайликом, без модели (решение Никиты 28.09.2026). */
const ACK_WORDS: ReadonlySet<string> = new Set([
  'ок',
  'окей',
  'ok',
  'okay',
  'понятно',
  'ясно',
  'ага',
  'угу',
  'хорошо',
  'ладно',
  'понял',
  'поняла',
  'принято',
  'договорились',
]);

const ACK_PICTURES: ReadonlySet<string> = new Set(['👍', '👌', '🙂', '😊', '🙏']);

/** Оттенок кожи — тот же знак: «👍🏻» — это «👍». */
const withoutSkinTone = (picture: string): string => picture.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');

/** Реплика — только согласие: одно слово из списка и/или знакомый знак. */
export function onlyAck(text: string): boolean {
  const pictures = picturesIn(text).map(withoutSkinTone);
  if (!pictures.every((picture) => ACK_PICTURES.has(picture))) return false;
  const words = (
    text
      .toLowerCase()
      .replace(/ё/gu, 'е')
      .match(/[\p{L}]+/gu) ?? []
  ).filter((word) => word !== '');
  if (words.length === 0) return pictures.length > 0 && !/[?]/u.test(text);
  return words.length === 1 && ACK_WORDS.has(words[0] ?? '') && !/[?]/u.test(text);
}

const MOOD_WORDS: Readonly<Record<Mood, string>> = {
  heavy: 'сильное',
  tired: 'усталость',
  annoyed: 'досада',
};

export interface TalkFactsParams {
  readonly said: string;
  readonly now: Date;
  readonly timeZone: string;
  readonly texts: TextProfile;
  /** Её открытые дела: по ним модель может сказать о делах. */
  readonly overview: readonly Item[];
  /** Сила чувства по её словам (`presenter/mood.ts`). */
  readonly mood?: Mood | undefined;
  /** Вопрос бота уже открыт — второго в обмене не задаём (§13.9). */
  readonly questionOpen?: boolean | undefined;
  /** Последние реплики за четверть часа — чтобы «Второе» было о чём. */
  readonly dialog?: readonly DialogTurn[] | undefined;
}

const clip = (text: string): string =>
  text.length > DIALOG_TURN_MAX_CHARS ? `${text.slice(0, DIALOG_TURN_MAX_CHARS)}…` : text;

/** Текст фактов для модели — и словарь для стража: часы и дни только отсюда. */
export function talkFacts(params: TalkFactsParams): string {
  const { now, timeZone, texts } = params;
  const lines = [`Реплика: ${params.said.trim()}`, `Сейчас: ${partOfDayIn(now, timeZone)}`];
  if (params.mood !== undefined) lines.push(`Чувство: ${MOOD_WORDS[params.mood]}`);
  if (params.questionOpen === true) {
    lines.push('Свой вопрос не задавай: вопрос бота уже открыт');
  }
  const turns = recentDialog(params.dialog ?? [], now);
  if (turns.length > 0) {
    lines.push('Недавний разговор:');
    for (const turn of turns) {
      lines.push(`${turn.role === 'bot' ? 'Бот' : 'Человек'}: ${clip(turn.text)}`);
    }
  }
  lines.push(...overviewLines(params.overview, { now, timeZone, texts }));
  return lines.join('\n');
}

/** Её список эмодзи (docs/15); 🤍 — только в трёх местах, не здесь. */
const TONE: ReadonlySet<string> = new Set(['😌', '🙂', '🙌', '🛒', '📌', '⏰']);
/** При лёгкой эмоции — ещё её 😮‍💨 и 🙃; при сильной — никаких. */
const TONE_FEELINGS: ReadonlySet<string> = new Set([...TONE, '😮‍💨', '🙃']);
const NO_EMOJI: ReadonlySet<string> = new Set();

export interface TalkCheckOptions {
  readonly mood?: Mood | undefined;
  readonly questionOpen?: boolean | undefined;
}

function limitsFor(options: TalkCheckOptions): VoiceLimits {
  return {
    maxLength: 300,
    maxSentences: 3,
    maxQuestions: options.questionOpen === true ? 0 : 1,
    forbidOpening: false,
    allowMust: true,
    countsFromFacts: true,
    freeNumbers: true,
    emoji: options.mood === 'heavy' ? NO_EMOJI : options.mood === undefined ? TONE : TONE_FEELINGS,
  };
}

/**
 * Сделанное — только кодом: вне сценария бот ничего не записал, не
 * удалил, не нашёл. «Не записала» — правда, «могу записать» — предложение.
 */
const CLAIM =
  /(?<!\p{L})(записала|сохранила|удалила|убрала|перенесла|добавила|поставила|отметила|напомнила|закрыла|отправила|заказала|позвонила|написала|нашла|включила|вызвала|завела|отменила|поменяла|изменила)(?!\p{L})/iu;
/** Напоминания здесь не ставятся: «напомню» — обещание, «могу напомнить» — нет. */
const REMIND_PROMISE = /(?<!\p{L})напомню(?!\p{L})/iu;

export function checkTalk(raw: string, facts: string, options: TalkCheckOptions): CheckedLine {
  const voiced = checkVoice(raw, facts, limitsFor(options));
  if (!voiced.ok) return voiced;

  const claim = CLAIM.exec(voiced.line);
  if (
    claim !== null &&
    !/(?<!\p{L})не\s+$/u.test(voiced.line.slice(0, claim.index).toLowerCase())
  ) {
    return { ok: false, why: `сделано не было: ${claim[0].toLowerCase()}` };
  }
  if (REMIND_PROMISE.test(voiced.line)) return { ok: false, why: 'обещание напомнить' };
  return voiced;
}

export interface TalkParams extends TalkCheckOptions {
  readonly facts: string;
  readonly userId?: string | undefined;
  readonly batchId?: string | undefined;
}

export interface TalkOutcome {
  readonly line?: string | undefined;
  /** Почему ответа нет: «пусто» — сказать нечего, остальное — в журнал. */
  readonly why?: string | undefined;
  /** Что написала модель, когда страж отверг: стенду — для правки промпта. */
  readonly rejected?: string | undefined;
}

export type AskTalk = (
  deps: AiClientDeps,
  request: StructuredRequest,
) => Promise<StructuredOutcome<TalkReply>>;

const MAX_TOKENS = 300;

/** Спросить ответ и проверить. Никогда не бросает: словарный ответ всегда есть. */
export async function askTalk(
  deps: AiClientDeps,
  params: TalkParams,
  ask: AskTalk = requestStructured,
): Promise<TalkOutcome> {
  try {
    const active = await deps.prompts.get('talker');
    if (active.schemaName !== TALKER_SCHEMA_NAME) {
      const why = 'промпт живого ответа не той схемы';
      deps.logger?.warn({ version: active.version, schema: active.schemaName }, why);
      return { why };
    }

    const outcome = await ask(deps, {
      stage: 'talker',
      input: params.facts,
      userId: params.userId,
      batchId: params.batchId,
      maxTokens: MAX_TOKENS,
    });
    if (!outcome.ok) {
      deps.logger?.info(
        { batchId: params.batchId, problem: outcome.problem },
        'Живой ответ вне сценария не получен',
      );
      return { why: outcome.problem };
    }

    const checked = checkTalk(outcome.value.reply, params.facts, params);
    if (!checked.ok) {
      if (checked.why === 'пусто') return { why: checked.why };
      deps.logger?.info(
        { batchId: params.batchId, why: checked.why, reply: outcome.value.reply },
        'Живой ответ вне сценария отвергнут стражем',
      );
      return { why: checked.why, rejected: outcome.value.reply };
    }
    return { line: checked.line };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    deps.logger?.warn(
      { batchId: params.batchId, err: error },
      'Живой ответ вне сценария: модель не ответила',
    );
    return { why };
  }
}
