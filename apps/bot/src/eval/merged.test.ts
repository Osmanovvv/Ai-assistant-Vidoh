import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MockLlmProvider } from '../modules/ai/providers/mock.js';
import { loadDataset } from './dataset.js';
import { runMergedDataset } from './merged.js';
import { collect, shares } from './report.js';

/**
 * Проверка инструмента замера объединённого разбора (задача 2.20).
 *
 * Сам замер делается на живой модели и в тесты не входит: он стоит денег
 * и меняется только вместе с промптом. А вот инструмент обязан быть
 * проверенным — иначе числа, по которым принимается решение об
 * объединении, ничем не подтверждены.
 *
 * Проверяется то же, что у обычного стенда: верный ответ даёт полную
 * точность, испорченный — видимую просадку, поправки за моделью
 * применяются, отказ модели считается отказом, а не тихим нулём.
 */

const SYNTHETIC = join(import.meta.dirname, 'synthetic');
const PROMPT = 'разбери поток на записи';

const item = (
  text: string,
  type: string,
  priority: string,
  topic: string,
): Record<string, unknown> => ({
  text,
  type,
  priority,
  topic,
  isProject: false,
  deadline: '',
  deadlineAccuracy: 'none',
  recurrenceKind: 'none',
  recurrenceInterval: 0,
  recurrenceText: '',
  deadlineText: '',
});

const GOOD = JSON.stringify({
  items: [
    item('купить продукты', 'TASK', 'SOON', 'покупки'),
    item('записаться к врачу', 'TASK', 'SOON', 'здоровье'),
    item('начать бегать по утрам', 'DESIRE', 'NONE', 'личное'),
    item('я ничего не успеваю', 'EMOTION', 'NONE', 'личное'),
  ],
});

async function known() {
  return (await loadDataset(SYNTHETIC)).filter((one) => one.id === 'synthetic-known');
}

describe('объединённый разбор', () => {
  it('на верном ответе даёт полную точность одним вызовом', async () => {
    const provider = new MockLlmProvider({ respond: () => GOOD });

    const report = collect(
      await runMergedDataset({ provider, prompt: PROMPT }, await known(), 'merged@test'),
    );

    expect(provider.callCount).toBe(1);
    expect(report.found).toBe(4);
    expect(report.missed).toBe(0);
    expect(shares(report).type).toBe(1);
  });

  it('поправки за моделью применяются те же, что в обычном пути', async () => {
    // Ради этого поправки и вынесены отдельной функцией: путь с одним
    // вызовом и путь с двумя обязаны одинаково соблюдать §6.2 и §6.3,
    // иначе сравнение измеряет не объединение, а наличие правил.
    const provider = new MockLlmProvider({
      respond: () =>
        JSON.stringify({
          items: [
            // Важность у желания и тема не из списка человека.
            item('начать бегать по утрам', 'DESIRE', 'NOW', 'спорт'),
          ],
        }),
    });

    const outcomes = await runMergedDataset(
      { provider, prompt: PROMPT },
      await known(),
      'merged@test',
    );

    const only = outcomes[0]?.result.matched[0]?.actual;
    expect(only?.priority).toBe('NONE');
    expect(only?.topic).toBe('личное');
  });

  it('на испорченном ответе просадка видна', async () => {
    const broken = new MockLlmProvider({
      respond: () =>
        JSON.stringify({
          items: [
            item('купить продукты', 'TASK', 'SOON', 'покупки'),
            // §6.2: желание стало задачей.
            item('бегать по утрам', 'TASK', 'NOW', 'личное'),
          ],
        }),
    });

    const report = collect(
      await runMergedDataset({ provider: broken, prompt: PROMPT }, await known(), 'merged@test'),
    );

    expect(report.missed).toBeGreaterThan(0);
    expect(report.falseTasksFromDesires).toBe(1);
  });

  it('ответ не по схеме — это отказ, а не пустой разбор', async () => {
    // Тихий нуль выглядел бы в отчёте как «модель ничего не нашла», и
    // причину искали бы в промпте, а она в форме ответа.
    const provider = new MockLlmProvider({ respond: () => '{"items":[{"text":"без типа"}]}' });

    const outcomes = await runMergedDataset(
      { provider, prompt: PROMPT },
      await known(),
      'merged@test',
    );

    expect(outcomes[0]?.failed).toBe('ответ не прошёл схему');
  });

  it('на кризисном случае модель не спрашивается вовсе', async () => {
    // §13.7: свойство «на настоящем кризисе не тратим ни копейки» не
    // должно зависеть от того, сколько вызовов в разборе.
    const provider = new MockLlmProvider({ respond: () => GOOD });
    const crisis = (await loadDataset(SYNTHETIC)).filter((one) => one.id === 'synthetic-crisis');

    const report = collect(
      await runMergedDataset({ provider, prompt: PROMPT }, crisis, 'merged@test'),
    );

    expect(provider.callCount).toBe(0);
    expect(report.crisisDetected).toBe(1);
  });
});
