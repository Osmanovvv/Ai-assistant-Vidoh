import { describe, expect, it } from 'vitest';

import {
  restoreDroppedDeeds,
  restoreShortenedText,
  restoreShortenedWords,
} from './dropped-deeds.js';

const unit = (text: string, isEmotion = false) => ({ text, isProject: false, isEmotion });
const texts = (units: readonly { readonly text: string }[]) => units.map((one) => one.text);

/**
 * Её голосовое 30.09.2026, 12:47, знак в знак — как его разрезал
 * маршрутизатор и как оно ушло в извлечение. Извлечение вернуло шесть
 * единиц: «Сходить на Вайлдберриз?» выпало молча (повтор той же модели на
 * том же тексте его сохранил — разброс).
 */
const HER_INPUT = [
  'Так смотри, мне нужно. Выкупать собаку, выкупать. Мне нужно заказать шампунь.',
  'Сходить на Вайлдберриз? Что то я так устала. Так башка не соображает, что еще.',
  'А еще давай начнем рисовать картину по номерам, начну, да, пожалуй, начнем рисовать картину.',
  'Так позвонить еще надо, Анжеле. И Елене Михайловне написать.',
].join('\n');

const HER_UNITS = [
  unit('Выкупать собаку'),
  unit('Заказать шампунь'),
  unit('Устала, башка не соображает', true),
  unit('Начать рисовать картину по номерам'),
  unit('Позвонить Анжеле'),
  unit('Написать Елене Михайловне'),
];

describe('дело, выпавшее из извлечения, возвращается', () => {
  it('её случай: «Сходить на Вайлдберриз» — на своём месте, после шампуня', () => {
    const result = restoreDroppedDeeds(HER_INPUT, HER_UNITS);

    expect(texts(result.units)).toEqual([
      'Выкупать собаку',
      'Заказать шампунь',
      'Сходить на Вайлдберриз',
      'Устала, башка не соображает',
      'Начать рисовать картину по номерам',
      'Позвонить Анжеле',
      'Написать Елене Михайловне',
    ]);
    expect(result.restored).toBe(1);
    expect(result.units[2]).toEqual({
      text: 'Сходить на Вайлдберриз',
      isProject: false,
      isEmotion: false,
    });
  });

  it('модель не потеряла — ничего не добавляется', () => {
    const all = [...HER_UNITS.slice(0, 2), unit('Сходить на Вайлдберриз'), ...HER_UNITS.slice(2)];
    const result = restoreDroppedDeeds(HER_INPUT, all);

    expect(result.units).toEqual(all);
    expect(result.restored).toBe(0);
  });

  it('модель слила с соседним делом — предмет есть, не дубль', () => {
    const merged = [unit('Выкупать собаку'), unit('Заказать шампунь на Вайлдберриз')];
    const result = restoreDroppedDeeds(
      'Выкупать собаку. Заказать шампунь. Сходить на Вайлдберриз?',
      merged,
    );

    expect(result.restored).toBe(0);
  });

  it('тот же глагол, другой предмет — потерянное всё равно находится', () => {
    const result = restoreDroppedDeeds('Купить молоко. Купить хлеб.', [unit('Купить молоко')]);

    expect(texts(result.units)).toEqual(['Купить молоко', 'Купить хлеб']);
  });

  it('модель сказала своими словами, но о том же — не дубль', () => {
    const result = restoreDroppedDeeds('Сходить к врачу.', [unit('Записаться к врачу')]);

    expect(result.restored).toBe(0);
  });

  it('без предмета сверка по глаголу: «И погулять.» при «Погулять с собакой» — есть', () => {
    const result = restoreDroppedDeeds('Надо с собакой. И погулять.', [unit('Погулять с собакой')]);

    expect(result.restored).toBe(0);
  });

  it('день перед глаголом остаётся с делом: срок не теряется', () => {
    const result = restoreDroppedDeeds('Купить хлеб. В пятницу забрать посылку.', [
      unit('Купить хлеб'),
    ]);

    expect(texts(result.units)).toEqual(['Купить хлеб', 'В пятницу забрать посылку']);
  });

  it('день — не предмет: «пятница» у соседнего дела не прячет потерянное', () => {
    const result = restoreDroppedDeeds('Купить хлеб в пятницу. В пятницу забрать посылку.', [
      unit('Купить хлеб в пятницу'),
    ]);

    expect(texts(result.units)).toEqual(['Купить хлеб в пятницу', 'В пятницу забрать посылку']);
  });

  it('служебное слово — не предмет: «надо» у соседнего дела не прячет потерянное', () => {
    const result = restoreDroppedDeeds('Надо позвонить маме. Сходить за хлебом надо.', [
      unit('Надо позвонить маме'),
    ]);

    expect(texts(result.units)).toEqual(['Надо позвонить маме', 'Сходить за хлебом надо']);
  });

  it('связки в начале снимаются: «А ещё сходить в аптеку» → «Сходить в аптеку»', () => {
    const result = restoreDroppedDeeds('Купить хлеб. А ещё сходить в аптеку.', [
      unit('Купить хлеб'),
    ]);

    expect(texts(result.units)).toEqual(['Купить хлеб', 'Сходить в аптеку']);
  });

  it.each([
    ['отказ следом', 'Сходить в магазин? Нет, не надо.'],
    ['отказ следом, «хотя нет»', 'Сходить в магазин. Хотя нет, завтра решу.'],
    ['отрицание в самом предложении', 'Сходить в магазин, но не сегодня.'],
    ['уже сделано', 'Сходить в магазин уже сходила.'],
    ['начинается не с глагола дела', 'Магазин бы сходить.'],
    ['глагола дела нет вовсе', 'Что то я так устала.'],
  ])('не возвращается: %s', (_, input) => {
    const result = restoreDroppedDeeds(input, []);

    expect(result.units).toEqual([]);
    expect(result.restored).toBe(0);
  });
});

describe('предмет, укороченный моделью, возвращается словами человека', () => {
  it('«чеснокодавилку» не превращает в «чеснок»', () => {
    const result = restoreShortenedWords('Заказать чеснокодавилку и отпугиватель от собак.', [
      unit('Заказать чеснок'),
      unit('Заказать отпугиватель от собак'),
    ]);

    expect(texts(result.units)).toEqual([
      'Заказать чеснокодавилку',
      'Заказать отпугиватель от собак',
    ]);
    expect(result.restored).toBe(1);
  });

  it('сохраняет весь список, если модель вернула одну укороченную покупку', () => {
    const result = restoreShortenedWords('Заказать чеснокодавилку и отпугиватель от собак.', [
      unit('Заказать чеснок'),
    ]);

    expect(texts(result.units)).toEqual(['Заказать чеснокодавилку и отпугиватель от собак']);
    expect(result.restored).toBeGreaterThan(0);
  });

  it('обычные окончания не переписывает', () => {
    const units = [unit('Купить молоко')];
    const result = restoreShortenedWords('Купить молока.', units);

    expect(result.units).toEqual(units);
    expect(result.restored).toBe(0);
  });

  it('при двух одинаковых кандидатах не угадывает запись', () => {
    const units = [unit('Заказать чеснок'), unit('Заказать чеснок для дачи')];
    const result = restoreShortenedWords('Заказать чеснокодавилку.', units);

    expect(result.units).toEqual(units);
    expect(result.restored).toBe(0);
  });

  it('защищает классификацию, если она снова сократила слово', () => {
    expect(
      restoreShortenedText('Заказать чеснокодавилку и отпугиватель от собак', 'Заказать чеснок'),
    ).toEqual({
      text: 'Заказать чеснокодавилку и отпугиватель от собак',
      restored: 3,
    });
  });
});
