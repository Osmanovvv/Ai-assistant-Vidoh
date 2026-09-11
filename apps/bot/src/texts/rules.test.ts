import { afterEach, describe, expect, it } from 'vitest';

import { applyOverrides, defaultTexts, profiles, textsFor } from './index.js';
import {
  BESIDE_QUESTION,
  besideQuestionRefusal,
  editableReplies,
  NOT_EDITABLE,
  refusalFor,
  render,
  repliesOf,
} from './rules.js';

/**
 * Правила §13 на записи и склейка правок со словарём (задача 4.13).
 *
 * До редактора текстов правки приезжали выкладкой — через прогон и чужой
 * взгляд. §13.9 требует менять тексты **без выкладки**, значит правка
 * попадает людям сразу, и единственное, что стоит между ней и человеком,
 * — эти проверки.
 */

afterEach(() => {
  // Склейка живёт в модуле, поэтому её надо возвращать: иначе правка
  // одной проверки просочилась бы в соседнюю и разбирали бы не то.
  applyOverrides(new Map());
});

describe('что боту говорить нельзя (§13 на записи)', () => {
  it('пустую реплику не принимает: в этом месте бот промолчит', () => {
    // Молчание человек читает как поломку — и жалуется не на текст.
    expect(refusalFor('   ', 0)).toMatch(/пустой/iu);
  });

  it('двух вопросов не принимает и называет, сколько их', () => {
    /**
     * §13.2: «Вопрос — ровно один». Число в отказе не украшение: человек
     * правит текст и должен видеть, что именно нарушил.
     */
    const refusal = refusalFor('Разобрать дела? Или на сегодня хватит?', 0);

    expect(refusal).toMatch(/двух вопросов/iu);
    expect(refusal).toContain('2');
  });

  it('один вопрос — законно', () => {
    expect(refusalFor('С чего начнём?', 0)).toBeUndefined();
  });

  it('серию восклицательных не принимает', () => {
    expect(refusalFor('Готово!!', 0)).toMatch(/сериями/iu);
    expect(refusalFor('Готово!', 0)).toBeUndefined();
  });

  it('фразу из запретов §13.7 не принимает и называет её', () => {
    /**
     * Тем же списком, которым проверяется ответ модели: правило одно.
     * «Отдохни» — прямой запрет §13.7, продукт разгружает голову, а не
     * работает терапевтом.
     */
    const refusal = refusalFor('Поняла. Отдохни, а дела подождут.', 0);

    expect(refusal).toContain('отдохни');
    expect(refusal).toMatch(/13\.7/u);
  });

  it('украшательский эмодзи не принимает, а маркер валюты — принимает', () => {
    // §13.9: «эмодзи только как маркеры приоритета и статуса».
    expect(refusalFor('Готово 🎉', 0)).toMatch(/украшение/iu);
    expect(refusalFor('Месяц — 150 ⭐', 0)).toBeUndefined();
  });

  it('слишком длинную не принимает и называет оба числа', () => {
    // Длиннее предела Telegram сообщение просто не уедет, и человек
    // получит тишину вместо ответа.
    const refusal = refusalFor('я'.repeat(4_200), 0);

    expect(refusal).toContain('4200');
    expect(refusal).toContain('4096');
  });
});

describe('реплика рядом с вопросом (§13.2 на записи)', () => {
  it('один «?» не принимает: человек читает склейку, а вопрос там уже есть', () => {
    /**
     * Дефект ревизии второго этапа. Правило общего содержания разрешает
     * реплике один вопрос — и «Остальное никуда не убежит, хорошо?»
     * проходило запись. А в ответе §13.2 за ней идёт «С чего начнём?»,
     * и человек получал два вопроса, чего §13.2 запрещает дословно.
     */
    const refusal = refusalFor('Остальное никуда не убежит, хорошо?', 0, 'answer.restSaved');

    expect(refusal).toMatch(/одном ответе с вопросом/iu);
    expect(refusal).toMatch(/13\.2/u);
  });

  it('без вопроса — принимает: правило не запрещает всё разом', () => {
    expect(
      refusalFor('Остальное никуда не убежит, я держу.', 0, 'answer.restSaved'),
    ).toBeUndefined();
  });

  it('на реплику вне ответа не тянется: там один вопрос законен', () => {
    // Правило по роли, а не по всему словарю: «Пробные разборы кончились,
    // продлить?» — одиночная реплика, и второго вопроса в ней нет.
    expect(
      refusalFor('Пробные разборы кончились, продлить?', 0, 'limits.trialOver'),
    ).toBeUndefined();
  });

  it('реплики из кода своё же правило проходят, и список не гниёт', () => {
    /**
     * Список путей закрытый, значит гниёт первым: реплику переименуют, а
     * строка останется — и правило будет стеречь пустоту. Плюс правило
     * одно на запись и на словарь из кода: разойдись они — краснела бы
     * запись на том, что в коде считается годным.
     */
    for (const [name, profile] of Object.entries(profiles)) {
      const known = new Map(repliesOf(profile).map((one) => [one.path, one]));

      for (const path of BESIDE_QUESTION) {
        const reply = known.get(path);

        expect(reply, `${name}: реплики «${path}» в словаре нет`).toBeDefined();
        expect(besideQuestionRefusal(reply?.said ?? '?'), `${name}: ${path}`).toBeUndefined();
      }
    }
  });
});

describe('подстановки обязаны остаться на месте', () => {
  it('реплику без подстановки не принимает, если она там была', () => {
    /**
     * Самая дорогая правка из возможных: «Добавила подробность» вместо
     * «Добавила подробность к «...»» — человек не узнает, к чему именно,
     * и решит, что бот записал не туда.
     */
    expect(refusalFor('Добавила подробность.', 1)).toMatch(/оставьте \{1\}/iu);
  });

  it('с подстановкой — принимает', () => {
    expect(refusalFor('Добавила подробность к «{1}».', 1)).toBeUndefined();
  });

  it('называет, каких именно подстановок не хватает', () => {
    const refusal = refusalFor('Перенесла на {2}.', 2);

    expect(refusal).toContain('{1}');
  });

  it('лишнюю подстановку не принимает: заполнить её нечем', () => {
    // Иначе «{3}» осталось бы на экране как есть — человек прочтёт это
    // как поломку бота, и будет прав.
    expect(refusalFor('Готово, {3}.', 0)).toMatch(/нечего подставлять/iu);
    expect(refusalFor('Готово к «{1}» и {3}.', 1)).toMatch(/заполнить нечем/iu);
  });

  it('подставляет значения по номерам', () => {
    expect(render('Перенесла «{1}» на {2}.', ['зубной', 'пятницу'])).toBe(
      'Перенесла «зубной» на пятницу.',
    );
  });

  it('пропущенное значение подставляет пустотой, а не словом undefined', () => {
    // «undefined» на экране человек примет за поломку; дырка в тексте
    // читается хуже, но не врёт.
    expect(render('Готово: {1}.', [])).toBe('Готово: .');
  });
});

describe('правки из базы поверх словаря (§13.9)', () => {
  it('простая реплика заменяется, соседи остаются как в коде', () => {
    const wasNeighbour = defaultTexts.answer.added;

    applyOverrides(new Map([['limits.trialOver', 'Пробные разборы кончились.']]));

    expect(textsFor().limits.trialOver).toBe('Пробные разборы кончились.');
    expect(textsFor().answer.added).toBe(wasNeighbour);
  });

  it('параметризованная реплика остаётся функцией и подставляет значение', () => {
    /**
     * Форма не должна меняться: реплику зовут из кода с аргументами, и
     * подмена функции строкой уронила бы ответ человеку.
     */
    applyOverrides(new Map([['resolver.noted', 'Дописала к «{1}».']]));

    const noted = textsFor().resolver.noted;

    expect(typeof noted).toBe('function');
    expect(noted('зубной')).toBe('Дописала к «зубной».');
  });

  it('пустые правки возвращают словарь к тому, что в коде', () => {
    const fromCode = defaultTexts.limits.trialOver;

    applyOverrides(new Map([['limits.trialOver', 'Другое.']]));
    expect(textsFor().limits.trialOver).toBe('Другое.');

    applyOverrides(new Map());
    expect(textsFor().limits.trialOver).toBe(fromCode);
  });

  it('путь, которого в словаре нет, ничего не ломает', () => {
    // Такая строка останется в базе от переименованной реплики. Падать
    // на ней нельзя: бот отвечает человеку, а не разбирает наш переезд.
    applyOverrides(new Map([['такой.реплики.нет', 'Неважно.']]));

    expect(textsFor().limits.trialOver).toBe(defaultTexts.limits.trialOver);
  });

  it('словарь из кода правки не задевают', () => {
    /**
     * `defaultTexts` — словарь из кода, и проверки опираются на него.
     * Просочись сюда правка из базы — они начали бы краснеть от чужой
     * правки вместо поломки.
     */
    const before = defaultTexts.limits.trialOver;

    applyOverrides(new Map([['limits.trialOver', 'Правка.']]));

    expect(defaultTexts.limits.trialOver).toBe(before);
  });

  it('склейка не меняет форму словаря: строки остаются строками, функции функциями', () => {
    /**
     * Форма — то, чем склейка может навредить молча. Реплику зовут из
     * кода: подмена функции строкой уронила бы ответ человеку прямо в
     * разборе, а подмена строки функцией — на экране.
     *
     * Проверять содержание патченного словаря по исходнику нельзя, и это
     * выяснилось здесь же: у переопределённой реплики исходник — обёртка
     * склейки, слов в нём нет вовсе. Значит содержание правки проверяется
     * на записи (там текст пишет человек), а здесь — форма.
     */
    applyOverrides(
      new Map([
        ['limits.trialOver', 'Пробные разборы кончились.'],
        ['resolver.noted', 'Дописала к «{1}».'],
      ]),
    );

    const fromCode = repliesOf(defaultTexts);
    const patched = repliesOf(textsFor());

    expect(patched.length).toBe(fromCode.length);

    const shapeOf = (list: readonly { path: string; places: number }[]): readonly string[] =>
      list.map((one) => `${one.path}: ${one.places > 0 ? 'с подстановкой' : 'простая'}`);

    expect(shapeOf(patched)).toEqual(shapeOf(fromCode));
  });

  it('нередактируемые реплики названы, существуют и объяснены', () => {
    /**
     * Список исключений гниёт первым: реплику переименуют, а строка
     * останется — и редактор молча спрячет не то. Плюс причина обязана
     * быть словами: «почему нельзя» должно читаться.
     */
    const known = new Set(repliesOf(defaultTexts).map((one) => one.path));

    for (const [path, why] of NOT_EDITABLE) {
      expect(known.has(path), `${path}: такой реплики в словаре нет`).toBe(true);
      expect(why.length, `${path}: причина не названа`).toBeGreaterThan(20);
    }

    expect(editableReplies(defaultTexts).length).toBe(known.size - NOT_EDITABLE.size);
  });
});
