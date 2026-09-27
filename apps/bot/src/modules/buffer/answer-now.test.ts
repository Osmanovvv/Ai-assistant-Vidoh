import { describe, expect, it } from 'vitest';

import { answersNow, asksDirectly, SHORT_VOICE_SECONDS, type OpenAsk } from './answer-now.js';

/**
 * Ответ на вопрос бота — разбирать сразу (проверка Никиты 24.09.2026,
 * 20:21): «Вечером» на «Во сколько … 09:00 или 21:00?» ждало полминуты
 * тишины. Решает код теми же правилами, по которым конвейер потом узнаёт
 * ответ: не похоже на ответ — ждём тишины, как прежде.
 */
const hour: OpenAsk = {
  kind: 'clarify',
  clarifyKind: 'time',
  command: 'Перенеси «Забрать ребенка» в 7',
};
const which: OpenAsk = { kind: 'clarify', clarifyKind: 'which', command: 'Перенеси дело на пол 4' };
const question: OpenAsk = { kind: 'question', move: false };
const move: OpenAsk = { kind: 'question', move: true };

describe('ответ на «утро или вечер» — сразу', () => {
  it.each(['Вечером', 'утром.', 'Давай вечером', 'в 19:30', '9 утра'])('«%s»', (text) => {
    expect(answersNow(hour, { text })).toBe(true);
  });

  it.each(['Надо купить хлеб и молоко', 'в 9', 'А во сколько лучше?', 'удали это дело'])(
    '«%s» — не ответ, ждём тишины',
    (text) => {
      expect(answersNow(hour, { text })).toBe(false);
    },
  );
});

describe('ответ на «Какое дело?» — сразу', () => {
  it.each(['посылка', 'Забрать посылку'])('«%s»', (text) => {
    expect(answersNow(which, { text })).toBe(true);
  });

  it.each(['удали это', 'перенеси врача на пятницу', 'Какое ещё дело?'])(
    '«%s» — не ответ',
    (text) => {
      expect(answersNow(which, { text })).toBe(false);
    },
  );
});

describe('ответ на «Перенести «X»?» — сразу', () => {
  it.each(['да', 'Да, перенеси', 'нет', 'это новое'])('«%s»', (text) => {
    expect(answersNow(question, { text })).toBe(true);
  });

  it.each(['не знаю', 'добавь ещё купить чехол для зонта'])('«%s» — не ответ', (text) => {
    expect(answersNow(question, { text })).toBe(false);
  });

  it('«давай», «ок» — ответ на «Перенести?», но не на «Это про X или отдельная?»', () => {
    expect(answersNow(move, { text: 'давай' })).toBe(true);
    expect(answersNow(move, { text: 'ок' })).toBe(true);
    expect(answersNow(question, { text: 'давай' })).toBe(false);
  });
});

describe('голосовое после вопроса — по длине: короткое почти всегда ответ', () => {
  it('до пяти секунд — сразу, длиннее — ждём тишины', () => {
    expect(answersNow(hour, { voiceSeconds: 3 })).toBe(true);
    expect(answersNow(question, { voiceSeconds: SHORT_VOICE_SECONDS })).toBe(true);
    expect(answersNow(hour, { voiceSeconds: SHORT_VOICE_SECONDS + 1 })).toBe(false);
  });

  it('вопрос о часе уже пережил чужую реплику — голосовое ждёт тишины, текст-ответ сразу', () => {
    // Вопрос ждёт ответа и через другие сообщения (28.09.2026). Короткое
    // голосовое первым после вопроса — почти всегда ответ; после чужой
    // реплики — уже нет: серия коротких мыслей склеивается, как прежде.
    const waited: OpenAsk = { ...hour, waited: true };
    expect(answersNow(waited, { voiceSeconds: 2 })).toBe(false);
    expect(answersNow(waited, { text: 'Вечером' })).toBe(true);
  });

  it('вопроса нет — ждём тишины, что бы ни пришло', () => {
    expect(answersNow(undefined, { voiceSeconds: 2 })).toBe(false);
    expect(answersNow(undefined, { text: 'Вечером' })).toBe(false);
  });
});

describe('команды, которые конвейер узнаёт мимо модели, — тоже сразу', () => {
  it.each(['Какие еще', 'какие ещё 6', 'Напомнишь', 'Ты напомнишь'])('«%s»', (text) => {
    expect(asksDirectly(text)).toBe(true);
  });

  it.each(['купить хлеб', 'Напомни завтра позвонить маме', undefined])('«%s» — нет', (text) => {
    expect(asksDirectly(text)).toBe(false);
  });
});
