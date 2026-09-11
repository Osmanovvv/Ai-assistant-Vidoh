import { afterEach, describe, expect, it, vi } from 'vitest';

import { PENDING_FIX_ENV } from '../../config/pending-fixes.js';

/**
 * Правка корня «будни» — под флагом, до замера (находка 10.09.2026).
 *
 * **Почему под флагом, а не просто так.** Правка выглядит как одна
 * буква, но меняет она не букву, а то, **какие сроки принимаются**:
 * `hasTimeWord` — единственная преграда выдуманным срокам, и любое её
 * расширение надо мерить, а не обсуждать. Замер 27.08.2026 показал, чем
 * кончается широкий список: десять выдуманных сроков из сорока трёх дел.
 *
 * Флаг нужен ровно затем, чтобы контрольный набор прогнать **дважды на
 * одних и тех же ответах модели** — «до» и «после», — и увидеть разницу
 * числом. Когда число будет, флаг уходит: правка либо становится
 * безусловной, либо не ставится вовсе.
 *
 * Оба состояния проверяются здесь, потому что страж обязан краснеть в
 * обе стороны: сломай правку — краснеет «после», сломай список —
 * краснеет «до».
 */

/** Свежий модуль под нужное состояние флага: он читается при загрузке. */
async function withFix(on: boolean): Promise<{
  hasTimeWord: (text: string) => boolean;
  resolveDeadline: typeof import('./dates.js').resolveDeadline;
}> {
  vi.resetModules();
  vi.stubEnv(PENDING_FIX_ENV.weekdayRoot, on ? '1' : '');

  const [words, dates] = await Promise.all([import('./time-words.js'), import('./dates.js')]);

  return { hasTimeWord: words.hasTimeWord, resolveDeadline: dates.resolveDeadline };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Четверг, 27 августа 2026, полдень по Москве — как у соседних тестов. */
const NOW = new Date('2026-08-27T09:00:00.000Z');
const ZONE = 'Europe/Moscow';

/** Формы, которых сегодняшний корень «будни» не ловит. */
const FORMS = ['по будням', 'в буднях', 'до будней', 'буднями'];

describe('корень «будни» до правки', () => {
  for (const text of FORMS) {
    it(`времени в «${text}» не видит`, async () => {
      const { hasTimeWord } = await withFix(false);
      expect(hasTimeWord(text)).toBe(false);
    });
  }

  it('срок «по будням» отбрасывается', async () => {
    const { resolveDeadline } = await withFix(false);

    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'по будням собирать сыну обед в школу' },
    );

    expect(outcome.ok).toBe(false);
  });
});

describe('корень «будни» после правки', () => {
  for (const text of FORMS) {
    it(`видит время в «${text}»`, async () => {
      const { hasTimeWord } = await withFix(true);
      expect(hasTimeWord(text)).toBe(true);
    });
  }

  it('срок «по будням» проходит — и без всякой цитаты', async () => {
    const { resolveDeadline } = await withFix(true);

    const outcome = resolveDeadline(
      { deadline: '2026-08-28', accuracy: 'day' },
      { now: NOW, timeZone: ZONE, said: 'по будням собирать сыну обед в школу' },
    );

    expect(outcome.ok).toBe(true);
  });

  /**
   * Расширение корня не должно расширять проверку **вообще**.
   *
   * Список узок намеренно: широкая первая версия пропустила выдуманные
   * годовщины и дни рождения. Поэтому здесь стоят слова, которые «будн»
   * могло бы задеть подстрокой, и те же самые «не время», что у соседей.
   */
  const stillWithoutTime = [
    'поздравить с днём рождения',
    'спланировать годовщину родителей',
    'купить пуфики',
    'записаться к ортопеду',
    'не забудь наклеить марку',
    'разбудить сына пораньше',
    'пробуждение даётся тяжело',
    'судно вернулось в порт',
  ];

  for (const text of stillWithoutTime) {
    it(`по-прежнему не видит времени в «${text}»`, async () => {
      const { hasTimeWord } = await withFix(true);
      expect(hasTimeWord(text)).toBe(false);
    });
  }
});
