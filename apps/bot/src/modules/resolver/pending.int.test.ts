import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { batches, items, pendingQuestions, type Item } from '../../db/schema.js';
import { testDb } from '../../test/db.js';
import { upsertUser } from '../users/users.repo.js';
import { askQuestion } from './questions.repo.js';
import { settlePendingQuestion } from './pending.js';

/**
 * Судьба открытого вопроса при новой выгрузке (§7.3 ТЗ, задача 3.6).
 *
 * «Готово, когда: голосовой ответ на вопрос обрабатывается так же, как
 * нажатие кнопки.» Значит проверять надо не чтение слов — оно проверено
 * отдельно, — а последствия: изменилась ли запись, снялся ли вопрос, не
 * пропало ли сказанное.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');
const MOSCOW = 'Europe/Moscow';

let userId = '';
let batchId = '';
let item: Item;
let seq = 0;

async function ask(): Promise<void> {
  await askQuestion(testDb(), {
    userId,
    itemId: item.id,
    batchId,
    segment: 'нет, в пятницу',
    action: 'update',
    changes: {
      note: '',
      text: '',
      deadline: '2026-09-04',
      deadlineAccuracy: 'day',
      recurrenceKind: 'none',
      recurrenceInterval: 0,
      recurrenceText: '',
    },
    now: NOW,
  });
}

async function settle(answerText?: string) {
  return await settlePendingQuestion(testDb(), {
    userId,
    batchId,
    timeZone: MOSCOW,
    ...(answerText === undefined ? {} : { answerText }),
    now: NOW,
  });
}

async function reread(): Promise<Item> {
  const [row] = await testDb().select().from(items).where(eq(items.id, item.id));
  if (!row) throw new Error('запись пропала');
  return row;
}

async function draftTexts(): Promise<string[]> {
  const rows = await testDb().select().from(items).where(eq(items.isDraft, true));
  return rows.filter((row) => row.userId === userId).map((row) => row.text);
}

beforeEach(async () => {
  seq++;
  userId = (await upsertUser(testDb(), { tgId: 6100 + seq, firstName: 'Аня' })).id;

  const [batch] = await testDb()
    .insert(batches)
    .values({ userId, status: 'processing' })
    .returning({ id: batches.id });

  batchId = batch?.id ?? '';

  const [row] = await testDb()
    .insert(items)
    .values({
      userId,
      text: 'Записать сына к врачу в четверг',
      type: 'TASK',
      priority: 'SOON',
      topic: 'здоровье',
    })
    .returning();

  if (!row) throw new Error('запись не создалась');
  item = row;
});

describe('без открытого вопроса ничего не происходит', () => {
  it('обычная выгрузка проходит мимо', async () => {
    expect((await settle()).kind).toBe('none');
    expect((await settle('да')).kind).toBe('none');
  });
});

describe('ответ голосом делает то же, что кнопка', () => {
  it('«да, к прошлой» применяет отложенное изменение', async () => {
    await ask();

    const result = await settle('да, к прошлой');

    expect(result.kind).toBe('applied');
    expect(result.applied?.fields).toEqual(['deadlineAt', 'deadlineAccuracy']);
    expect((await reread()).deadlineAt?.toISOString()).toBe('2026-09-03T21:00:00.000Z');
  });

  it('изменение записывается как сделанное человеком, а не ботом', async () => {
    // Человек подтвердил его словами. Приписать это резолверу значило бы
    // соврать в истории, по которой потом разбирают жалобы.
    await ask();
    const result = await settle('да');

    const [revision] = await testDb().select().from(items).where(eq(items.id, item.id));
    expect(revision).toBeDefined();
    expect(result.applied?.revisionId).toBeDefined();
  });

  it('«это новое» возвращает сказанное в разбор этой же выгрузки', async () => {
    // Отдельного вызова модели не нужно: выгрузка всё равно сейчас
    // разбирается.
    await ask();

    const result = await settle('нет, это новое');

    expect(result.kind).toBe('separate');
    expect(result.carryOver).toBe('нет, в пятницу');
    expect((await reread()).deadlineAt).toBeNull();
  });

  it('«не знаю» ничего не меняет и не выдумывает записи', async () => {
    await ask();

    const result = await settle('да не знаю я');

    expect(result.kind).toBe('unclear');
    expect(result.carryOver).toBeUndefined();
    expect((await reread()).deadlineAt).toBeNull();
    // Сказанное при этом не пропало (§9.1).
    expect(await draftTexts()).toEqual(['нет, в пятницу']);
  });
});

describe('человек не ответил и прислал новое', () => {
  it('вопрос снимается, к нему бот не возвращается', async () => {
    // §7.3: «продукт не имеет права превращаться в допрос».
    await ask();

    const result = await settle();

    expect(result.kind).toBe('superseded');

    const [question] = await testDb()
      .select()
      .from(pendingQuestions)
      .where(eq(pendingQuestions.userId, userId));

    expect(question?.outcome).toBe('superseded');
  });

  it('сказанное сохраняется черновиком, а не задачей', async () => {
    // «Нет, в пятницу» как задача — это задача «в пятницу». Тот же довод
    // второй этап уже применил к правкам: лучше черновик, чем бессмыслица
    // в списке дел.
    await ask();
    await settle();

    expect(await draftTexts()).toEqual(['нет, в пятницу']);
  });

  it('запись, о которой спрашивали, остаётся нетронутой', async () => {
    await ask();
    await settle();

    expect((await reread()).deadlineAt).toBeNull();
  });
});

describe('слова сверх ответа не пропадают (§9.1, задача 3.44)', () => {
  it('«к прошлой, и ещё купить чехол»: правка применена, остаток в черновике', async () => {
    await ask();

    const result = await settle('да, к прошлой, и ещё купить чехол');

    expect(result.kind).toBe('applied');
    expect(result.leftoverSaved).toBe(true);
    expect(await draftTexts()).toContain('купить чехол');
  });

  it('«это новое, и купить хлеб»: сказанное в разбор, остаток в черновике', async () => {
    await ask();

    const result = await settle('нет, это новое, и купить хлеб');

    expect(result.kind).toBe('separate');
    expect(result.carryOver).toBe('нет, в пятницу');
    expect(result.leftoverSaved).toBe(true);
    expect(await draftTexts()).toContain('купить хлеб');
  });

  it('короткий ответ черновиков не плодит', async () => {
    await ask();

    const result = await settle('да, к прошлой');

    expect(result.leftoverSaved).toBe(false);
    expect(await draftTexts()).toEqual([]);
  });

  it('мысль вместо ответа: вопрос снят, сказанное сохранено, мысль уходит в разбор', async () => {
    // Живой прогон 03.09.2026: «добавь ещё купить чехол для зонта»
    // прочиталось как «добавь к прошлой», и чехол пропал.
    await ask();

    const result = await settle('добавь ещё купить чехол для зонта');

    expect(result.kind).toBe('superseded');
    expect(result.carryOver).toBe('добавь ещё купить чехол для зонта');
    // Запись, о которой спрашивали, не тронута.
    expect((await reread()).deadlineAt).toBeNull();
    // Сказанное к вопросу — черновиком, как при любом снятом вопросе.
    expect(await draftTexts()).toContain('нет, в пятницу');
  });
});

/**
 * Ответ «это новое», не доехавший до разбора (задача 3.79).
 *
 * **Найдено встречной проверкой 06.09.2026 — это потеря слов человека.**
 * Разбор сперва помечает вопрос отвеченным, а потом возвращает сказанное
 * в разбор. Сорвись разбор после этого — модель недоступна, потолок
 * расхода перейдён, — выгрузка вернётся в очередь и разберётся снова, но
 * открытого вопроса уже нет: отрезок из ответа пропадал молча, притом
 * что остальная выгрузка разбиралась.
 */
describe('режим правки доезжает и голосом (задача 3.82)', () => {
  it('«к прошлой» на вопрос про дополнение дописывает подробность', async () => {
    /**
     * §7.3 требует прямо: голосовой ответ обрабатывается так же, как
     * нажатие кнопки. Без режима оба применялись заменой, и подробность
     * из вопроса выбрасывалась — человек получал «Добавила к прошлой»,
     * а в записи не появлялось ничего.
     */
    await askQuestion(testDb(), {
      userId,
      itemId: item.id,
      batchId,
      segment: 'а ещё туда надо взять карту прививок',
      action: 'update',
      mode: 'append',
      changes: {
        note: 'взять карту прививок',
        text: '',
        deadline: '',
        deadlineAccuracy: 'none',
        recurrenceKind: 'none',
        recurrenceInterval: 0,
        recurrenceText: '',
      },
      now: NOW,
    });

    const outcome = await settle('к прошлой');
    expect(outcome.kind).toBe('applied');

    const after = await reread();
    expect(after.body).toBe('взять карту прививок');
    expect(after.text).toBe(item.text);
  });
});

describe('повтор выгрузки не теряет ответ на вопрос', () => {
  it('второй заход той же выгрузки возвращает отрезок в разбор', async () => {
    await ask();

    // Первый заход: вопрос закрыт, отрезок отдан в разбор — и тут разбор
    // сорвался, выгрузка вернулась в очередь.
    const first = await settle('это новое');
    expect(first).toMatchObject({ kind: 'separate', carryOver: 'нет, в пятницу' });

    // Второй заход той же выгрузки: открытого вопроса нет, но отрезок
    // обязан вернуться в разбор, а не пропасть.
    const second = await settle('это новое');
    expect(second).toMatchObject({ kind: 'separate', carryOver: 'нет, в пятницу' });
  });

  it('отрезок возвращается и без повторного ответа человека', async () => {
    // На втором заходе человек ничего не говорит: выгрузка та же, и её
    // текст уже разобран. Отрезок всё равно должен доехать.
    await ask();
    await settle('это новое');

    expect(await settle()).toMatchObject({ kind: 'separate', carryOver: 'нет, в пятницу' });
  });

  describe('чего делать нельзя', () => {
    it('чужую выгрузку это не задевает', async () => {
      /**
       * Условие узкое нарочно: вопрос закрыт «это новое» **этой же**
       * выгрузкой. Иначе любая следующая выгрузка человека тащила бы за
       * собой давно разобранный отрезок и заводила его повторно.
       */
      await ask();
      await settle('это новое');

      const [other] = await testDb()
        .insert(batches)
        .values({ userId, status: 'queued', openedAt: NOW })
        .returning();

      const outcome = await settlePendingQuestion(testDb(), {
        userId,
        batchId: other?.id ?? '',
        timeZone: MOSCOW,
        answerText: 'это новое',
        now: NOW,
      });

      expect(outcome.kind).toBe('none');
    });

    it('ответ «к прошлой» назад не возвращается', async () => {
      // Правка уже применена к записи. Вернуть отрезок в разбор значило
      // бы завести из него ещё и отдельное дело.
      await ask();
      await settle('к прошлой');

      expect((await settle('к прошлой')).kind).toBe('none');
    });

    it('снятый по тишине вопрос назад не возвращается', async () => {
      // Он ушёл в черновик — там и остаётся, иначе получим две копии.
      await ask();
      await settle();

      expect((await settle()).kind).toBe('none');
    });
  });
});

describe('вопрос сняли, пока шла расшифровка (§9.1)', () => {
  /**
   * Ревизия этапов 1–2, молчаливый отказ 14.
   *
   * Кнопку нажали, пока шли расшифровка и маршрутизация: к моменту
   * применения ответа вопроса уже нет. Саму правку применила та кнопка —
   * повторять её нельзя. А вот сказанное **сверх** ответа выбрасывалось
   * молча: ни записи, ни черновика, ни строки в журнале.
   *
   * Если ответ был всей выгрузкой, человек получал «Я здесь. Расскажешь,
   * что в голове?» на только что сказанное — то есть «я тебя не слышала».
   */

  it('слова сверх ответа сохраняются черновиком', async () => {
    // Вопроса нет вовсе: ровно то, что видит разбор после нажатия кнопки.
    const result = await settle('да, к прошлой, и ещё купить чехол');

    expect(result.kind).toBe('none');
    expect(result.leftoverSaved, 'слова сверх ответа пропали молча').toBe(true);
    expect(await draftTexts()).toContain('купить чехол');
  });

  it('голое «да» черновика не заводит', async () => {
    // Содержания в нём нет, кнопка своё сделала. Черновик из пустоты —
    // это шум в панели и в бэклоге человека.
    const result = await settle('да');

    expect(result.kind).toBe('none');
    expect(result.leftoverSaved).toBeUndefined();
    expect(await draftTexts()).toEqual([]);
  });

  it('повтор выгрузки не кладёт черновик второй раз', async () => {
    /**
     * Выгрузка возвращается в очередь при нашем простое и разбирается
     * снова — до пяти раз. Без сверки человек получил бы пять копий
     * одного черновика и пять реплик «Остальное сохранила отдельно».
     */
    await settle('да, к прошлой, и ещё купить чехол');
    const again = await settle('да, к прошлой, и ещё купить чехол');

    expect(again.leftoverSaved, 'черновик положен второй раз').toBeUndefined();
    expect(await draftTexts()).toEqual(['купить чехол']);
  });
});
