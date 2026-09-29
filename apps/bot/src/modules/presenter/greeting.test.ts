import { describe, expect, it } from 'vitest';

import { defaultTexts } from '../../texts/index.js';
import { picturesIn } from '../../texts/rules.js';
import {
  dayPartAt,
  greetingLine,
  onlyGreeting,
  salutationAt,
  withoutGreeting,
} from './greeting.js';

/**
 * Приветствие — ответ сразу, фразой из словаря (ТЗ §7.1: «Приветствие,
 * благодарность, реплика без содержания — короткий ответ, без обращения к
 * тяжёлым моделям»; §18: первый отклик практически мгновенный). Список
 * закрытый, как у «спасибо»: всё сверх приветствия — в разбор.
 */
describe('onlyGreeting — одно приветствие, и ничего сверх него', () => {
  it.each([
    'Привет',
    'привет!',
    'Приветик)',
    'Привет 👋',
    '👋',
    'Добрый день',
    'Доброе утро!',
    'добрый вечер',
    'Доброго утра',
    'Здравствуйте',
    'Здравствуй, Выдох',
    'Салам алейкум',
    'Салам',
    'Hi',
    'hello',
    'Привет ещё раз',
    'Ну привет',
    'И тебе привет',
  ])('«%s» — приветствие', (text) => {
    expect(onlyGreeting(text)).toBe(true);
  });

  it.each([
    'Привет, купи хлеб',
    'Привет, как дела?',
    'Привет?',
    'Доброе утро, надо позвонить маме',
    'Салам Алейкум нужно в общем сделать яичницу',
    // Прощание, а не приветствие: «доброй ночи» говорят, уходя.
    'Доброй ночи',
    'Спокойной ночи',
    // «Здорово!» — чаще «классно», чем «здравствуй».
    'Здорово',
    'Добрый',
    'утро',
    'Привет 😡',
    '🙂',
    'Спасибо',
    'ок',
    '',
    undefined,
  ])('«%s» — не приветствие', (text) => {
    expect(onlyGreeting(text)).toBe(false);
  });
});

describe('dayPartAt — часть суток по часам человека, а не сервера', () => {
  const at = (iso: string): Date => new Date(iso);

  it.each([
    ['2026-09-29T02:00:00Z', 'morning'], // 05:00 МСК
    ['2026-09-29T08:59:00Z', 'morning'], // 11:59
    ['2026-09-29T09:00:00Z', 'day'], // 12:00
    ['2026-09-29T14:59:00Z', 'day'], // 17:59
    ['2026-09-29T15:00:00Z', 'evening'], // 18:00
    ['2026-09-29T19:59:00Z', 'evening'], // 22:59
    ['2026-09-29T20:00:00Z', 'night'], // 23:00
    ['2026-09-29T01:59:00Z', 'night'], // 04:59
    ['2026-09-28T21:00:00Z', 'night'], // 00:00
  ] as const)('%s в Москве — %s', (iso, part) => {
    expect(dayPartAt(at(iso), 'Europe/Moscow')).toBe(part);
  });

  it('тот же момент в разных поясах — разная часть суток', () => {
    const moment = at('2026-09-29T06:30:00Z');
    expect(dayPartAt(moment, 'Europe/Moscow')).toBe('morning'); // 09:30
    expect(dayPartAt(moment, 'Asia/Vladivostok')).toBe('day'); // 16:30
    expect(dayPartAt(moment, 'Asia/Kamchatka')).toBe('evening'); // 18:30
    expect(dayPartAt(moment, 'America/Los_Angeles')).toBe('night'); // 23:30
  });
});

describe('greetingLine — фраза из словаря по части суток', () => {
  const texts = defaultTexts;

  it('днём — «Добрый день», и никакого «Доброе утро»', () => {
    const line = greetingLine(texts, new Date('2026-09-29T11:00:00Z'), 'Europe/Moscow'); // 14:00
    expect(line).toBe(`${texts.answer.greetingDay} ${texts.answer.greetingInvite}`);
    expect(line).not.toContain('утро');
  });

  it('утром — «Доброе утро», вечером — «Добрый вечер»', () => {
    expect(salutationAt(texts, new Date('2026-09-29T05:00:00Z'), 'Europe/Moscow')).toBe(
      texts.answer.greetingMorning,
    );
    expect(salutationAt(texts, new Date('2026-09-29T17:00:00Z'), 'Europe/Moscow')).toBe(
      texts.answer.greetingEvening,
    );
  });

  it('ночью — просто «Привет»: «доброй ночи» звучит как прощание', () => {
    const hello = salutationAt(texts, new Date('2026-09-29T22:30:00Z'), 'Europe/Moscow'); // 01:30
    expect(hello).toBe(texts.answer.greetingNight);
    expect(hello).not.toMatch(/ноч/iu);
  });

  it('её правила: не больше одного эмодзи и одного вопроса на ответ (docs/15, §13.9)', () => {
    for (const key of [
      'greetingMorning',
      'greetingDay',
      'greetingEvening',
      'greetingNight',
    ] as const) {
      const line = `${texts.answer[key]} ${texts.answer.greetingInvite}`;
      expect(picturesIn(line).length).toBeLessThanOrEqual(1);
      expect(line.match(/\?/gu)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});

describe('withoutGreeting — приветствие в начале ответа на «Как тебя звать?»', () => {
  it.each([
    ['Привет, я Оля', 'я Оля'],
    ['Добрый день! Меня зовут Катя', 'Меня зовут Катя'],
    ['Салам алейкум, Никита', 'Никита'],
    ['Оля', 'Оля'],
    ['Привет', ''],
  ])('«%s» → «%s»', (text, rest) => {
    expect(withoutGreeting(text)).toBe(rest);
  });
});
