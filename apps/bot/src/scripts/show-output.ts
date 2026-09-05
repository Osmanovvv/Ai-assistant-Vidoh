import { eq } from 'drizzle-orm';

import { users } from '../db/schema.js';
import { closeDb, getDb } from '../infra/db.js';
import { titleUnderDayHeader } from '../modules/items/item-text.js';
import { openItemsFor } from '../modules/items/items.repo.js';
import { effectiveEnergy, selectForToday } from '../modules/output/filter.js';
import { morningText } from '../modules/scheduler/digest.js';
import { outputContextOf } from '../modules/users/state.repo.js';
import { textsFor } from '../texts/index.js';

/**
 * Что человек прочтёт — на его настоящих записях (задача 3.78).
 *
 * **Зачем, если есть тесты и набор.** Тесты проверяют правила на
 * придуманных записях, набор — разбор речи. Ни то, ни другое не отвечает
 * на вопрос «что увидит **этот** человек **сейчас**»: его записи собраны
 * за неделю, в них живая расшифровка, вчерашние слова про завтра и
 * длинные формулировки, каких в тестах не пишут.
 *
 * **Первый же прогон нашёл два дефекта.** Утренняя сводка проджекта
 * читалась «На сегодня: — Позвонить стоматологу **завтра**» — шапка про
 * сегодня, строка про завтра (3.78). А до неё, на тех же данных, тем же
 * способом нашлось «**Сегодня** срок: **Завтра** надо купить собаке
 * новый ошейник» в напоминании (3.77). Оба — в тексте, который человек
 * читает первым делом, и ни один не виден ни в одном тесте.
 *
 * Модель здесь не участвует: всё, что печатается, собирают чистые
 * функции вывода из того, что уже лежит в базе. Значит прогон бесплатен
 * и работает, даже когда модель недоступна.
 *
 * Запуск (на сервере — против боевой базы, только чтение):
 *   DATABASE_URL=… npx tsx src/scripts/show-output.ts 7293396576
 */

const [, , rawTgId] = process.argv;

if (rawTgId === undefined) {
  process.stderr.write('Использование: show-output <tg_id>\n');
  process.exit(2);
}

const tgId = Number.parseInt(rawTgId, 10);

if (!Number.isInteger(tgId)) {
  process.stderr.write(`Не похоже на идентификатор Telegram: ${rawTgId}\n`);
  process.exit(2);
}

const db = getDb();

try {
  const [person] = await db
    .select({ id: users.id, timeZone: users.timezone })
    .from(users)
    .where(eq(users.tgId, tgId))
    .limit(1);

  if (!person) {
    process.stderr.write(`Человека с tg_id ${String(tgId)} в базе нет\n`);
    process.exit(1);
  }

  const context = await outputContextOf(db, person.id);
  const texts = textsFor(context.textProfile);

  const now = new Date();
  const day = { now, timeZone: context.timeZone };

  const open = await openItemsFor(db, person.id);
  const today = selectForToday(open, {
    energy: effectiveEnergy(context.state, context.energyDefault, day),
    ...day,
  });

  const lines = [
    `Пояс: ${context.timeZone}. Открытых записей: ${String(open.length)}.`,
    '',
    '──── Утренняя сводка ────',
    morningText(texts, today, day),
    '',
    '──── Список «Сегодня» из меню ────',
    texts.menu.todayTitle,
    ...today.map((item) => `[кнопка] ${titleUnderDayHeader(item, day)}`),
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
} finally {
  await closeDb();
}
