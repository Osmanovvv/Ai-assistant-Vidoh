import { defaultTexts } from '../../apps/bot/src/texts/index.js';
import { connect, press, readSettled, send, shot, type Reply } from './telegram.js';

/**
 * Приёмочный прогон через настоящий Telegram (задача 3.33).
 *
 * **Зачем, если есть сквозной прогон и прогон находок.** Оба поднимают
 * своего бота с заглушкой вместо Telegram. Дефекты, за которые было
 * стыдно, жили именно в том, чего заглушка не показывает: ширина кнопок,
 * порядок реплик, ветки. Первый же живой прогон 02.09.2026 нашёл дефект,
 * которого не увидели 1685 автотестов (задача 3.32).
 *
 * **Идёт по сценариям §2 и критериям §21**, а не по нашему коду: это
 * взгляд заказчицы, а не разработчика.
 *
 * **Пишет в живой аккаунт и живую базу.** За собой надо прибрать — прогон
 * ничего не удаляет сам. Все заведённые дела помечены словом-маркером,
 * чтобы их легко было найти и убрать.
 *
 * Одна выгрузка — окно склейки тридцать секунд плюс разбор моделью:
 * считай минуту на шаг. Прогон целиком — около десяти минут и порядка
 * двухсот рублей.
 *
 * Запуск:
 *   npx tsx tests/visual/walkthrough.ts
 *   ONLY=3,5 npx tsx tests/visual/walkthrough.ts
 */

let passed = 0;
let failed = 0;

function ok(title: string): void {
  process.stdout.write(`  [32mOK[0m  ${title}\n`);
  passed++;
}

function no(title: string, detail: string): void {
  process.stdout.write(`  [31mНЕТ[0m ${title}${detail === '' ? '' : ` — ${detail}`}\n`);
  failed++;
}

function check(title: string, condition: boolean, detail = ''): void {
  if (condition) ok(title);
  else no(title, detail);
}

function step(number: string, title: string): void {
  process.stdout.write(`\n[1m==> ${number}. ${title}[0m\n`);
}

function show(reply: Reply): void {
  for (const line of reply.text.split('\n')) process.stdout.write(`  │ ${line}\n`);
  for (const row of reply.rows) process.stdout.write(`  │ [ ${row.join(' ] [ ')} ]\n`);
}

/** Какие шаги гонять: `ONLY=3,5`. Прогон дорогой, разбираться приходится по одному. */
const ONLY = new Set(
  (process.env['ONLY'] ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter((one) => one.length > 0),
);

const runs = (number: string): boolean => ONLY.size === 0 || ONLY.has(number);

/** Слово-маркер в текстах: по нему тестовые записи потом находятся. */
const MARK = 'зонт';

const lower = (text: string): string => text.toLowerCase();
const has = (reply: Reply, ...words: string[]): boolean =>
  words.every((word) => lower(reply.text).includes(lower(word)));

/** Ровно один вопрос в реплике — §13.9. */
const questions = (text: string): number => (text.match(/\?/gu) ?? []).length;

const { browser, page } = await connect();

try {
  process.stdout.write(`Переписка открыта, ширина экрана 360 точек.\n`);

  // ── 1. Обычная выгрузка (§13.2) ─────────────────────────────────────
  if (runs('1')) {
    step('1', 'Обычная выгрузка: признание, три действия, кнопки, один вопрос');

    const reply = await send(
      page,
      `Надо купить ${MARK} новый, позвонить в поликлинику и оплатить интернет.`,
    );
    show(reply);

    check('бот ответил разбором', has(reply, defaultTexts.answer.actionsLead), reply.text);
    check(
      'в выдаче есть только что названное',
      has(reply, MARK) || has(reply, 'поликлин') || has(reply, 'интернет'),
      reply.text,
    );
    check('фраза о сохранённом на месте', has(reply, 'не убежит') || has(reply, 'ничего не висит'));
    check(
      'вопрос ровно один (§13.9)',
      questions(reply.text) === 1,
      `вопросов: ${String(questions(reply.text))}`,
    );
    check(
      'кнопки §13.2 стоят двумя строками',
      reply.rows.length === 2,
      `строк: ${String(reply.rows.length)} — ${JSON.stringify(reply.rows)}`,
    );
    check(
      '«Оставить на потом» одна в своей строке и целиком',
      reply.rows.at(-1)?.length === 1 && reply.rows.at(-1)?.[0] === defaultTexts.answer.buttonLater,
      JSON.stringify(reply.rows.at(-1)),
    );

    await shot(page, 'wt-01-razbor');
  }

  // ── 2. Правка срока и откат (§7.1, §7.3) ────────────────────────────
  if (runs('2')) {
    step('2', 'Правка срока: показано изменение, откат в один тап');

    const moved = await send(page, `перенеси ${MARK} на пятницу`);
    show(moved);

    check(
      'бот сказал, что именно изменил',
      has(moved, 'перенесла') || has(moved, 'поправила'),
      moved.text,
    );
    check('в цитате нет прежней даты', !has(moved, 'четверг'), moved.text);
    check(
      'есть кнопка отката',
      moved.rows.flat().includes(defaultTexts.resolver.buttonUndo),
      JSON.stringify(moved.rows),
    );

    if (moved.rows.flat().includes(defaultTexts.resolver.buttonUndo)) {
      const undone = await press(page, defaultTexts.resolver.buttonUndo);
      show(undone);

      check('откат сработал', has(undone, 'вернула'), undone.text);
      check(
        'кнопка отката убрана — дважды не откатишь',
        !undone.rows.flat().includes(defaultTexts.resolver.buttonUndo),
        JSON.stringify(undone.rows),
      );
    }
  }

  // ── 3. Быстрое добавление (§13.3) ───────────────────────────────────
  if (runs('3')) {
    step('3', 'Быстрое добавление: одна строка, без разбора и без вопроса');

    const added = await send(page, `добавь ещё купить чехол для ${MARK}а`);
    show(added);

    check(
      'ответ короткий, одной фразой',
      added.text.length < 80,
      `длина: ${String(added.text.length)}`,
    );
    check('разбор не открылся', !has(added, defaultTexts.answer.actionsLead), added.text);
    check('вопроса нет', questions(added.text) === 0, added.text);
    check('кнопок нет', added.rows.length === 0, JSON.stringify(added.rows));
  }

  // ── 4. Вопрос по бэклогу (§13.4) ────────────────────────────────────
  if (runs('4')) {
    step('4', 'Вопрос по бэклогу: отвечает и ничего не создаёт');

    const asked = await send(page, `что у меня там про ${MARK}`);
    show(asked);

    check('ответил по существу', has(asked, MARK), asked.text);
    check('это не разбор новой выгрузки', !has(asked, 'я тебя услышала'), asked.text);
  }

  // ── 5. Желание не становится задачей (§6.3) ─────────────────────────
  if (runs('5')) {
    step('5', 'Желание остаётся желанием и в выдачу не попадает');

    const wish = await send(page, `хочу когда-нибудь научиться крутить ${MARK} на пальце`);
    show(wish);

    check(
      'желание не встало в список действий',
      !lower(wish.text).includes('научиться крутить'),
      wish.text,
    );
  }

  // ── 6. Состояние сокращает выдачу (§13.7) ───────────────────────────
  if (runs('6')) {
    step('6', 'Сказала о состоянии: короче и одно действие');

    const tired = await send(page, `Я на нуле совсем. Ещё надо забрать ${MARK} из ремонта.`);
    show(tired);

    const bullets = (tired.text.match(/^—/gmu) ?? []).length;
    check('в выдаче ровно одно действие', bullets === 1, `строк списка: ${String(bullets)}`);
    check(
      'ответ не читает мораль',
      !has(tired, 'ты молодец') && !has(tired, 'соберись'),
      tired.text,
    );
  }

  // ── 7. Регулярное дело (§2, запрос №1) ──────────────────────────────
  if (runs('7')) {
    step('7', 'Регулярное дело: одна запись с правилом');

    const rule = await send(page, `каждый вторник проверять ${MARK} перед выходом`);
    show(rule);

    check('бот принял регулярное дело', rule.text.length > 0, rule.text);
  }

  // ── 8. Серия сообщений — одна выгрузка (§2 п.2) ──────────────────────
  if (runs('8')) {
    step('8', 'Три сообщения подряд: одна выгрузка и один ответ');

    const composer = page.locator('[contenteditable="true"]').first();
    const before = await readSettled(page);

    for (const line of [
      `Надо отдать ${MARK} в химчистку.`,
      'И записаться к парикмахеру.',
      'И купить батарейки.',
    ]) {
      await composer.click();
      await composer.fill('');
      await composer.pressSequentially(line, { delay: 8 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
    }

    process.stdout.write('  → три сообщения отправлены подряд\n');

    // Ждём один разбор: окно склейки плюс модель.
    const series = await (async () => {
      await page.waitForTimeout(40_000);
      for (let attempt = 0; attempt < 40; attempt++) {
        const now = await readSettled(page);
        if (now.text !== before.text && has(now, defaultTexts.answer.actionsLead)) return now;
        await page.waitForTimeout(3000);
      }
      return await readSettled(page);
    })();

    show(series);

    check(
      'на три сообщения один разбор',
      has(series, defaultTexts.answer.actionsLead),
      series.text,
    );
    check('кнопки на месте и в две строки', series.rows.length === 2, JSON.stringify(series.rows));

    await shot(page, 'wt-08-seriya');
  }

  // ── 9. Кнопка «Разобрать всё» (§13.2) ───────────────────────────────
  if (runs('9')) {
    step('9', '«Разобрать всё» показывает остальные дела');

    const last = await readSettled(page);
    if (last.rows.flat().includes(defaultTexts.answer.buttonShowAll)) {
      const all = await press(page, defaultTexts.answer.buttonShowAll);
      show(all);
      check('бот показал список по темам', all.text.length > 0, all.text);
      await shot(page, 'wt-09-razobrat-vsyo');
    } else {
      no('«Разобрать всё» есть на экране', `кнопки: ${JSON.stringify(last.rows)}`);
    }
  }
} finally {
  await shot(page, 'wt-final');
  await browser.close();
}

process.stdout.write(`\n[1mПройдено ${String(passed)}, провалено ${String(failed)}[0m\n`);
process.stdout.write(`Тестовые записи помечены словом «${MARK}» — не забудь прибрать в базе.\n`);
process.exit(failed === 0 ? 0 : 1);
