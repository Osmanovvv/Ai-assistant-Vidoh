import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { UnknownSchemaError } from '../schemas/index.js';
import { promptFailureAdvice, PromptNotFoundError, SchemaMismatchError } from './registry.js';

/**
 * Сторож выкладки называет причину, а не одну на всех.
 *
 * Ревизия этапов 1–2, молчаливый отказ. `check-prompts.ts` сваливал четыре
 * причины в `catch {}` и печатал «Залейте промпты», а выкладка повторяла
 * тот же совет. Для расхождения схемы он бесполезен — залитую версию
 * `seedPrompt` не переписывает; для отказа базы он лжёт: «промптов нет»
 * вместо «проверить не смогли». Всё это время бот уже поднят и хоронит
 * выгрузки, а красная строка выкладки посылает чинить не туда.
 *
 * Совет проверяется **поведением**, связка — по исходнику: скрипт живёт на
 * верхнем уровне с побочными действиями, и позвать его проверка не может.
 */

describe('совет зависит от причины', () => {
  it('заливки не было — звать заливку', () => {
    const advice = promptFailureAdvice(new PromptNotFoundError('router'));

    expect(advice).toContain('seed-prompts.sh');
  });

  it('схема в базе разошлась с кодом — заливка не поможет, и это сказано', () => {
    const advice = promptFailureAdvice(
      new SchemaMismatchError('router', 'router@2', 'RouterAnswer'),
    );

    expect(advice, 'советуют перезалить то, что перезаливка не меняет').not.toContain(
      'seed-prompts.sh',
    );
    expect(advice).toMatch(/не поможет/u);
  });

  it('схемы нет в коде — звать выкладку, а не заливку', () => {
    const advice = promptFailureAdvice(new UnknownSchemaError('RouterAnswer'));

    expect(advice).not.toContain('seed-prompts.sh');
    expect(advice, 'не сказано, что чинится выкладкой кода').toMatch(/выложить|выкладк/u);
  });

  it('отказ базы не выдаётся за отсутствие промптов', () => {
    /**
     * Пул соединений ленив, и «база не ответила» прилетает в тот же
     * `catch`. Ноль вместо «не смогли» — та же ложь, и здесь она стоила
     * бы выкладке рецепта «залейте залитое».
     */
    const advice = promptFailureAdvice(new Error('ECONNREFUSED 127.0.0.1:5432'));

    expect(advice).not.toContain('seed-prompts.sh');
    expect(advice).toMatch(/базе/u);
  });
});

describe('связка: сторож печатает причину и совет', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = readFileSync(resolve(here, '../../../scripts/check-prompts.ts'), 'utf8');
  const deploy = readFileSync(resolve(here, '../../../../../../ops/deploy.sh'), 'utf8');

  it('причина каждого этапа печатается, а не теряется', () => {
    // Не «есть ли слово promptFailureAdvice»: собрать причины и не
    // напечатать их — ровно тот отказ, которым находка и была.
    expect(script, 'причина отказа не печатается').toMatch(/stderr\.write\([^)]*item\.why/u);
  });

  it('совет печатается тоже', () => {
    expect(script, 'совет собран и не напечатан').toMatch(/stderr\.write\([^)]*advice/u);
  });

  it('причина не глотается пустым catch', () => {
    /**
     * Комментарии срезаются: прежний приём тут принято описывать словами,
     * и без чистки страж покраснел бы от собственного объяснения. Это уже
     * случалось в проекте не раз.
     */
    const code = script.replace(/\/\*[\s\S]*?\*\//gu, '');
    const guarded = code.slice(code.indexOf('for (const stage of stages)'));

    expect(/catch\s*\{/u.test(guarded.slice(0, 400)), 'причина снова глотается').toBe(false);
  });

  it('выкладка не советует заливку поверх чужого разбора', () => {
    /**
     * Запрет — по команде, а не по вежливой форме глагола: «Залейте» и
     * «Залить» — один и тот же неверный рецепт, и страж на фразу
     * обходился бы одной буквой.
     */
    const branch = deploy.slice(deploy.indexOf('Проверяю активные промпты'));

    expect(
      branch.slice(0, 900).includes('seed-prompts.sh'),
      'выкладка снова зовёт заливку, не зная причины',
    ).toBe(false);
  });
});
