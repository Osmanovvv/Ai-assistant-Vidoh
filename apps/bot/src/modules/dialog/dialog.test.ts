import { describe, expect, it } from 'vitest';

import {
  DIALOG_HEADING,
  DIALOG_TURN_MAX_CHARS,
  describeDialog,
  recentDialog,
  type DialogTurn,
} from './dialog.js';

/**
 * Хвост разговора для резолвера (план docs/26, задача 4).
 *
 * Замер «как сейчас» 24.09.2026: без разговора модель в трёх случаях из
 * семи молча поправила не то дело — выбирала свежее или совпавшее слово,
 * не зная, о чём бот говорил секунду назад.
 */

const NOW = new Date('2026-09-23T13:20:00.000Z');
const at = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);
const bot = (text: string, minutes: number, messageId?: number): DialogTurn => ({
  role: 'bot',
  text,
  at: at(minutes),
  ...(messageId === undefined ? {} : { messageId }),
});
const person = (text: string, minutes: number): DialogTurn => ({
  role: 'person',
  text,
  at: at(minutes),
});

describe('какие реплики идут в хвост', () => {
  it('старше 15 минут — не в счёт', () => {
    expect(recentDialog([bot('старое', 16), bot('свежее', 2)], NOW).map((t) => t.text)).toEqual([
      'свежее',
    ]);
  });

  it('ровно 15 минут — ещё в счёт', () => {
    expect(recentDialog([bot('на границе', 15)], NOW)).toHaveLength(1);
  });

  it('из будущего — не в счёт: часы разошлись, а не разговор', () => {
    expect(recentDialog([bot('завтрашнее', -1)], NOW)).toEqual([]);
  });

  it('не больше четырёх последних, по порядку времени', () => {
    const turns = [person('5', 5), bot('2', 8), person('1', 9), bot('4', 6), person('3', 7)];
    expect(recentDialog(turns, NOW).map((t) => t.text)).toEqual(['2', '3', '4', '5']);
  });

  it('правка того же сообщения заменяет его, а не добавляет («Слушаю…» → итог)', () => {
    const turns = [bot('Слушаю…', 3, 77), bot('Записала 1 дело: Купить хлеб', 2, 77)];
    expect(recentDialog(turns, NOW).map((t) => t.text)).toEqual(['Записала 1 дело: Купить хлеб']);
  });

  it('разные сообщения с номерами не склеиваются', () => {
    expect(recentDialog([bot('первое', 3, 1), bot('второе', 2, 2)], NOW)).toHaveLength(2);
  });
});

describe('текст блока для модели', () => {
  it('пустой хвост — пустая строка, блока нет', () => {
    expect(describeDialog([], NOW)).toBe('');
    expect(describeDialog([bot('давно', 40)], NOW)).toBe('');
  });

  it('заголовок, кто и сколько минут назад', () => {
    const text = describeDialog([bot('Через 30 минут: Забрать посылку', 3), person('ок', 0)], NOW);
    expect(text.split('\n')).toEqual([
      DIALOG_HEADING,
      'Бот (3 мин назад): Через 30 минут: Забрать посылку',
      'Человек (только что): ок',
    ]);
  });

  it('заголовок запрещает брать из разговора новые дела и сроки', () => {
    expect(DIALOG_HEADING).toContain('о какой записи речь');
    expect(DIALOG_HEADING).toContain('Новых дел и сроков из него не бери');
  });

  it('длинное обрезается с многоточием, переводы строк схлопываются', () => {
    const long = `Твои дела:\n${'1. Купить хлеб\n'.repeat(40)}`;
    const line = describeDialog([bot(long, 2)], NOW).split('\n')[1] ?? '';
    const said = line.slice('Бот (2 мин назад): '.length);

    expect(line.startsWith('Бот (2 мин назад): Твои дела: 1. Купить хлеб')).toBe(true);
    expect(said.endsWith('…')).toBe(true);
    expect([...said].length).toBe(DIALOG_TURN_MAX_CHARS);
    expect(line).not.toContain('\n');
  });

  it('короткое не трогается', () => {
    expect(describeDialog([bot('Какое дело?', 1)], NOW).split('\n')[1]).toBe(
      'Бот (1 мин назад): Какое дело?',
    );
  });
});
