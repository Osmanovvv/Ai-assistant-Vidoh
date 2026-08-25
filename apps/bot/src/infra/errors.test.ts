import { describe, expect, it } from 'vitest';

import { PermanentLlmError, TransientLlmError } from '../modules/ai/providers/types.js';
import { PermanentSpeechError, TransientSpeechError } from '../modules/speech/providers/types.js';
import { isTransientFailure } from './errors.js';

/**
 * От этого решения зависит судьба выгрузки: повторить или похоронить.
 * Поэтому проверяется на настоящих формах ошибок, а не на выдуманных.
 */

describe('isTransientFailure', () => {
  it('узнаёт обрыв соединения внутри «fetch failed»', () => {
    // Ровно то, на чём встала первая настоящая запись. undici отдаёт
    // наружу безликое «fetch failed», а код лежит на два уровня вглубь,
    // внутри AggregateError от перебора адресов.
    const attempts = new AggregateError(
      [Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
      '',
    );
    const error = new TypeError('fetch failed', { cause: attempts });

    expect(isTransientFailure(error)).toBe(true);
  });

  it('узнаёт код прямо на ошибке', () => {
    expect(isTransientFailure(Object.assign(new Error('обрыв'), { code: 'ECONNRESET' }))).toBe(
      true,
    );
  });

  it('узнаёт таймаут заголовков undici', () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), {
      code: 'UND_ERR_HEADERS_TIMEOUT',
    });

    expect(isTransientFailure(new TypeError('fetch failed', { cause }))).toBe(true);
  });

  it('доверяет разделению, которое сделал провайдер', () => {
    expect(isTransientFailure(new TransientSpeechError('распознаватель занят'))).toBe(true);
    expect(isTransientFailure(new PermanentSpeechError('битый файл'))).toBe(false);
  });

  it('так же доверяет провайдеру языковой модели', () => {
    // Это и есть та связка, из-за которой недоступность модели не теряет
    // выгрузку: временная ошибка возвращает её в очередь, а не хоронит.
    expect(isTransientFailure(new TransientLlmError('модель занята'))).toBe(true);
    expect(isTransientFailure(new PermanentLlmError('ключ не тот'))).toBe(false);
  });

  it('постоянная ошибка провайдера не становится временной из-за причины', () => {
    // Иначе отказ по ключу крутился бы в повторах до конца времён.
    const cause = Object.assign(new Error('обрыв'), { code: 'ECONNRESET' });

    expect(isTransientFailure(new PermanentSpeechError('нет доступа', cause))).toBe(false);
  });

  it('неизвестную ошибку считает постоянной', () => {
    // Ошибка в нашем коде не станет правильной от повтора, а цикл
    // повторов на ней сжигает деньги и прячет причину.
    expect(isTransientFailure(new Error('не нашёл выгрузку'))).toBe(false);
    expect(isTransientFailure(new TypeError('x is not a function'))).toBe(false);
  });

  it('не спотыкается на пустоте и на строках', () => {
    expect(isTransientFailure(undefined)).toBe(false);
    expect(isTransientFailure(null)).toBe(false);
    expect(isTransientFailure('ETIMEDOUT')).toBe(false);
  });

  it('не зацикливается на закольцованной причине', () => {
    const loop = new Error('первая');
    Object.assign(loop, { cause: loop });

    expect(isTransientFailure(loop)).toBe(false);
  });

  it('код на четвёртом уровне вложенности всё ещё находится', () => {
    const deep = Object.assign(new Error('дно'), { code: 'EAI_AGAIN' });
    const error = new Error('1', {
      cause: new Error('2', { cause: new Error('3', { cause: deep }) }),
    });

    expect(isTransientFailure(error)).toBe(true);
  });
});
