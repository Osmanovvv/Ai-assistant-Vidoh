import { mkdir, rm, writeFile } from 'node:fs/promises';

import { eq } from 'drizzle-orm';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aiCalls,
  appSettings,
  textOverrides,
  batches,
  billingEvents,
  billingInvoices,
  billingSubscriptions,
  broadcastDeliveries,
  broadcasts,
  items,
  itemRevisions,
  messagesRaw,
  promoCodes,
  promptVersions,
  reminders,
  users,
} from '../db/schema.js';
import { createEvalRunner } from '../modules/admin/eval-run.js';
import { markTrialSpent } from '../modules/billing/subscription.service.js';
import { sendChunk, type BroadcastSender } from '../modules/broadcast/broadcast.service.js';
import { CLASSIFIER_SCHEMA_NAME, PRESENTER_SCHEMA_NAME } from '../modules/ai/schemas/index.js';
import { activatePrompt, seedPrompt } from '../modules/ai/prompts/seed.js';
import { PromptRegistry } from '../modules/ai/prompts/registry.js';
import { hashPassword } from '../http/admin/password.js';
import { createServer } from '../http/server.js';
import { TextsRegistry } from '../texts/registry.js';
import type { Database } from '../infra/db.js';
import { SettingsRegistry } from '../modules/settings/settings.repo.js';
import { setupTestDatabase } from '../test/db.js';

/**
 * Стенд для сквозных проверок панели (§15 ТЗ, задача 4.5).
 *
 * Поднимает **тот же** сервер, что в бою, с той же панелью и той же
 * отдачей файлов — но без базы, очереди и Telegram: вход в панель ни
 * одного из них не касается, а поднимать их ради проверки окна входа
 * значило бы проверять их, а не окно.
 *
 * **Один процесс и один адрес — это часть проверяемого.** Печенье
 * пропуска помечено `SameSite=Strict` и путём `/admin`; если бы стенд
 * отдавал страницу с одного адреса, а API с другого, вход не работал бы
 * именно там, где его проверяют, — и разница с боем всплыла бы на
 * приёмке. Поэтому здесь всё как в бою: панель отдаёт тот же сервер.
 *
 * **Пароль приходит открытым текстом и хэшируется здесь.** В бою в
 * `.env` лежит хэш, но проверке нужно знать пароль, чтобы его ввести.
 * Отдельная переменная с явным именем честнее, чем хэш, подобранный
 * заранее и непонятно к чему относящийся.
 *
 * Запуск делает Playwright сам, см. `playwright.config.ts`.
 */

const PORT = Number(process.env['ADMIN_E2E_PORT'] ?? '3100');
const LOGIN = process.env['ADMIN_E2E_LOGIN'] ?? 'аня';
const PASSWORD = process.env['ADMIN_E2E_PASSWORD'] ?? 'очень-длинный-пароль-42';

/** Секрет из RFC 6238: у проверки должны быть предсказуемые коды. */
const TOTP_SECRET = process.env['ADMIN_E2E_TOTP_SECRET'] ?? 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.env['ADMIN_E2E_DIST'] ?? join(here, '../../../admin/dist');

/**
 * База со предсказуемыми строками учёта — для раздела расходов.
 *
 * **Настоящий путь целиком: база → запрос → страница.** Агрегаты сами
 * покрыты четырнадцатью проверками, страница нарисована отдельно, но
 * между ними есть шов — имена полей в ответе. Переименуй поле в одном
 * месте, и обе половины останутся зелёными, а панель покажет пустоту.
 * Ловится это только сквозным путём.
 *
 * Задаётся отдельной переменной и **только** ею: стенд чистит таблицу
 * учёта, и делать это по адресу из общей настройки было бы способом
 * однажды стереть боевой учёт.
 */
const seedUrl = process.env['ADMIN_E2E_DATABASE_URL'];
let seeded: Database | undefined;

if (seedUrl !== undefined) {
  process.env['TEST_DATABASE_URL'] = seedUrl;
  seeded = await setupTestDatabase();

  await seeded.delete(appSettings);
  // Правки реплик — тоже состояние стенда: остаться от прошлого прогона
  // им нельзя, иначе снимок внешнего вида менялся бы от чужой правки.
  await seeded.delete(textOverrides);
  await seeded.delete(broadcastDeliveries);
  await seeded.delete(broadcasts);
  await seeded.delete(aiCalls);
  /**
   * Счета чистятся **до** людей, и это не порядок ради порядка.
   *
   * У счёта связь с человеком обрывается, а не удаляется: выручка — наша
   * история, а не его данные (§16). Значит удаление людей оставило бы
   * обезличенные счета, и выручка на стенде росла бы с каждым прогоном.
   */
  await seeded.delete(billingEvents);
  await seeded.delete(billingSubscriptions);
  await seeded.delete(billingInvoices);
  /**
   * Коды чистятся тоже — иначе стенд не поднимется во второй раз.
   *
   * Код заведён с первичным ключом по себе, и повторный посев упал бы на
   * нём. Плюс проверка промокодов **создаёт** код: без чистки второй
   * прогон видел бы чужой код из первого и падал бы на «уже есть».
   */
  await seeded.delete(promoCodes);
  await seeded.delete(users);

  const [person] = await seeded
    .insert(users)
    .values({ tgId: 90_001, firstName: 'Аня' })
    .returning({ id: users.id });

  if (person === undefined) throw new Error('стенд: человек не создался');

  const [batch] = await seeded
    .insert(batches)
    .values({ userId: person.id, status: 'done' })
    .returning({ id: batches.id });

  if (batch === undefined) throw new Error('стенд: выгрузка не создалась');

  /**
   * Разбор с текстом и результатом — для карточки (задача 4.6).
   *
   * Сеется настоящая жалоба: человек сказал про врача в четверг, а в
   * записи оказалось другое. Ровно тот случай, ради которого карточка
   * существует, — и проверка читает её так же, как читал бы человек,
   * разбирающий жалобу.
   */
  await seeded.update(batches).set({ combinedText: 'надо записать сына к врачу в четверг' });

  await seeded.insert(items).values({
    userId: person.id,
    sourceBatchId: batch.id,
    text: 'Записать сына к врачу',
    type: 'TASK',
    priority: 'SOON',
    topic: 'семья',
  });

  /**
   * Правка записи вместе со словами, из-за которых она случилась.
   *
   * Ревизия панели: таблица «Применённые изменения» давала когда, какая
   * запись, кто и почему — и ни слова про содержание правки, хотя снимки
   * «до» и «после» лежат в базе целиком с третьего этапа. Жалобу «бот
   * поставил не ту дату» из такой таблицы разобрать было нельзя, и
   * 31.08.2026 за этим ходили в боевую базу через ssh. На стенде этого
   * состояния не было вовсе — то есть починку проверять было нечем.
   *
   * Сообщение с непустым `batch_id`: иначе оно попало бы в разрез
   * «сказано вне выгрузок» и сдвинуло бы его числа. Склейку выгрузки оно
   * тоже не меняет — та задана явно, и карточка берёт её, а сообщения
   * поднимает только у выгрузок без склейки.
   */
  const [saidAgain] = await seeded
    .insert(messagesRaw)
    .values({
      userId: person.id,
      updateId: 910_002,
      tgChatId: 4_001,
      tgMessageId: 2,
      batchId: batch.id,
      kind: 'text',
      text: 'нет, лучше в пятницу',
    })
    .returning({ id: messagesRaw.id });

  const [seededItem] = await seeded
    .select({ id: items.id })
    .from(items)
    .where(eq(items.sourceBatchId, batch.id));

  if (seededItem === undefined) throw new Error('стенд: запись не создалась');

  await seeded.insert(itemRevisions).values({
    itemId: seededItem.id,
    userId: person.id,
    changedBy: 'resolver',
    reason: 'человек назвал другой день',
    /**
     * Меняется **только срок**, текст одинаков в обоих снимках.
     *
     * Так проверяется и обратное: неизменившееся поле в разницу попадать
     * не должно. Печатать все ключи снимка нельзя — там целая строка
     * записи, включая вектор на 256 чисел.
     */
    before: { text: 'Записать сына к врачу', deadlineAt: '2026-09-03T09:00:00.000Z' },
    after: { text: 'Записать сына к врачу', deadlineAt: '2026-09-04T09:00:00.000Z' },
    sourceMessageId: saidAgain?.id ?? null,
  });

  /**
   * Ещё девять человек — для рассылки (задача 4.10).
   *
   * Десяти хватает, чтобы рассылка успела побыть «идущей»: при темпе
   * пять в секунду это две секунды, и кнопку «Остановить» можно
   * нажать не спеша.
   */
  await seeded.insert(users).values(
    Array.from({ length: 9 }, (_, index) => ({
      tgId: 90_100 + index,
      firstName: `человек-${String(index + 1)}`,
    })),
  );

  /**
   * Оплаченная подписка — для выручки и статуса в списке (задача 4.2).
   *
   * У Ани, а не у отдельного человека: колонка «Подписка» проверяется в
   * её строке, и заводить для этого одиннадцатого человека значило бы
   * сдвинуть числа в рассылке и в расходах.
   *
   * Счёт **оплаченный**: выручка считается по оплаченным, и выставленный
   * счёт в неё попасть не должен.
   */
  const [paidInvoice] = await seeded
    .insert(billingInvoices)
    .values({
      provider: 'robokassa:smz',
      userId: person.id,
      plan: 'monthly',
      kind: 'initial',
      amountMinor: 39_900,
      currency: 'RUB',
      ref: 'стенд-оплачен',
      status: 'paid',
      autoRenew: true,
      paidAt: new Date(),
    })
    .returning({ id: billingInvoices.id });

  if (paidInvoice === undefined) throw new Error('стенд: счёт не создался');

  // Брошенный счёт: в выручку он попасть не должен.
  await seeded.insert(billingInvoices).values({
    provider: 'robokassa:smz',
    userId: person.id,
    plan: 'yearly',
    kind: 'initial',
    amountMinor: 399_000,
    currency: 'RUB',
    ref: 'стенд-брошен',
    autoRenew: true,
  });

  /**
   * Промокод с одной оплатой — для блока кодов и разреза (задача 4.4).
   *
   * Оплаченный счёт по коду и полная цена рядом: без неё «недополучено»
   * посчитать нечем, а скидка блогерам выглядела бы провалом продаж.
   */
  await seeded.insert(promoCodes).values({
    code: 'BLOGGER7',
    plan: 'monthly',
    priceRubMinor: 9_900,
    priceStars: 40,
    maxRedemptions: 50,
    note: 'Марина, канал про быт',
  });

  /**
   * Истёкший код — для колонки «До» и пометки «(истёк)» (ревизия панели).
   *
   * Бот такому коду отвечает человеку «код истёк», а панель показывала его
   * живым, с кнопкой «Выключить»: жалобу блогера разобрать было нечем.
   * Срок ставится прошедшим намеренно и без оплат — проверяется пометка, а
   * не счёт применений.
   *
   * Полдень по Гринвичу, а не полночь: у полуночи напечатанная дата
   * зависела бы от часового пояса машины, на которой идёт проверка, и
   * снимок раздела краснел бы от переезда.
   */
  await seeded.insert(promoCodes).values({
    code: 'SPRING5',
    plan: 'monthly',
    priceRubMinor: 14_900,
    priceStars: 60,
    validUntil: new Date('2026-03-31T12:00:00.000Z'),
    note: 'Лена, весенний запуск',
  });

  await seeded.insert(billingInvoices).values({
    provider: 'robokassa:smz',
    userId: person.id,
    plan: 'monthly',
    kind: 'initial',
    amountMinor: 9_900,
    amountFullMinor: 39_900,
    currency: 'RUB',
    ref: 'стенд-по-коду',
    promoCode: 'BLOGGER7',
    status: 'paid',
    autoRenew: false,
    paidAt: new Date(),
  });

  // Источник перехода: по нему считается разрез §14.
  await seeded.update(users).set({ referralSource: 'blogger7' }).where(eq(users.id, person.id));

  /**
   * Момент конца пробного периода — для третьего шага воронки.
   *
   * Ставится настоящим путём, отметкой конвейера: записать его руками
   * значило бы проверить не то, что воронка читает.
   */
  await markTrialSpent(seeded, { batchId: batch.id, trialLimit: 1 });

  await seeded.insert(billingSubscriptions).values({
    provider: 'robokassa:smz',
    userId: person.id,
    plan: 'monthly',
    autoRenew: true,
    currentPeriodEnd: new Date('2027-01-15T10:00:00.000Z'),
  });

  /**
   * Сорвавшийся разбор — для журнала ошибок (задача 4.10).
   *
   * Ровно то, что журнал существует показывать: человек сказал мысль
   * и не получил ответа. Кнопка «Перезапустить» возвращает её в
   * очередь — исполнение обещания из §17.
   *
   * **У отдельного человека, а не у Ани.** Её карточка проверяется
   * по одной выгрузке (задача 4.6), и вторая сбила бы ту проверку:
   * посев стенда — общий, и добавленное для одного раздела не должно
   * ломать другой.
   */
  const [unlucky] = await seeded
    .insert(users)
    .values({ tgId: 90_002, firstName: 'Оля' })
    .returning({ id: users.id });

  if (unlucky === undefined) throw new Error('стенд: второй человек не создался');
  /**
   * Недоплата — для журнала ошибок (задача 4.2).
   *
   * Самая дорогая строка журнала: человек заплатил, доступа не получил.
   * У Оли, а не у Ани: у Ани проверяется живая подписка в списке, и
   * второй неудачный счёт сбил бы разбор.
   */
  await seeded.insert(billingInvoices).values({
    provider: 'robokassa:smz',
    userId: unlucky.id,
    plan: 'monthly',
    kind: 'initial',
    amountMinor: 39_900,
    currency: 'RUB',
    ref: 'стенд-недоплата',
    status: 'failed',
    outSumReceived: '1.00',
    /**
     * Время отказа стоит рядом с самим отказом (ревизия панели).
     *
     * Прежде счёт сеялся со `status: 'failed'` и без него — то есть на
     * стенде работала запасная ветка `coalesce(failed_at, created_at)`, и
     * починка отбора «по времени отказа, а не по дате счёта» не была
     * видна вовсе. Здесь оба времени совпадают: счёт заведён и отвергнут
     * сейчас.
     */
    failedAt: new Date(),
    errorText: 'заплачено 100 RUB, а в счёте 39900 RUB',
  });

  /**
   * Счёт трёхдневной давности, отвергнутый **сегодня** — ревизия панели.
   *
   * Ровно та обстановка, из-за которой находка и написана: счёт заведён в
   * момент нажатия кнопки и живёт до `expires_at`, а недоплата приходит
   * уведомлением тогда, когда человек соберётся заплатить. Отбор по дате
   * счёта выбрасывал такую строку из журнала при выборе «сутки» — то
   * есть самое свежее событие было не видно именно там, где его ищут.
   *
   * У Ани, а не у Оли: две неудачи одного человека в таблице платежей
   * сделали бы поиск строки по имени неоднозначным (строгий режим
   * Playwright), а у Ани живая подписка — продление, которое не прошло,
   * это её штатный случай.
   */
  await seeded.insert(billingInvoices).values({
    provider: 'robokassa:smz',
    userId: person.id,
    plan: 'monthly',
    kind: 'renewal',
    amountMinor: 39_900,
    currency: 'RUB',
    ref: 'стенд-продление-отказ',
    status: 'failed',
    autoRenew: true,
    createdAt: new Date(Date.now() - 3 * 24 * 3_600_000),
    failedAt: new Date(),
    errorCode: 51,
    errorText: 'банк отклонил списание: недостаточно средств',
  });

  /**
   * Не дошедшее письмо рассылки — для журнала ошибок (ревизия панели).
   *
   * Строка журнала обязана назвать свою рассылку и человека: подпись под
   * таблицей велит идти к «нужной рассылке», а идентификаторов раздел
   * рассылки не печатает. Без посева таблица на стенде пуста — и проверка
   * читала бы пустоту как «дефекта нет».
   *
   * Рассылка законченная и с одним неудачным письмом: у такой в разделе
   * рассылки есть кнопка «Повторить неудачные» — то самое, что обещает
   * подпись. Второе письмо дошло: у рассылки, где всё сорвалось, кнопка
   * значила бы другое.
   */
  const [seededBroadcast] = await seeded
    .insert(broadcasts)
    .values({
      text: 'Оплата открылась — вот тарифы.',
      segment: 'all',
      status: 'done',
      createdBy: LOGIN,
      startedAt: new Date(Date.now() - 3_600_000),
      finishedAt: new Date(Date.now() - 3_500_000),
    })
    .returning({ id: broadcasts.id });

  if (seededBroadcast === undefined) throw new Error('стенд: рассылка не создалась');

  await seeded.insert(broadcastDeliveries).values([
    {
      broadcastId: seededBroadcast.id,
      userId: person.id,
      tgId: 90_001,
      status: 'sent',
      at: new Date(Date.now() - 3_550_000),
    },
    {
      broadcastId: seededBroadcast.id,
      userId: unlucky.id,
      tgId: 90_002,
      status: 'failed',
      error: 'Bad Request: message is too long',
      at: new Date(Date.now() - 3_540_000),
    },
  ]);

  /**
   * Сорвавшееся напоминание — пятый источник журнала (§18).
   *
   * На стенде его не было вовсе, поэтому колонку «Какое» проверять было
   * нечем: прежде в ней стоял код из базы («morning» в русской панели), и
   * словарь видов, заведённый ревизией, оставался невидимым. Утреннее
   * взято нарочно — это самый частый вид и тот самый код, что уезжал на
   * экран.
   *
   * Повтора у напоминаний нет и не будет: время прошло, и вечернее письмо
   * на следующий день — не то напоминание, о котором просили.
   */
  await seeded.insert(reminders).values({
    userId: unlucky.id,
    kind: 'morning',
    dueAt: new Date(Date.now() - 3 * 3_600_000),
    dedupeKey: 'morning:стенд',
    attempts: 3,
    skippedReason: 'failed',
  });

  /**
   * Сорвавшаяся выгрузка сеется **без склейки** — правка ревизии этапа.
   *
   * Так это и выглядит в бою: `combined_text` пишется в начале разбора, и
   * у выгрузки, сорвавшейся до него, поле пусто. Прежде стенд сеял её со
   * склейкой — то есть проверял обстановку, которой у сорвавшихся не
   * бывает, и находка «карточка теряет слова именно у сорвавшихся» на
   * стенде была не видна.
   *
   * Слова человека при этом на месте: они сохраняются до всякого разбора
   * (инвариант 1), и карточка поднимает их сама.
   */
  const [unluckyBatch] = await seeded
    .insert(batches)
    .values({
      userId: unlucky.id,
      status: 'failed',
      attempts: 3,
      error: 'TransientSpeechError: распознавание не ответило',
    })
    .returning({ id: batches.id });

  await seeded.insert(messagesRaw).values({
    userId: unlucky.id,
    updateId: 910_001,
    tgChatId: 4_003,
    tgMessageId: 1,
    batchId: unluckyBatch?.id ?? null,
    kind: 'text',
    text: 'надо купить корм коту',
  });

  /**
   * Сорвавшийся разбор **десятидневной давности** — и это не для журнала.
   *
   * Он нужен обзору. Плитку «Сорвалось выгрузок за 30 дней» завела ревизия
   * панели, а единственную сорвавшуюся выгрузку стенда съедает проверка
   * перезапуска в журнале ошибок: после неё число становилось нулём, и
   * снимок обзора зависел от того, гоняли ли соседний файл. Снимок,
   * краснеющий от чужой проверки, учит не смотреть на красное.
   *
   * Десять дней выбраны так, чтобы строка попадала в тридцатидневное окно
   * обзора и **не** попадала в семидневное окно журнала: журнал открыт на
   * семи днях, значит проверки журнала её не видят и «Сорвавшихся разборов
   * за этот срок нет» после перезапуска остаётся правдой.
   *
   * Обстановка настоящая: сорвавшиеся выгрузки нарочно не
   * переподхватываются, и старые лежат, пока их не перезапустят руками.
   */
  await seeded.insert(batches).values({
    userId: unlucky.id,
    status: 'failed',
    attempts: 3,
    openedAt: new Date(Date.now() - 10 * 24 * 3_600_000),
    error: 'TransientSpeechError: распознавание не ответило',
  });

  /**
   * Неуспешный вызов модели — вторая половина журнала.
   *
   * **Цена ноль, а не пусто, и человек тот же, что у расходов.** 429
   * не тарифится — ноль здесь правда. Но не только: пустая цена
   * сделала бы отчёт о расходах неполным («суммы — нижняя граница»), а
   * новый человек в учёте поделил бы средний расход надвое. Посев
   * стенда общий, и добавленное для одного раздела не должно менять
   * числа в другом.
   */
  await seeded.insert(aiCalls).values({
    userId: person.id,
    stage: 'classifier',
    model: 'yandex:yandexgpt/latest',
    promptVersion: 'classifier@9',
    costMicros: 0,
    costCurrency: 'rub',
    latencyMs: 4_000,
    ok: false,
    error: '429 Too Many Requests',
  });

  /**
   * Сорвавшийся вызов **без цены** и без человека — ревизия панели.
   *
   * Обстановки «сбой без цены» на стенде не было вовсе: у соседнего
   * неуспешного вызова цена ноль, и написано, почему (429 не тарифится).
   * Значит оговорку «модели нет в прайс-листе» не проверяло ничто: убери
   * условие на успех из `unpricedSql()` — панель начнёт печатать её после
   * каждого сбоя модели, и ни одна проверка не покраснеет.
   *
   * Человека у строки нет нарочно: так выглядит расход того, кто удалил
   * данные (§16 обнуляет `user_id`), и это вторая обстановка той же
   * ревизии — оговорка про обезличенный расход печатала «Ещё —
   * потрачено». Числа разрезов по людям от строки не меняются: цены у неё
   * нет, а `count(distinct user_id)` пустые не считает.
   *
   * Версии промпта у неё нет намеренно: `classifier@9` проверяется в
   * журнале ошибок по тексту, и второе такое же значение уронило бы ту
   * проверку строгим режимом Playwright.
   */
  await seeded.insert(aiCalls).values({
    stage: 'classifier',
    model: 'yandex:yandexgpt/latest',
    costMicros: null,
    costCurrency: null,
    latencyMs: 12_000,
    ok: false,
    error: 'DeadlineExceeded: модель не ответила за 12 с',
  });

  /** Числа круглые нарочно: проверка читает их глазами, как человек. */
  await seeded.insert(aiCalls).values([
    {
      userId: person.id,
      batchId: batch.id,
      stage: 'router',
      model: 'yandex:yandexgpt-lite/latest',
      costMicros: 2_000_000,
      costCurrency: 'rub',
      latencyMs: 100,
      ok: true,
    },
    {
      userId: person.id,
      batchId: batch.id,
      stage: 'classifier',
      model: 'yandex:yandexgpt/latest',
      // Версия промпта — то, без чего жалобу не разобрать: промпт
      // меняется без выкладки (§15), и к моменту жалобы он уже другой.
      promptVersion: 'classifier@9',
      costMicros: 8_000_000,
      costCurrency: 'rub',
      latencyMs: 200,
      ok: true,
    },
  ]);
}

/**
 * Контрольный набор для раздела промптов (задача 4.8).
 *
 * Настоящий прогон ходит к живой модели по всему набору и стоит денег;
 * запускать его на каждой браузерной проверке нельзя. Поэтому здесь
 * подставляется заглушка, которая делает ровно то, что проверяется в
 * панели: пишет отчёт на **той версии, которую попросили измерить**.
 *
 * Так проверка проходит весь путь целиком — правка, прогон, включение,
 * откат, — и заслон §10.3 в ней настоящий: без отчёта включение
 * отказывает, с отчётом проходит.
 */
const evalDir = process.env['ADMIN_E2E_EVAL_DIR'] ?? join(tmpdir(), 'vydoh-admin-e2e-eval');

let evalRunner;

if (seeded !== undefined) {
  await rm(evalDir, { recursive: true, force: true });
  await mkdir(join(evalDir, 'runs'), { recursive: true });

  await seeded.delete(promptVersions);

  await seedPrompt(seeded, {
    stage: 'classifier',
    version: 'classifier@1',
    prompt: 'Разбери сказанное на отдельные мысли.',
    schemaName: CLASSIFIER_SCHEMA_NAME,
  });

  await seedPrompt(seeded, {
    stage: 'classifier',
    version: 'classifier@2',
    prompt: 'Разбери сказанное на отдельные мысли, аккуратнее со сроками.',
    schemaName: CLASSIFIER_SCHEMA_NAME,
  });

  await activatePrompt(seeded, 'classifier', 'classifier@1');

  /**
   * Версия стадии, которую контрольный набор не мерит.
   *
   * Строка «Набор не мерит: …» иначе не появляется вовсе — на стенде
   * включена только `classifier`, а она измеряется. Именно в этой строке
   * прежде печатались ключи из базы («presenter» в русской панели), при
   * том что в таблице рядом та же стадия называется «Ответ человеку».
   *
   * Заслон §10.3 это не ослабляет: `evalFreshness` считает представление
   * неизмеряемым, вердикт остаётся «прогнан», и метка активности у него
   * своя (`active-presenter`) — счёт включённых у классификации не
   * сдвигается.
   */
  await seedPrompt(seeded, {
    stage: 'presenter',
    version: 'presenter@1',
    prompt: 'Ответь человеку коротко.',
    schemaName: PRESENTER_SCHEMA_NAME,
  });

  await activatePrompt(seeded, 'presenter', 'presenter@1');

  /** Отчёт на том, что включено: страница должна открыться спокойной. */
  await writeFile(
    join(evalDir, 'runs', '2026-09-01T00-00-00-000Z.json'),
    JSON.stringify(passingReport({ classifier: `classifier@1` })),
    'utf8',
  );

  /**
   * Заглушка прогона вместо настоящего: он стоит денег.
   *
   * Отдельным файлом рядом с проверками, а не строкой в `-e`: строку
   * пришлось бы экранировать, а прогон запускается **без** оболочки —
   * нарочно, см. пояснение в `eval-run.ts`.
   */
  const stub =
    process.env['ADMIN_E2E_EVAL_STUB'] ?? join(here, '../../../../tests/admin/eval-stub.mjs');

  evalRunner = createEvalRunner({
    evalDir,
    command: [process.execPath, stub, evalDir],
  });
}

/**
 * Рассылка на стенде: без очереди и без Telegram (задача 4.10).
 *
 * Настоящая рассылка ходит в Telegram и живёт в очереди BullMQ.
 * Браузерной проверке не нужно ни то, ни другое: ей нужно, чтобы
 * предпросмотр показал число, подтверждение запустило отправку, а
 * кнопка «Остановить» её остановила. Всё это — настоящий код рассылки;
 * подменены только отправка и очередь.
 *
 * **Отправка нарочно медленная.** Рассылка на стенде должна успеть
 * побыть «идущей», иначе кнопку «Остановить» не нажать: она исчезает
 * вместе с завершением. Двести миллисекунд на письмо — темп пять в
 * секунду, и десяток адресатов даёт две секунды на нажатие.
 */
const broadcastPace = Number(process.env['ADMIN_E2E_BROADCAST_PER_SECOND'] ?? '5');

let broadcasting: Promise<void> = Promise.resolve();

function runBroadcast(broadcastId: string): Promise<void> {
  if (seeded === undefined) return Promise.resolve();
  const db = seeded;

  /**
   * Заходы идут один за другим — как воркер с одновременностью 1.
   *
   * Иначе две нажатые кнопки дали бы два потока отправки, и стенд
   * перестал бы походить на бой именно там, где это важно.
   */
  broadcasting = broadcasting.then(async () => {
    let step = await sendChunk(
      { db, sender: standSender, perSecond: broadcastPace, chunk: 5 },
      broadcastId,
    );

    while (step.more && !step.stopped) {
      step = await sendChunk(
        { db, sender: standSender, perSecond: broadcastPace, chunk: 5 },
        broadcastId,
      );
    }
  });

  return Promise.resolve();
}

/** Куда «уходят» письма стенда. Проверка их не читает — важен факт. */
const sent: number[] = [];

const standSender: BroadcastSender = {
  send: async ({ tgId }) => {
    sent.push(tgId);
    await Promise.resolve();
  },
};

const app = createServer({
  healthChecks: [],
  adminStaticDir: dist,
  ...(seeded === undefined
    ? {}
    : {
        adminDb: seeded,
        /**
         * Реестр значений без кэша (задача 4.9).
         *
         * Ноль, а не минута: проверка сохраняет значение и сразу читает
         * его обратно. С кэшем она ждала бы истечения и врала бы про
         * «применяется сразу» — панель на боевом сбрасывает кэш сама
         * после записи, и это проверено интеграционным тестом.
         */
        adminSettings: new SettingsRegistry({ db: seeded, ttlMs: 0 }),
        /**
         * Реестр реплик: без него правка из редактора легла бы в
         * таблицу, а бот стенда продолжал бы говорить прежними словами —
         * и браузерная проверка «правка действует сразу» мерила бы не то.
         */
        adminTexts: new TextsRegistry({ db: seeded }),
        adminEvalDir: evalDir,
        /**
         * Реестр промптов — как в бою (ревизия четвёртого этапа).
         *
         * Стенд собирал сервер без него, и браузерная проверка «цикл
         * целиком: создать, прогнать, включить, откатить» проходила
         * композицию, в которой сброса кэша нет вовсе. Проверять
         * композицию, отличающуюся от боевой, — это мерить не то.
         */
        adminPromptRegistry: new PromptRegistry(seeded, 0),
        ...(evalRunner === undefined ? {} : { adminEvalRunner: evalRunner }),
        adminEnqueueBroadcast: runBroadcast,
        /**
         * Перезапуск разбора на стенде ничего не разбирает.
         *
         * Разбор ходит к модели за деньги. Проверяется здесь другое:
         * что кнопка вернула выгрузку в очередь и панель это
         * показала, — а это делает сам `restartBatch`.
         */
        adminEnqueueUser: async () => {
          await Promise.resolve();
        },
      }),
  admin: {
    login: LOGIN,
    passwordHash: await hashPassword(PASSWORD),
    totpSecret: TOTP_SECRET,
    sessionSecret: 'секрет-подписи-для-сквозной-проверки-панели',
    // Стенд без сертификата: с `secure` браузер печенье не сохранит.
    secureCookies: false,
  },
});

app.listen(PORT, '127.0.0.1', () => {
  // Строка нужна Playwright: он ждёт готовности адреса, а не этой
  // печати, но человеку, запустившему стенд руками, она полезна.
  process.stdout.write(
    `Стенд панели: http://127.0.0.1:${String(PORT)}/admin/${String.fromCharCode(10)}`,
  );
});

/** Отчёт прогона, проходящий порог, на заданных версиях. */
function passingReport(versions: Record<string, string>): Record<string, unknown> {
  return {
    expected: 40,
    found: 40,
    missed: 0,
    extra: 0,
    typeCorrect: 40,
    priorityCorrect: 40,
    topicCorrect: 40,
    recurrenceCorrect: 40,
    projectCorrect: 40,
    projectChecked: 40,
    deadlineCorrect: 40,
    falseDeadlines: 0,
    falseTasksFromDesires: 0,
    falseTasksFromEmotions: 0,
    retractedKept: 0,
    crisisExpected: 0,
    crisisDetected: 0,
    crisisFalse: 0,
    crisisMissed: 0,
    failed: 0,
    ambiguous: 0,
    cases: 10,
    promptVersions: versions,
  };
}
