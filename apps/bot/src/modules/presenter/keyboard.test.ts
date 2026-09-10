import { describe, expect, it } from 'vitest';

import type { Item } from '../../db/schema.js';
import { cardKeyboard } from '../../bot/handlers/card.js';

import { keyboardOf as keyboardOfAwaiting } from '../../bot/handlers/awaiting.js';
import { keyboardOf as keyboardOfOnboarding } from '../../bot/handlers/onboarding.js';
import {
  offerTopicsQuestion,
  questionFor,
  timezoneQuestion,
  topicRows,
  STEP,
  type Question,
} from '../onboarding/onboarding.service.js';
import { defaultTexts } from '../../texts/index.js';
import { fitKeyboard, packButtons, packRows, rowFits } from './keyboard.js';

/**
 * Раскладка кнопок по ширине (дефект найден на телефоне 01.09.2026).
 *
 * Проверяется не «сколько кнопок в строке», а **влезает ли подпись**:
 * дефект был именно в том, что число кнопок считали, а длину подписи —
 * нет. Поэтому в таблицах ниже стоят настоящие подписи продукта, а не
 * «кнопка 1» и «кнопка 2»: на выдуманных коротких словах эта ошибка и
 * прожила до боевого бота.
 */

const button = (label: string) => ({ label, action: `a:${label}` });
const labelsOf = (rows: readonly (readonly { readonly label: string }[])[]): string[][] =>
  rows.map((row) => row.map((one) => one.label));

const answer = defaultTexts.answer;

describe('строка из трёх кнопок §13.2', () => {
  const trio = [answer.buttonDoNow, answer.buttonShowAll, answer.buttonLater].map(button);

  it('«Оставить на потом» уезжает на свою строку', () => {
    // Ровно тот случай со скриншота: было «Остави…потом».
    expect(labelsOf(packButtons(trio))).toEqual([
      ['Сделать сейчас', 'Разобрать всё'],
      ['Оставить на потом'],
    ]);
  });

  it('порядок §13.2 сохраняется', () => {
    // Раскладка меняет строки, но не смысл: «Сделать сейчас» — первое.
    expect(
      packButtons(trio)
        .flat()
        .map((one) => one.label),
    ).toEqual([answer.buttonDoNow, answer.buttonShowAll, answer.buttonLater]);
  });

  it('ни одна кнопка не потерялась и не удвоилась', () => {
    expect(packButtons(trio).flat()).toHaveLength(trio.length);
  });
});

describe('пары кнопок продукта', () => {
  it.each([
    // Две короткие — остаются рядом, так удобнее.
    [[defaultTexts.reminders.buttonDone, defaultTexts.reminders.buttonPostpone], 1],
    [[defaultTexts.start.buttonVoice, defaultTexts.start.buttonText], 1],
    [[defaultTexts.resolver.buttonRemember, defaultTexts.resolver.buttonNoNeed], 1],
    [[defaultTexts.reminders.buttonProjectTake, defaultTexts.reminders.buttonProjectLater], 1],
    // Длинная — забирает строку себе.
    [[defaultTexts.resolver.buttonAttach, defaultTexts.resolver.buttonSeparate], 2],
    [[defaultTexts.resolver.buttonGoOn, defaultTexts.resolver.buttonEnough], 2],
    [[defaultTexts.returning.buttonContinue, defaultTexts.returning.buttonFresh], 2],
    [[defaultTexts.privacy.deleteFinalButton, defaultTexts.privacy.deleteCancelButton], 2],
  ])('%s → строк: %i', (labels, rows) => {
    expect(packButtons(labels.map(button))).toHaveLength(rows);
  });
});

describe('карточка записи', () => {
  it('раскладка карточки та, что уходит человеку', () => {
    /**
     * Раскладка берётся у `cardKeyboard`, а не собирается здесь руками.
     *
     * Прежде эта проверка складывала свою копию из четырёх подписей — и
     * когда у карточки появилась пятая кнопка «В другую сферу», осталась
     * зелёной, сторожа экран, которого больше нет. Тот же приём, за
     * который проект уже бил себя по рукам на клавиатуре опроса: страж
     * обязан смотреть на то, что уходит человеку.
     */
    const keyboard = cardKeyboard(
      {
        id: '11111111-1111-4111-8111-111111111111',
        text: 'Записать сына к врачу',
        topic: 'здоровье',
        status: 'new',
        deadlineAt: null,
        deadlineAccuracy: null,
      } as unknown as Item,
      defaultTexts,
      'menu',
    );

    expect(
      keyboard.inline_keyboard.map((row) => row.map((one) => ('text' in one ? one.text : ''))),
    ).toEqual([['Сделано', 'Отложить'], ['Изменить', 'Убрать'], ['В другую сферу'], ['Назад']]);
  });
});

describe('заданные строки не сливаются', () => {
  it('две строки по одной кнопке так и остаются двумя', () => {
    /**
     * Важнее, чем кажется. Соблазн «уплотнить» раскладку сломал бы
     * онбординг: там время «07:00» и «Не надо вечером» стоят отдельными
     * строками намеренно — это разные по смыслу ответы.
     */
    const rows = [[button('07:00')], [button('Не надо вечером')]];

    expect(labelsOf(packRows(rows))).toEqual([['07:00'], ['Не надо вечером']]);
  });

  it('широкая строка разбивается, соседняя не трогается', () => {
    const rows = [
      [button('Да'), button('Нет')],
      [button(answer.buttonDoNow), button(answer.buttonLater)],
    ];

    expect(labelsOf(packRows(rows))).toEqual([
      ['Да', 'Нет'],
      ['Сделать сейчас'],
      ['Оставить на потом'],
    ]);
  });
});

describe('правило ширины', () => {
  it('одинокой кнопке достаётся вся ширина', () => {
    expect(rowFits([defaultTexts.privacy.deleteFinalButton])).toBe(true);
  });

  it('та же подпись в паре уже не влезает', () => {
    // Самая широкая подпись продукта — «Да, удалить безвозвратно», 178
    // точек при замере. В целую строку входит, в половину — нет.
    expect(rowFits([defaultTexts.privacy.deleteFinalButton, 'Отмена'])).toBe(false);
  });

  it('считается ширина знаков, а не их число', () => {
    /**
     * Суть исправления правила. Первая версия считала знаки — и это была
     * та же ошибка, что и в самом дефекте, только на новый лад: «щ» вдвое
     * шире «г». Двадцать узких знаков уже, чем четырнадцать широких.
     */
    const narrow = 'г'.repeat(20);
    const wide = 'щ'.repeat(14);

    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(rowFits([narrow, narrow])).toBe(true);
    expect(rowFits([wide, wide])).toBe(false);
  });

  it('проверка ловит перебор, а не пропускает его', () => {
    // Страж, который врёт, хуже отсутствующего.
    expect(rowFits(['я'.repeat(31)])).toBe(false);
    expect(rowFits(['я'.repeat(15), 'я'.repeat(3)])).toBe(false);
    expect(rowFits(['я'.repeat(10), 'я'.repeat(3), 'я'.repeat(3)])).toBe(false);
  });

  it('пустая строка кнопок ничего не ломает', () => {
    // Сама grammY начинает клавиатуру с одной пустой строки, поэтому
    // проверяется то, что важно: кнопок нет ни одной.
    expect(packButtons([])).toEqual([]);
    expect(fitKeyboard([]).inline_keyboard.flat()).toEqual([]);
  });
});

describe('клавиатура собирается настоящая', () => {
  it('строки раскладки становятся строками Telegram', () => {
    const keyboard = fitKeyboard([
      [button(answer.buttonDoNow), button(answer.buttonShowAll), button(answer.buttonLater)],
    ]);

    expect(keyboard.inline_keyboard.map((row) => row.map((one) => one.text))).toEqual([
      ['Сделать сейчас', 'Разобрать всё'],
      ['Оставить на потом'],
    ]);
  });

  it('действия кнопок доезжают без изменений', () => {
    // Раскладка трогает строки, а не `callback_data`: перепутанное
    // действие — это нажатие не туда.
    const keyboard = fitKeyboard([[button(answer.buttonLater)]]);
    const [row] = keyboard.inline_keyboard;
    const [first] = row ?? [];

    expect(first && 'callback_data' in first ? first.callback_data : undefined).toBe(
      `a:${answer.buttonLater}`,
    );
  });
});

/**
 * Клавиатуры опроса — те самые, что уходят человеку (ревизия этапов).
 *
 * **Чего не видел прежний страж.** Ширину строк проверял `keyboards.test.ts`
 * — и оборачивал вопросы опроса в `fitKeyboard` **сам**. То есть мерил
 * разложенную копию, а не то, что собирает бот: оба обработчика опроса
 * строили клавиатуру своими руками, без раскладки. «Екатеринбург»,
 * «Красноярск» и «Владивосток» стояли по три в строке — ровно тот
 * обрезанный вид, из-за которого раскладку и написали 01.09.2026, — и в
 * хвосте висела лишняя пустая строка.
 *
 * Поэтому здесь клавиатуры берутся у **обработчиков**: обе `keyboardOf`
 * вывезены наружу именно для этого. Страж, который собирает предмет
 * проверки сам, проверяет только себя.
 */
const questionsOfOnboarding = (): { where: string; question: Question }[] => {
  const texts = defaultTexts;
  const found: { where: string; question: Question }[] = [];

  // Все шаги опроса, включая выбор сфер с отметками, — плюс два экрана,
  // которые `questionFor` не отдаёт: города и предложение сферы §6.4.
  for (const step of Object.values(STEP)) {
    const question = questionFor(step, { texts, name: 'Аня' });
    if (question) found.push({ where: `шаг ${String(step)}`, question });
  }

  found.push({ where: 'города', question: timezoneQuestion(texts) });
  found.push({
    where: 'сферы с отметками',
    question: { text: texts.onboarding.topics, rows: topicRows(texts, ['семья', 'здоровье']) },
  });

  const offer = offerTopicsQuestion(texts, ['здоровье', 'покупки']);
  if (offer) found.push({ where: 'предложение сферы', question: offer });

  return found;
};

/** Обе сборки продукта: нажатия правят реплику, слова присылают новую. */
const builders = [
  { path: 'onboarding.ts (ответ нажатием)', build: keyboardOfOnboarding },
  { path: 'awaiting.ts (ответ словами)', build: keyboardOfAwaiting },
] as const;

describe('клавиатуры опроса уходят разложенными по ширине', () => {
  it('страж правда собрал вопросы, а не пустоту', () => {
    // Пустой список сделал бы всё ниже вечно зелёным — а приехать сюда
    // легко: `questionFor` отдаёт `undefined` на незнакомом шаге, и
    // достаточно переименовать шаг, чтобы список схлопнулся.
    const questions = questionsOfOnboarding();

    expect(questions.length).toBeGreaterThanOrEqual(7);
    expect(questions.map((one) => one.where)).toContain('города');
  });

  for (const { path, build } of builders) {
    describe(path, () => {
      it('ни одна строка не обрезается на телефоне', () => {
        for (const { where, question } of questionsOfOnboarding()) {
          for (const row of build(question).inline_keyboard) {
            const labels = row.map((one) => one.text);
            expect(rowFits(labels), `${where}: «${labels.join(' | ')}»`).toBe(true);
          }
        }
      });

      it('пустой строки в хвосте нет', () => {
        /**
         * Прежняя сборка звала `row()` в конце каждой строки и оставляла
         * пустую последней. Telegram такое терпит молча — потому и жило
         * долго, — но это лишний перенос под кнопками и признак того, что
         * клавиатуру собрали в обход раскладки.
         */
        for (const { where, question } of questionsOfOnboarding()) {
          const rows = build(question).inline_keyboard;

          expect(
            rows.map((row) => row.length),
            `${where}: пустая строка в клавиатуре`,
          ).not.toContain(0);
        }
      });

      it('собрано ровно тем же правилом, что и остальные клавиатуры', () => {
        // Не «похоже», а совпадает: раскладка одна на продукт, и своя
        // сборка в обработчике — это и есть починенный дефект обратно.
        for (const { where, question } of questionsOfOnboarding()) {
          expect(build(question).inline_keyboard, where).toEqual(
            fitKeyboard(question.rows).inline_keyboard,
          );
        }
      });
    });
  }

  it('оба пути опроса показывают одну и ту же клавиатуру', () => {
    /**
     * Вопросы одни, а сборок две — по одной на путь ответа. Разъехаться
     * они могут порознь: правку внесут в тот обработчик, который правили,
     * и человек, отвечающий словами, увидит другую раскладку.
     */
    for (const { where, question } of questionsOfOnboarding()) {
      expect(keyboardOfAwaiting(question).inline_keyboard, where).toEqual(
        keyboardOfOnboarding(question).inline_keyboard,
      );
    }
  });

  it('города правда разъезжаются: без раскладки строка была бы шире экрана', () => {
    /**
     * Доказательство, что проверки выше не пусты по существу. Города идут
     * по три в ряд (`timezoneQuestion`), и «Екатеринбург | Омск |
     * Красноярск» в 270 точек не влезает — значит раскладка обязана
     * разбить эту строку, а не пропустить её как есть.
     */
    const raw = timezoneQuestion(defaultTexts).rows;
    const tooWide = raw.filter((row) => !rowFits(row.map((one) => one.label)));

    expect(tooWide.length).toBeGreaterThan(0);
    expect(keyboardOfOnboarding({ text: '', rows: raw }).inline_keyboard.length).toBeGreaterThan(
      raw.length,
    );
  });
});
