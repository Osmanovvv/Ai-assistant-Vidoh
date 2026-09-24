import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { namesNoDeed } from '../modules/resolver/deixis.js';
import { loadResolverCases } from './resolver-dataset.js';

/**
 * Стражи наборов резолвера (план docs/26, ворота А и задача 5).
 *
 * Наборы лежат в `docs/`, вне репозитория: где их нет, проверка
 * пропускается, а не зеленеет вслепую — пропуск виден в выводе vitest.
 */

const here = dirname(fileURLToPath(import.meta.url));
const docs = resolve(here, '../../../../docs/eval');
const dialogSet = resolve(docs, 'resolver-dialog');
const oldSet = resolve(docs, 'resolver');

describe.skipIf(!existsSync(dialogSet))('набор resolver-dialog', () => {
  it('каждый случай несёт разговор — иначе он мерит не то', async () => {
    const cases = await loadResolverCases(dialogSet);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.filter((item) => item.dialog.length === 0).map((item) => item.id)).toEqual([]);
  });

  it('каждый случай в бою доходит до модели: правило кода его не перехватывает', async () => {
    // Стенд зовёт resolveSegment напрямую, а бой перед ним пропускает
    // сказанное через правила кода (`namesNoDeed` → последнее обсуждённое).
    // Случай, который правило перехватит раньше модели, мерил бы путь,
    // которого в бою нет.
    const cases = await loadResolverCases(dialogSet);
    expect(cases.filter((item) => namesNoDeed(item.segment)).map((item) => item.id)).toEqual([]);
  });
});

describe.skipIf(!existsSync(oldSet))('старый набор resolver (35 случаев)', () => {
  it('без разговора — его вход модели не меняется, перемеривать не нужно', async () => {
    const cases = await loadResolverCases(oldSet);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.filter((item) => item.dialog.length > 0).map((item) => item.id)).toEqual([]);
  });
});
