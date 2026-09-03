import { connect, press, readSettled, send, sendCommand, shot, type Reply } from './telegram.js';

/**
 * Одна реплика боевому боту из командной строки (задача 3.31).
 *
 * **Зачем, если есть сквозной прогон.** Тот поднимает своего бота с
 * заглушкой вместо Telegram — там не видно ни раскладки кнопок, ни
 * ветвей, ни того, как реплика выглядит человеку. Дефекты, за которые
 * было стыдно, жили именно там.
 *
 * Приёмочный прогон целиком — в `walkthrough.ts`; здесь удобно проверить
 * одну мысль руками.
 *
 * **Пишет в живой аккаунт и живую базу.** За собой надо прибрать: скрипт
 * ничего не удаляет сам.
 *
 * Запуск:
 *   npx tsx tests/visual/talk.ts "надо купить хлеб и позвонить в банк"
 *   npx tsx tests/visual/talk.ts --press Отменить
 *   npx tsx tests/visual/talk.ts --command /menu
 *   npx tsx tests/visual/talk.ts               # только прочитать последнее
 */

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function show(reply: Reply): void {
  say('');
  for (const line of reply.text.split('\n')) say(`  │ ${line}`);

  if (reply.rows.length > 0) {
    say('');
    for (const row of reply.rows) say(`  [ ${row.join(' ] [ ')} ]`);
  }

  say('');
}

const args = process.argv.slice(2).filter((one) => one.trim().length > 0);

const { browser, page } = await connect();

try {
  say('Переписка открыта.');

  if (args.length === 0) {
    say('Аргументов нет — читаю последнюю реплику.');
    show(await readSettled(page));
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';

    // `--command /menu` отправляет команду в обход подсказки Telegram Web.
    if (arg === '--command') {
      const command = args[index + 1] ?? '';
      index += 1;
      say(`  → ${command} (команда)`);
      show(await sendCommand(page, command));
      continue;
    }

    // `--press Подпись` нажимает кнопку вместо отправки текста.
    if (arg === '--press') {
      const label = args[index + 1] ?? '';
      index += 1;
      say(`  ⇥ нажимаю «${label}»`);
      show(await press(page, label));
      continue;
    }

    say(`  → ${arg}`);
    show(await send(page, arg));
  }

  say(`Снимок: ${await shot(page, 'talk')}`);
} finally {
  await browser.close();
}
