import { asksToRemind } from '../scheduler/remind-request.js';
import { readAnswer } from '../resolver/answer.js';
import { clarifiedCommand, type ClarifyKind } from '../resolver/clarify.js';
import { asksForRest } from '../topics/rest-request.js';

/**
 * Ответ на вопрос бота — разбирать сразу, без окна тишины (проверка
 * Никиты 24.09.2026, 20:21).
 *
 * «Вечером» на «Во сколько «Позвонить маме» — 09:00 или 21:00?» пришло в
 * 20:21:04, ответ — в 20:21:34: бот полминуты ждал, не скажет ли человек
 * ещё. Окно склеивает серию мыслей в одну выгрузку (§9.1 правило 2), а
 * короткий ответ на свой же вопрос склеивать не с чем.
 *
 * Решает **код, теми же правилами**, по которым конвейер потом узнаёт
 * ответ: `clarifiedCommand` для переспроса, `readAnswer` для вопроса с
 * кнопками. Меняется только «когда», а не «как»: не похоже на ответ —
 * окно тишины, как прежде, и разбор как прежде. Голосовое до распознавания
 * не прочитать — решает длина: короткое после вопроса почти всегда ответ;
 * если окажется мыслью, разберётся мыслью, только без ожидания продолжения.
 */

/** Голосовое не длиннее этого после вопроса бота — ответ. */
export const SHORT_VOICE_SECONDS = 5;

/** Что бот сейчас спросил и ждёт. */
export type OpenAsk =
  /** Переспрос без кнопок: «утро или вечер?», «Какое дело?» (`clarify.ts`). */
  | { readonly kind: 'clarify'; readonly clarifyKind: ClarifyKind; readonly command: string }
  /** Вопрос с кнопками: «Перенести «X»?», «Добавить к прошлой?». */
  | { readonly kind: 'question' };

export interface IncomingShape {
  readonly text?: string | undefined;
  /** Длина голосового в секундах, как её прислал Telegram. */
  readonly voiceSeconds?: number | undefined;
}

export function answersNow(open: OpenAsk | undefined, message: IncomingShape): boolean {
  if (open === undefined) return false;

  if (message.text !== undefined) {
    if (open.kind === 'clarify') {
      return clarifiedCommand(open.clarifyKind, open.command, message.text) !== undefined;
    }
    const reading = readAnswer(message.text);
    return reading === 'attach' || reading === 'separate';
  }

  return message.voiceSeconds !== undefined && message.voiceSeconds <= SHORT_VOICE_SECONDS;
}

/**
 * «Какие ещё» под сводкой ветки, «Напомнишь» — команды, которые конвейер
 * узнаёт мимо модели (`asksForRest`, `asksToRemind`). Это вопросы, даже без
 * знака вопроса: ответ на них сразу, как на «Что у меня на сегодня?».
 */
export function asksDirectly(text: string | undefined): boolean {
  return text !== undefined && (asksForRest(text) || asksToRemind(text));
}
