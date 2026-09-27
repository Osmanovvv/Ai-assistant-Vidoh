import { afterEach, describe, expect, it } from 'vitest';

import { applyOverrides, defaultTexts, profiles, textsFor } from '../../texts/index.js';
import {
  contentRefusal,
  editableReplies,
  refusalFor,
  type Reply as DictionaryReply,
} from '../../texts/rules.js';
import { toShortId } from '../shared/short-id.js';
import {
  acknowledgementOf,
  ANSWER_ACTION,
  buildActionsReply,
  buildReply,
  composeOf,
  countQuestions,
  type DumpComposition,
  presentDump,
} from './presenter.service.js';

/**
 * Форма ответа на выгрузку (задача 2.11).
 *
 * §13.2 ТЗ назван частью требований, а не рекомендацией по стилю, поэтому
 * проверяется таблицей случаев: признание, ограниченный список, фраза о
 * сохранённом, ровно один вопрос, кнопки.
 *
 * Главная проверка здесь — про вопросы. Инвариант 10 и §13.9: двух
 * вопросов в реплике не бывает ни при каком сочетании входных данных.
 */

const texts = defaultTexts;

const ack = 'Всё, забрала. Записала 3 дела и разложила по местам.';

const NOTHING: DumpComposition = {
  tasks: 0,
  desires: 0,
  ideas: 0,
  infos: 0,
  emotions: 0,
  hasProject: false,
};

describe('buildReply', () => {
  const batchId = '22222222-2222-4222-8222-222222222222';

  it('после разбора — одно компактное сообщение по её образцам и две кнопки (заказчица, 16.09.2026)', () => {
    /**
     * 15.09.2026: «после разбора действия автоматически не показываем;
     * сначала результат разбора и кнопки». 16.09.2026, п. 3 — образец
     * результата: счёт, раскладка по сферам с числами, что на завтра.
     * 16.09.2026, характер — образец тона: «Всё, забрала. Записала 6 дел
     * и разложила по местам. Оставить как есть или выбрать главное?» —
     * вопрос вернулся, «Всё сохранила» ушло (то же «забрала» уже в
     * начале). Шесть дел — выгрузка длинная: 🤍 по её правилу — в первой
     * строке, контакт закрывается мягко.
     */
    const reply = buildReply({
      texts,
      acknowledgement: acknowledgementOf({ ...NOTHING, tasks: 6 }, texts),
      batchId,
      summary: {
        spheres: [
          { name: 'работа', icon: '💼', count: 4 },
          { name: 'покупки', icon: '🛒', count: 2 },
        ],
        today: [],
        tomorrow: ['Съездить в офис и распечатать документы'],
      },
    });

    expect(reply.text).toBe(
      [
        'Всё, забрала — на сегодня можно больше это не держать в голове 🤍 Записала 6 дел и разложила по местам.',
        '',
        '💼 Работа — 4',
        '🛒 Покупки — 2',
        '',
        'На завтра:',
        '— Съездить в офис и распечатать документы',
        '',
        'Оставить как есть или выбрать главное?',
      ].join('\n'),
    );
    expect(countQuestions(reply.text)).toBe(1);
    expect(reply.buttons.map((button) => button.label)).toEqual([
      texts.answer.buttonKeep,
      texts.answer.buttonPick,
    ]);
  });

  it('живая строка — второй строкой после признания, до раскладки (слой A, 22.09.2026)', () => {
    /**
     * Модель пишет одну-две фразы о том, что бот помнит; они стоят сразу
     * под признанием, своей строкой без пустой — как продолжение мысли,
     * а не отдельный блок. Пустая — ответ как прежде.
     */
    const withLine = buildReply({
      texts,
      acknowledgement: acknowledgementOf({ ...NOTHING, tasks: 2 }, texts),
      batchId,
      contextLine: 'Стоматолога ты уже записывала — оставила одну запись, срок обновила.',
      summary: { spheres: [{ name: 'здоровье', icon: '🩺', count: 2 }], today: [], tomorrow: [] },
    });

    expect(withLine.text).toBe(
      [
        'Всё, забрала. Записала 2 дела и разложила по местам.',
        'Стоматолога ты уже записывала — оставила одну запись, срок обновила.',
        '',
        '🩺 Здоровье — 2',
        '',
        'Оставить как есть или выбрать главное?',
      ].join(String.fromCharCode(10)),
    );
    expect(countQuestions(withLine.text)).toBe(1);

    const without = buildReply({
      texts,
      acknowledgement: acknowledgementOf({ ...NOTHING, tasks: 2 }, texts),
      batchId,
      contextLine: undefined,
      summary: { spheres: [{ name: 'здоровье', icon: '🩺', count: 2 }], today: [], tomorrow: [] },
    });
    expect(without.text.split(String.fromCharCode(10))[1]).toBe('');
  });

  it('сегодня и завтра — своими строками; сфера без иконки — без иконки; без итога — только признание и вопрос', () => {
    const both = buildReply({
      texts,
      acknowledgement: ack,
      summary: {
        spheres: [{ name: 'дача', icon: undefined, count: 1 }],
        today: ['Позвонить в банк', 'Забрать справку'],
        tomorrow: ['Съездить в офис'],
      },
    });
    expect(both.text).toBe(
      [
        ack,
        '',
        'Дача — 1',
        '',
        // Списком, не в строку (макет заказчицы, 16.09.2026, вариант 1).
        'На сегодня:',
        '— Позвонить в банк',
        '— Забрать справку',
        'На завтра:',
        '— Съездить в офис',
        '',
        texts.answer.keepOrPick,
      ].join('\n'),
    );

    const bare = buildReply({ texts, acknowledgement: ack, batchId });
    expect(bare.text).toBe(`${ack}\n\n${texts.answer.keepOrPick}`);
    expect(bare.text).not.toContain(texts.answer.actionsLead);
  });

  it('после длинной выгрузки контакт закрывается мягко — 🤍 в первой строке; короткая — без знака', () => {
    /**
     * Её правило: сердечко редко и там, где оно усиливает тепло —
     * «после длинной выгрузки, когда хочется мягко завершить контакт».
     * Длинная — от пяти дел. «Не использовать как стандартный эмоджи
     * после каждого действия» — короткая выгрузка без него.
     */
    expect(acknowledgementOf({ ...NOTHING, tasks: 5 }, texts)).toBe(
      'Всё, забрала — на сегодня можно больше это не держать в голове 🤍 Записала 5 дел и разложила по местам.',
    );
    expect(acknowledgementOf({ ...NOTHING, tasks: 2 }, texts)).toBe(
      'Всё, забрала. Записала 2 дела и разложила по местам.',
    );
    // При высказанном состоянии — без сердечка и без шуток: «серьёзная
    // усталость — никаких шуточек, которые могут обесценить».
    expect(acknowledgementOf({ ...NOTHING, tasks: 6, emotions: 1 }, texts)).not.toContain('🤍');
  });

  it('«Выбрать главное» несёт код выгрузки: сказанное в ней идёт первым', () => {
    // По коду обработчик восстанавливает «упомянутое в выгрузке» — очередь
    // выдачи ставит его вперёд (задача 3.24).
    const reply = buildReply({ texts, acknowledgement: ack, batchId });

    expect(reply.buttons[1]?.action).toBe(`${ANSWER_ACTION.pick}:${toShortId(batchId)}`);
    expect(reply.buttons[0]?.action).toBe(ANSWER_ACTION.keep);
  });

  it('без кода выгрузки — общее действие, а не пустой код', () => {
    const reply = buildReply({ texts, acknowledgement: ack });

    expect(reply.buttons[1]?.action).toBe(ANSWER_ACTION.pick);
  });

  it('впереди вопрос опроса — своей строки с вопросом нет, кнопки остаются', () => {
    // §13.9: один открытый вопрос на обмен. Кнопки — не вопрос, а выход
    // к делам, и без них первая выгрузка осталась бы без «Выбрать главное».
    const reply = buildReply({ texts, acknowledgement: ack, batchId, omitQuestion: true });

    expect(reply.text).toBe(ack);
    expect(countQuestions(reply.text)).toBe(0);
    expect(reply.buttons).toHaveLength(2);
  });

  it('одни чувства при непустом бэклоге: только признание — без дел, вопроса и кнопок', () => {
    /**
     * Решение заказчицы 13.09.2026 (ответ 1.4) и правка 14.09.2026
     * (п. 1.5): поделилась состоянием — в ответ не выдают задачи и не
     * превращают сказанное в продуктивность; «отвечаем коротко и
     * спокойно» — ни вопроса, ни кнопок к делам.
     */
    const reply = buildReply({ texts, acknowledgement: ack, batchId, feelingsOnly: true });

    // Поделилась личным — одна фраза её словами: «Поняла тебя. Давай пока
    // просто оставим это здесь 🤍» (16.09.2026). Ни «тяжело», ни «понимаю»
    // как оценки состояния — она их запретила. Кризис сюда не доходит.
    expect(reply.text).toBe(texts.answer.feelingsOnly);
    expect(reply.text).toContain('🤍');
    expect(countQuestions(reply.text)).toBe(0);
    expect(reply.buttons).toEqual([]);
  });

  it('одни чувства при усталости — «батарейка почти всё 😮‍💨» и приглашение выгрузить', () => {
    // Её пример: «Я сегодня вообще вымоталась» → «Похоже, батарейка на
    // сегодня почти всё 😮‍💨 Если хочешь — просто выгружай сюда всё, что
    // ещё крутится в голове.» Не превращать в дело — и не оставлять без
    // ответа.
    const reply = buildReply({
      texts,
      acknowledgement: ack,
      batchId,
      feelingsOnly: true,
      mood: 'tired',
    });

    expect(reply.text).toBe(texts.answer.feelingsOnlyTired);
    expect(reply.text).toContain('😮‍💨');
    expect(reply.text).not.toContain('🤍');
    expect(reply.buttons).toEqual([]);
  });

  it('одни чувства при сильной эмоции — спокойно, без эмодзи: «Вижу, сейчас тяжело. Давай без лишнего…»', () => {
    const reply = buildReply({
      texts,
      acknowledgement: ack,
      batchId,
      feelingsOnly: true,
      mood: 'heavy',
    });

    expect(reply.text).toBe(texts.answer.feelingsOnlyHeavy);
    expect(reply.text).toMatch(/^Вижу, сейчас тяжело\./u);
    expect(reply.text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(countQuestions(reply.text)).toBe(0);
    expect(reply.buttons).toEqual([]);
  });

  it('одни чувства при досаде — прежнее «Поняла тебя… 🤍»: поделилась личным', () => {
    const reply = buildReply({
      texts,
      acknowledgement: ack,
      batchId,
      feelingsOnly: true,
      mood: 'annoyed',
    });

    expect(reply.text).toBe(texts.answer.feelingsOnly);
  });

  it('сильная эмоция при делах — ответ проще: без вопроса, кнопки остаются', () => {
    // «Чем сильнее эмоция — тем спокойнее и проще ответ»; «не уводим в
    // дополнительный разговор». Кнопки — выход к делам, не вопрос.
    const reply = buildReply({
      texts,
      acknowledgement: 'Вижу, сейчас тяжело. Записала 2 дела и разложила по местам.',
      batchId,
      mood: 'heavy',
      summary: { spheres: [{ name: 'дом', icon: '🏠', count: 2 }], today: [], tomorrow: [] },
    });

    expect(reply.text).not.toContain(texts.answer.keepOrPick);
    expect(countQuestions(reply.text)).toBe(0);
    expect(reply.text).toContain('🏠 Дом — 2');
    expect(reply.buttons).toHaveLength(2);
  });

  it('лёгкая эмоция при делах — вопрос на месте', () => {
    const reply = buildReply({ texts, acknowledgement: ack, batchId, mood: 'tired' });

    expect(reply.text).toContain(texts.answer.keepOrPick);
  });

  it('и с настроением двух вопросов не бывает', () => {
    for (const mood of ['tired', 'annoyed', 'heavy', undefined] as const) {
      for (const feelingsOnly of [false, true]) {
        for (const profile of Object.keys(profiles)) {
          const reply = buildReply({
            texts: textsFor(profile),
            acknowledgement: ack,
            batchId,
            feelingsOnly,
            mood,
            summary: { spheres: [], today: ['Позвонить'], tomorrow: [] },
          });

          expect(countQuestions(reply.text), `${profile}: ${String(mood)}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('ни при каком сочетании не бывает двух вопросов', () => {
    // Инвариант 10. Проверяется перебором, а не примером: правило легко
    // нарушить, добавив фразу с вопросительным знаком в словарь.
    for (const omitQuestion of [false, true]) {
      for (const feelingsOnly of [false, true]) {
        for (const profile of Object.keys(profiles)) {
          const reply = buildReply({
            texts: textsFor(profile),
            acknowledgement: ack,
            batchId,
            omitQuestion,
            feelingsOnly,
            summary: {
              spheres: [{ name: 'работа', icon: '💼', count: 2 }],
              today: ['Позвонить'],
              tomorrow: ['Съездить'],
            },
          });

          expect(countQuestions(reply.text)).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('buildActionsReply — по кнопке «Выбрать главное»', () => {
  it('собирает список по §13.2: подводка, пункты, сохранённое — без вопроса', () => {
    const reply = buildActionsReply({
      texts,
      actions: ['Записать сына к врачу', 'Позвонить маме'],
      hidden: 5,
    });

    expect(reply.text).toContain(texts.answer.actionsLead);
    expect(reply.text).toContain('— Записать сына к врачу');
    expect(reply.text).toContain('— Позвонить маме');
    expect(reply.text).toContain(texts.answer.restSaved);
    // Вопрос уже был задан кнопками; здесь человек получил ответ.
    expect(countQuestions(reply.text)).toBe(0);
  });

  it('«Сделать сейчас» ведёт к первому показанному делу, а не к «первому на сегодня» (ревизия этапа 3, E2)', () => {
    const reply = buildActionsReply({
      texts,
      actions: ['Позвонить маме', 'Купить хлеб'],
      firstItemId: '11111111-1111-4111-8111-111111111111',
      hidden: 0,
    });

    expect(reply.buttons[0]?.action).toBe(
      `${ANSWER_ACTION.now}:${toShortId('11111111-1111-4111-8111-111111111111')}`,
    );
  });

  it('три кнопки из §13.2 в заданном порядке', () => {
    const reply = buildActionsReply({ texts, actions: ['Одно'], hidden: 2 });

    expect(reply.buttons.map((button) => button.label)).toEqual([
      texts.answer.buttonDoNow,
      texts.answer.buttonShowAll,
      texts.answer.buttonLater,
    ]);
  });

  it('одно дело — другая подводка', () => {
    const reply = buildActionsReply({ texts, actions: ['Одно'], hidden: 0 });

    expect(reply.text).toContain(texts.answer.actionsLeadSingle);
    expect(reply.text).not.toContain(texts.answer.actionsLead);
  });

  it('нечего скрывать — фраза о сохранённом не врёт', () => {
    const reply = buildActionsReply({ texts, actions: ['Одно', 'Два'], hidden: 0 });

    expect(reply.text).toContain(texts.answer.nothingHidden);
    expect(reply.text).not.toContain(texts.answer.restSaved);
  });

  it('выбирать не из чего — короткий ответ без кнопок', () => {
    const reply = buildActionsReply({ texts, actions: [], hidden: 0 });

    expect(reply.text).toBe(texts.answer.nothingToPick);
    expect(reply.buttons).toEqual([]);
  });
});

describe('правка из панели и склейка §13.2', () => {
  afterEach(() => {
    // Склейка живёт в модуле: не вернёшь — соседние проверки будут мерить
    // правку вместо словаря из кода.
    applyOverrides(new Map());
  });

  /** Та же реплика, но с вопросом на конце — и со всеми её подстановками. */
  const askedVersionOf = (reply: DictionaryReply): string =>
    [
      reply.said.trim(),
      ...Array.from({ length: reply.places }, (_unused, index) => `{${String(index + 1)}}`),
      'Хорошо?',
    ].join(' ');

  /** Сколько вопросов самое большее даёт сборка на словаре с правкой. */
  const mostQuestions = (): number => {
    const texts = textsFor();
    let most = 0;

    // Ответ на выгрузку: признание из состава и вопрос «оставить или
    // выбрать».
    for (const tired of [false, true]) {
      for (const tasks of [0, 1, 6]) {
        const acknowledgement = acknowledgementOf(
          { ...NOTHING, tasks, emotions: tired ? 1 : 0 },
          texts,
        );
        const built = buildReply({ texts, acknowledgement, batchId: undefined });

        most = Math.max(most, countQuestions(built.text));
      }
    }

    // Список по кнопке «Выбрать главное» — своего вопроса не несёт.
    for (const actions of [[], ['Одно'], ['Одно', 'Два'], ['Одно', 'Два', 'Три']]) {
      for (const hidden of [0, 1, 7]) {
        const built = buildActionsReply({ texts, actions, hidden });

        most = Math.max(most, countQuestions(built.text));
      }
    }

    return most;
  };

  it('всё, что запись пропускает, в собранном ответе не даёт двух вопросов', () => {
    /**
     * Дефект ревизии второго этапа. Правило «один „?“ на реплику»
     * смотрело на реплику, а человек читает склейку: «Остальное никуда не
     * убежит, хорошо?» проходило запись и вместе с «С чего начнём?»
     * давало два вопроса. Перебор выше этого поймать не мог — он мерил
     * словарь из кода, а правок к нему никто не применял.
     *
     * Здесь перебор идёт по словарю **с правкой**, и он двусторонний:
     * каждой правимой реплике ответа дописывается вопрос, правка кладётся
     * в словарь **мимо** записи, и если хоть в одной сборке вопросов
     * стало два — запись обязана была эту правку отвергнуть. Так список
     * реплик, стоящих рядом с вопросом, сверяется с самой сборкой, а не с
     * памятью того, кто его составлял: появись в ответе новая реплика без
     * правила — покраснеет здесь.
     */
    const checked: string[] = [];

    for (const reply of editableReplies(defaultTexts)) {
      if (!reply.path.startsWith('answer.')) continue;

      const asked = askedVersionOf(reply);

      applyOverrides(new Map([[reply.path, asked]]));

      const most = mostQuestions();
      const refusal = refusalFor(asked, reply.places, reply.path);

      if (most > 1) {
        const blame = `${reply.path}: «${asked}» даёт ${String(most)} вопроса в ответе, а запись её пропускает`;

        expect(refusal, blame).toBeDefined();
        expect(refusal ?? '', blame).toMatch(/13\.2/u);
        checked.push(reply.path);
      }
    }

    // Перебор не пустой: реплика, стоящая рядом с вопросом, в нём есть.
    // Прежде это была `restSaved` (дефект ревизии второго этапа); с
    // решением заказчицы 15.09.2026 рядом с вопросом стоит признание.
    expect(checked).toContain('answer.acknowledgementFallback');
  });

  it('правка без вопроса проходит запись и в ответе остаётся один вопрос', () => {
    // Обратная сторона: правило, которое не пропускает ничего, кончается
    // тем, что его снимают целиком.
    const said = 'Я тебя услышала, всё записала.';

    expect(refusalFor(said, 0, 'answer.acknowledgementFallback')).toBeUndefined();

    applyOverrides(new Map([['answer.acknowledgementFallback', said]]));

    const texts = textsFor();
    const built = buildReply({
      texts,
      acknowledgement: acknowledgementOf(NOTHING, texts),
    });

    expect(built.text).toContain(said);
    expect(countQuestions(built.text)).toBe(1);
  });
});

describe('acknowledgementOf — признание из состава (заказчица, 16.09.2026)', () => {
  /**
   * «У тебя шесть дел, все обычные» — сказала модель на видео заказчицы;
   * она ответила: «достаточно сразу: „Я тебя услышала. У тебя шесть дел"».
   * Признание собирается кодом: слова-числа до десяти, дальше цифрами,
   * склонение — дело / дела / дел.
   */
  const withTasks = (tasks: number, emotions = 0): string =>
    acknowledgementOf({ ...NOTHING, tasks, emotions }, texts);

  afterEach(() => {
    applyOverrides(new Map());
  });

  it('«Всё, забрала. Записала 3 дела и разложила по местам.» — её образец тона', () => {
    expect(withTasks(3)).toBe('Всё, забрала. Записала 3 дела и разложила по местам.');
  });

  it('склоняет: 1 дело, 2 дела, 4 дела, 11 дел, 21 дело, 22 дела (от пяти — с 🤍 впереди)', () => {
    expect(withTasks(1)).toBe('Всё, забрала. Записала 1 дело и разложила по местам.');
    expect(withTasks(2)).toBe('Всё, забрала. Записала 2 дела и разложила по местам.');
    expect(withTasks(4)).toBe('Всё, забрала. Записала 4 дела и разложила по местам.');
    expect(withTasks(11)).toContain('Записала 11 дел и разложила по местам.');
    expect(withTasks(21)).toContain('Записала 21 дело и разложила по местам.');
    expect(withTasks(22)).toContain('Записала 22 дела и разложила по местам.');
  });

  it('желания — в счёте рядом с делами (решение Никиты, 17.09.2026)', () => {
    /**
     * Блок B 17.09: девять записей, «Записала 6 дел» — три желания не
     * упомянуты нигде, и человеку не понять, услышаны ли они. Желания
     * называются вместе с делами; без желаний фраза — её образец, как
     * была.
     */
    const withBoth = (tasks: number, desires: number): string =>
      acknowledgementOf({ ...NOTHING, tasks, desires }, texts);

    expect(withBoth(6, 3)).toBe(
      'Всё, забрала — на сегодня можно больше это не держать в голове 🤍 Записала 6 дел и 3 желания, разложила по местам.',
    );
    expect(withBoth(2, 1)).toBe('Всё, забрала. Записала 2 дела и 1 желание, разложила по местам.');
    expect(withBoth(1, 5)).toBe('Всё, забрала. Записала 1 дело и 5 желаний, разложила по местам.');
    expect(withBoth(3, 11)).toContain('3 дела и 11 желаний,');
    expect(withBoth(3, 21)).toContain('3 дела и 21 желание,');
    expect(withBoth(3, 22)).toContain('3 дела и 22 желания,');
    // Одни желания — тоже записаны.
    expect(withBoth(0, 2)).toBe('Всё, забрала. Записала 2 желания, разложила по местам.');
    // Без желаний — образец заказчицы без изменений.
    expect(withBoth(3, 0)).toBe('Всё, забрала. Записала 3 дела и разложила по местам.');
  });

  it('без дел — только признание', () => {
    expect(withTasks(0)).toBe(texts.answer.acknowledgementFallback);
  });

  it('при высказанном состоянии — спокойнее, без оценки состояния, счёт остаётся', () => {
    // «Не говорит постоянно: тебе сейчас тяжело» — её слова. Тон
    // усталости — в самом «Поняла», а не в диагнозе.
    expect(withTasks(2, 1)).toBe('Поняла, забрала. Записала 2 дела и разложила по местам.');
    expect(withTasks(0, 1)).toBe(texts.answer.acknowledgementTiredFallback);
  });

  it('лёгкая усталость — тепло и с 😮‍💨, счёт следом (её пример: «Я ужасно устала, ещё надо…»)', () => {
    // «Да, на сегодня уже многовато 😮‍💨 Давай хотя бы это больше не
    // держать в голове. Записала: …» — заказчица, 16.09.2026, про эмоции.
    expect(acknowledgementOf({ ...NOTHING, tasks: 2 }, texts, 'tired')).toBe(
      `${texts.answer.acknowledgementTired} Записала 2 дела и разложила по местам.`,
    );
    expect(texts.answer.acknowledgementTired).toContain('😮‍💨');
  });

  it('лёгкая досада — «Понимаю 🙃», счёт следом (её пример про стоматолога)', () => {
    expect(acknowledgementOf({ ...NOTHING, tasks: 1 }, texts, 'annoyed')).toBe(
      `${texts.answer.acknowledgementAnnoyed} Записала 1 дело и разложила по местам.`,
    );
    expect(texts.answer.acknowledgementAnnoyed).toContain('🙃');
  });

  it('сильная эмоция — спокойно, без юмора и без эмодзи: «Вижу, сейчас тяжело.»', () => {
    expect(acknowledgementOf({ ...NOTHING, tasks: 2, emotions: 1 }, texts, 'heavy')).toBe(
      'Вижу, сейчас тяжело. Записала 2 дела и разложила по местам.',
    );
    expect(texts.answer.acknowledgementHeavy).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('длинная выгрузка при усталости — эмодзи один: 😮‍💨 вместо 🤍', () => {
    const said = acknowledgementOf({ ...NOTHING, tasks: 7 }, texts, 'tired');

    expect(said).toContain('😮‍💨');
    expect(said).not.toContain('🤍');
  });

  it('эмоция есть, а слов из списка нет — прежнее спокойное «Поняла, забрала.»', () => {
    expect(acknowledgementOf({ ...NOTHING, tasks: 2, emotions: 1 }, texts, undefined)).toBe(
      'Поняла, забрала. Записала 2 дела и разложила по местам.',
    );
  });

  it('правка признания из панели доезжает и в счёт', () => {
    applyOverrides(new Map([['answer.acknowledgementFallback', 'Услышала тебя.']]));

    expect(acknowledgementOf({ ...NOTHING, tasks: 3 }, textsFor())).toBe(
      'Услышала тебя. Записала 3 дела и разложила по местам.',
    );
  });
});

describe('presentDump — ответ на выгрузку целиком', () => {
  const composition: DumpComposition = { ...NOTHING, tasks: 3, desires: 1, hasProject: true };
  const params = { composition, actions: ['Записать сына к врачу', 'Позвонить маме'], hidden: 4 };

  it('признание из состава, вопрос «оставить или выбрать», две кнопки, дел под признанием нет', () => {
    const result = presentDump(params);

    // В составе одно желание — оно в счёте (17.09.2026).
    expect(
      result.reply.text.startsWith(
        'Всё, забрала. Записала 3 дела и 1 желание, разложила по местам.',
      ),
    ).toBe(true);
    expect(result.reply.text).not.toContain('— Записать сына к врачу');
    expect(result.reply.text).toContain(texts.answer.keepOrPick);
    expect(countQuestions(result.reply.text)).toBe(1);
    expect(result.reply.buttons.map((button) => button.label)).toEqual([
      texts.answer.buttonKeep,
      texts.answer.buttonPick,
    ]);
  });

  it('высказанное состояние при делах — тон усталости и те же две кнопки', () => {
    /**
     * §13.7 её ТЗ при усталости сокращал список и закрывал разговор.
     * С решением 15.09.2026 списка под признанием нет ни у кого; закрывать
     * нечего, а усталость живёт в самом признании.
     */
    const result = presentDump({
      composition: { ...composition, tasks: 1, emotions: 2 },
      actions: ['Записать сына к врачу'],
      hidden: 7,
    });

    expect(
      result.reply.text.startsWith(
        'Поняла, забрала. Записала 1 дело и 1 желание, разложила по местам.',
      ),
    ).toBe(true);
    expect(result.reply.text).not.toContain(texts.answer.actionsLeadSingle);
    expect(countQuestions(result.reply.text)).toBe(1);
    expect(result.reply.buttons).toHaveLength(2);
  });

  it('настроение доезжает до признания и формы: усталость — 😮‍💨 и вопрос; сильная — без вопроса', () => {
    const tired = presentDump({
      ...params,
      composition: { ...composition, tasks: 2 },
      mood: 'tired',
    });

    expect(tired.reply.text.startsWith(texts.answer.acknowledgementTired)).toBe(true);
    expect(tired.reply.text).toContain(texts.answer.keepOrPick);

    const heavy = presentDump({
      ...params,
      composition: { ...composition, tasks: 2 },
      mood: 'heavy',
    });

    expect(heavy.reply.text.startsWith(texts.answer.acknowledgementHeavy)).toBe(true);
    expect(countQuestions(heavy.reply.text)).toBe(0);
    expect(heavy.reply.buttons).toHaveLength(2);
  });

  it('быстрое добавление — «Записала в «сфера»: дело.», без кнопок', () => {
    /**
     * Проджект, бой 21.09.2026: «Поймала. Разберём, когда дойдём» не
     * показывало, что записано. Реплика называет сферу и дело.
     */
    const result = presentDump({
      ...params,
      quickAdd: { topic: 'Покупки', title: 'Составить список продуктов на неделю' },
    });

    expect(result.reply).toEqual({
      text: texts.answer.added('Покупки', 'Составить список продуктов на неделю'),
      buttons: [],
    });
    expect(result.reply.text).toBe('Записала в «Покупки»: Составить список продуктов на неделю.');
    expect(countQuestions(result.reply.text)).toBe(0);
  });

  it('точка в конце названия не удваивается (прогон Никиты 27.09.2026, 15:22)', () => {
    // Модель вернула название с точкой, шаблон поставил свою: «…в понедельник..».
    const result = presentDump({
      ...params,
      quickAdd: { topic: 'Здоровье', title: 'Записать Мишу к ортодонту в понедельник.' },
    });

    expect(result.reply.text).toBe(
      'Записала в «Здоровье»: Записать Мишу к ортодонту в понедельник.',
    );
  });

  it('неизвестный профиль берёт словарь по умолчанию', () => {
    expect(presentDump({ ...params, profile: 'тёплый-которого-нет' }).reply.text).toContain(
      texts.answer.keepOrPick,
    );
  });
});

describe('composeOf', () => {
  it('считает состав выгрузки по типам', () => {
    const composition = composeOf([
      { type: 'TASK' },
      { type: 'TASK', isProject: true },
      { type: 'DESIRE' },
      { type: 'EMOTION' },
      { type: 'INFO' },
    ]);

    expect(composition).toEqual({
      tasks: 2,
      desires: 1,
      ideas: 0,
      infos: 1,
      emotions: 1,
      hasProject: true,
    });
  });

  it('признак проекта у не-задачи в состав не идёт', () => {
    // §5.1: проект — поле у TASK. Классификация это уже приводит в
    // согласие, но состав не должен зависеть от чужой аккуратности.
    expect(composeOf([{ type: 'IDEA', isProject: true }]).hasProject).toBe(false);
  });
});

describe('словарь', () => {
  it('в текстах ответа нет формулировок, запрещённых §13.7', () => {
    // Проверка направлена на нас, а не на модель: запрещённая фраза,
    // попавшая в словарь, прошла бы все остальные проверки.
    for (const profile of Object.values(profiles)) {
      for (const value of Object.values(profile.answer)) {
        if (typeof value !== 'string') continue;

        // Вопросы в словаре законны — это наш единственный вопрос.
        if (value.includes('?')) continue;

        expect(contentRefusal(value), `«${value}»`).toBeUndefined();
      }
    }
  });

  it('неизвестный профиль не роняет ответ', () => {
    // Человек в этот момент ждёт разбор своей выгрузки. Отказ ради
    // опечатки в настройке был бы обменом важного на неважное.
    expect(textsFor('тёплый-которого-нет')).toBe(textsFor('reserved'));
    expect(textsFor(null)).toBe(textsFor(undefined));
  });
});
