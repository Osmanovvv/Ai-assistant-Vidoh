import { describe, expect, it } from 'vitest';

import { BadPinError, parsePins } from './pins.js';

/**
 * Флаг `--use стадия=версия` (задача 4.8).
 *
 * Он существует ради одной связки: §15 разрешает править промпт из
 * панели, §10.3 запрещает включать непрогнанную версию. Без прогона
 * конкретной версии эти два требования запирают друг друга насмерть.
 */

describe('разбор прикреплений', () => {
  it('без флага — пусто, а пути остаются на месте', () => {
    const { pinned, rest } = parsePins(['../../docs/eval']);

    expect(pinned.size).toBe(0);
    expect(rest).toEqual(['../../docs/eval']);
  });

  it('понимает и «--use a=b», и «--use=a=b»', () => {
    // Человек напишет любую из двух; падать на второй — мелочно.
    expect(parsePins(['--use', 'classifier=classifier@6']).pinned.get('classifier')).toBe(
      'classifier@6',
    );
    expect(parsePins(['--use=classifier=classifier@6']).pinned.get('classifier')).toBe(
      'classifier@6',
    );
  });

  it('не съедает путь, стоящий после флага', () => {
    /**
     * Позиционный аргумент — папка набора. Съеденный флагом, он превратил
     * бы прогон в «использование:» и человек потерял бы время, не поняв
     * почему.
     */
    const { pinned, rest } = parsePins(['--use', 'router=router@2', '../../docs/eval']);

    expect(pinned.get('router')).toBe('router@2');
    expect(rest).toEqual(['../../docs/eval']);
  });

  it('версия с собаками и дефисами не рвётся по первому знаку равно', () => {
    const { pinned } = parsePins(['--use', 'classifier=classifier@1-hotfix-20260907T1030']);

    expect(pinned.get('classifier')).toBe('classifier@1-hotfix-20260907T1030');
  });

  it('несколько стадий разом', () => {
    const { pinned } = parsePins(['--use', 'router=router@2', '--use', 'extractor=extractor@3']);

    expect(pinned.get('router')).toBe('router@2');
    expect(pinned.get('extractor')).toBe('extractor@3');
  });

  it('выдуманная стадия — отказ, а не молчаливый пропуск', () => {
    /**
     * Молчаливый пропуск здесь стоил бы прогона: набор отработал бы на
     * активной версии, отчёт лёг бы в папку, а заслон потом сказал бы
     * «мерили не то» — уже после того, как деньги ушли.
     */
    expect(() => parsePins(['--use', 'выдумка=1'])).toThrow(BadPinError);
  });

  it('стадия без версии — тоже отказ', () => {
    expect(() => parsePins(['--use', 'router='])).toThrow(BadPinError);
    expect(() => parsePins(['--use', 'router'])).toThrow(BadPinError);
  });
});
