import { afterEach, describe, expect, it, vi } from 'vitest';

import { PENDING_FIX_ENV } from '../../config/pending-fixes.js';

/**
 * Якорь правила повторения при отвергнутом сроке (находка 10.09.2026).
 *
 * Починка 10.09.2026 велела брать якорь из **проверенного** срока: без
 * этого «каждый четверг» после первого «сделано» навсегда становилось
 * «каждой средой». Но там, где проверенного срока нет, якорем осталась
 * строка модели — как было.
 *
 * Разведка предлагала выбрасывать правило вместе с отвергнутым сроком.
 * Скептик показал цену: «по будням» — законное `weekdays` без всякого
 * срока, и такая строгость его потеряет. Решение отложено до замера,
 * и флаг здесь ровно затем, чтобы замерить обе стороны на одних и тех же
 * ответах модели.
 *
 * **Решение вынесено в чистую функцию не для красоты.** Прежде оно
 * стояло двумя одинаковыми строками в двух местах — в разборе и в
 * правке, — а исходная регрессия жила ровно там: «дефект жил на двух
 * дорогах из четырёх». Два места принимают одно решение ровно до первой
 * правки в одном из них.
 */

async function withStrict(on: boolean): Promise<typeof import('./recurrence.js')> {
  vi.resetModules();
  vi.stubEnv(PENDING_FIX_ENV.strictRecurrenceAnchor, on ? '1' : '');

  return await import('./recurrence.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('якорь правила повторения', () => {
  it('проверенный срок побеждает строку модели — и до правки, и после', async () => {
    // Это и есть починка 10.09.2026: человек сказал четверг, модель
    // ответила средой, код исправил дату — якорь обязан быть четвергом.
    for (const strict of [false, true]) {
      const { recurrenceAnchor } = await withStrict(strict);

      expect(recurrenceAnchor({ verified: '2026-09-10', fromModel: '2026-09-09' })).toBe(
        '2026-09-10',
      );
    }
  });

  it('без проверенного срока сегодня берётся строка модели', async () => {
    const { recurrenceAnchor } = await withStrict(false);

    expect(recurrenceAnchor({ fromModel: '2026-09-07' })).toBe('2026-09-07');
  });

  it('под флагом строгости строка модели не берётся', async () => {
    const { recurrenceAnchor } = await withStrict(true);

    expect(recurrenceAnchor({ fromModel: '2026-09-07' })).toBe('');
  });

  it('строгость стоит «по будням» его правила — цена названа числом здесь', async () => {
    const { recurrenceAnchor, resolveRecurrence } = await withStrict(true);

    const resolved = resolveRecurrence({
      kind: 'weekdays',
      interval: 1,
      text: 'по будням',
      deadline: recurrenceAnchor({ fromModel: '2026-09-07' }),
    });

    expect(resolved.rule).toBeUndefined();
    expect(resolved.text).toBe('по будням');
    expect(resolved.problem).toBe('нет срока, на который опереться');
  });

  it('а с проверенным сроком строгость «по будням» не стоит ничего', async () => {
    // Ровно связь двух находок: почини корень «будни» — и у этого дела
    // появится настоящий срок, а значит и проверенный якорь.
    const { recurrenceAnchor, resolveRecurrence } = await withStrict(true);

    const resolved = resolveRecurrence({
      kind: 'weekdays',
      interval: 1,
      text: 'по будням',
      deadline: recurrenceAnchor({ verified: '2026-09-07', fromModel: '2026-09-07' }),
    });

    expect(resolved.rule?.kind).toBe('weekdays');
    expect(resolved.rule?.anchor).toBe('2026-09-07');
  });
});
