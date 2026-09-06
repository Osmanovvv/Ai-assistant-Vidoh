import { describe, expect, it } from 'vitest';

import type { Item } from '../../db/schema.js';
import { defaultTexts } from '../../texts/index.js';
import { CARD_ACTION } from '../items/card-actions.js';
import { toShortId } from '../shared/short-id.js';
import {
  changeButtons,
  describeChange,
  keptTitleAfterReplacement,
  UNDO_PREFIX,
  undoButtons,
} from './change-text.js';
import type { Applied } from './patch.js';

/**
 * Реплика о правке — и то, чего она не должна скрывать (задача 3.28).
 *
 * **Вторая половина задачи, закрытой наполовину 02.09.2026.** Человек
 * сказал «нет, няня пусть приходит в 9 30». Модель разобрала это
 * дополнением: время ушло в подробности, а в заголовке осталось прежнее
 * «в 9». Правило §7.1 уже заставляет считать такую реплику заменой — но
 * только когда модель дала новый текст. Не дала — правка остаётся
 * дополнением, и это не беда. Беда была в реплике: «Добавила
 * подробность» молчала о том, что заголовок теперь противоречит
 * сказанному, и человек уходил с ощущением, что его поняли.
 *
 * Всё проверяется без модели: и признак замены, и «что именно
 * изменилось» — это данные, а не суждение.
 */

const MOSCOW = 'Europe/Moscow';

const ITEM = {
  id: '11111111-1111-4111-8111-111111111111',
  text: 'Договориться с няней, чтобы приходила не в 11, а в 9',
  status: 'new',
  deadlineAt: null,
  recurrenceText: null,
} as unknown as Item;

function applied(fields: readonly string[]): Applied {
  return {
    revisionId: '22222222-2222-4222-8222-222222222222',
    action: 'update',
    before: ITEM,
    after: ITEM,
    fields: fields as Applied['fields'],
  };
}

describe('keptTitleAfterReplacement', () => {
  it('человек говорил о замене, а заголовок остался прежним', () => {
    expect(keptTitleAfterReplacement(applied(['body']), 'нет, няня пусть приходит в 9 30')).toBe(
      true,
    );
  });

  it('узнаёт весь закрытый список признаков §7.1', () => {
    for (const said of [
      'нет, лучше в 10 30',
      'перенеси на пятницу',
      'вместо вторника в среду',
      'лучше в понедельник',
    ]) {
      expect(keptTitleAfterReplacement(applied(['body']), said), said).toBe(true);
    }
  });

  describe('чего считать нельзя', () => {
    it('обычное дополнение — не этот случай', () => {
      /**
       * §7.4 дословно: «а ещё туда надо взять карту прививок». Человек
       * добавляет, а не заменяет, и реплика «Добавила подробность» тут
       * верна. Скажи ей про «заголовок не меняла» — и бот начнёт
       * извиняться там, где всё сделал правильно.
       */
      for (const said of [
        'а ещё туда надо взять карту прививок',
        'и ещё не забыть полис',
        'там же рядом аптека',
      ]) {
        expect(keptTitleAfterReplacement(applied(['body']), said), said).toBe(false);
      }
    });

    it('заголовок изменён — говорить не о чем', () => {
      // Замена сработала: и подробность, и новый заголовок.
      expect(keptTitleAfterReplacement(applied(['body', 'text']), 'нет, в 9 30')).toBe(false);
    });

    it('дополнения не было — это другая правка', () => {
      // Перенос срока, смена статуса: заголовок тут и не при чём.
      expect(keptTitleAfterReplacement(applied(['deadlineAt']), 'перенеси на пятницу')).toBe(false);
      expect(keptTitleAfterReplacement(applied(['status']), 'нет, отмени')).toBe(false);
    });

    it('без сказанного не догадывается', () => {
      // Правка из кнопки: слов человека нет, и выдумывать их нельзя.
      expect(keptTitleAfterReplacement(applied(['body']), undefined)).toBe(false);
      expect(keptTitleAfterReplacement(applied(['body']), '')).toBe(false);
    });
  });
});

describe('describeChange', () => {
  it('говорит и о записанном, и о том, что заголовок прежний', () => {
    const text = describeChange(
      applied(['body']),
      defaultTexts,
      MOSCOW,
      'нет, няня пусть приходит в 9 30',
    );

    expect(text).toBe(defaultTexts.resolver.notedTitleKept(ITEM.text));
    // Заголовок назван целиком: человек должен увидеть, что там осталось.
    expect(text).toContain('а в 9');
  });

  it('обычное дополнение описывается как раньше', () => {
    const text = describeChange(applied(['body']), defaultTexts, MOSCOW, 'а ещё возьми карту');

    expect(text).toBe(defaultTexts.resolver.noted(ITEM.text));
  });

  it('без сказанного — как раньше: прежние вызывающие не задеты', () => {
    /**
     * У правки из карточки и из ответа на вопрос слов человека нет.
     * Четвёртый параметр необязателен именно поэтому, и поведение без
     * него должно остаться прежним до знака.
     */
    expect(describeChange(applied(['body']), defaultTexts, MOSCOW)).toBe(
      defaultTexts.resolver.noted(ITEM.text),
    );
  });
});

describe('changeButtons', () => {
  it('обычная правка — только отмена', () => {
    expect(changeButtons(applied(['deadlineAt']), defaultTexts, 'перенеси на пятницу')).toEqual(
      undoButtons('22222222-2222-4222-8222-222222222222', defaultTexts),
    );
  });

  it('заголовок остался прежним — рядом кнопка его поправить', () => {
    const buttons = changeButtons(applied(['body']), defaultTexts, 'нет, в 9 30');

    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.action).toContain(UNDO_PREFIX);
    expect(buttons[1]?.label).toBe(defaultTexts.resolver.buttonEditTitle);
  });

  it('кнопка ведёт в тот же обработчик, что «Изменить» на карточке', () => {
    /**
     * Своего обработчика ей не нужно — нужен тот же префикс. Разъедься
     * они, и нажатие перестало бы находиться: сообщения с кнопками
     * остаются в переписке навсегда.
     */
    const buttons = changeButtons(applied(['body']), defaultTexts, 'нет, в 9 30');

    expect(buttons[1]?.action).toBe(`${CARD_ACTION.edit}${toShortId(ITEM.id)}`);
  });
});
