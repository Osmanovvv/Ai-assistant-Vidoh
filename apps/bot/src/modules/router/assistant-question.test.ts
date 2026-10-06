import { describe, expect, it } from 'vitest';

import { looksLikeAssistantQuestion } from './assistant-question.js';

describe('вопрос о пользе ВЫДОХа', () => {
  it('узнаётся даже в длинной разговорной формулировке', () => {
    expect(
      looksLikeAssistantQuestion(
        'Привет, я пока не понимаю, для чего ты мне можешь ли рассказать свою добавочную ценность?',
      ),
    ).toBe(true);
  });

  it('вопрос о деле не превращается в разговор о помощнике', () => {
    expect(looksLikeAssistantQuestion('Расскажи, что у меня на завтра')).toBe(false);
    expect(looksLikeAssistantQuestion('Что у меня по покупкам?')).toBe(false);
  });
});
