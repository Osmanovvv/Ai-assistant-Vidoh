/**
 * Что из тела события оплаты попадает в базу (§16, задача 4.2).
 *
 * **Схема обещала вымарывание, а его не было.** Комментарий к
 * `billing_events.payload` говорит прямо: «Личное вымарывается до
 * записи: почта плательщика сюда не попадает, иначе она пережила бы
 * удаление данных человека — строка-то висит на счёте, а не на нём». Код
 * писал тело целиком: у Робокассы это `EMail` плательщика, у звёзд —
 * весь апдейт вместе с `from.first_name`, `from.username` и `chat`.
 * Строка события на человеке не висит (`invoice_id` при удалении
 * обнуляется), значит его имя и почта оставались в базе навсегда — при
 * том, что §16 обещает удаление, а панель обещает вымарывание.
 *
 * **Разрешительный список, а не запретительный.** Запретительный
 * защищает от полей, которые мы уже знаем; поле, добавленное
 * провайдером завтра, он пропустит молча. Здесь наоборот: остаётся
 * только названное, всё прочее выпадает — и незнакомое поле выпадает
 * тоже. Ценой этого будет «а нового поля в журнале нет», и поэтому
 * рядом пишется список **имён** выпавших полей: имя поля — не
 * персональные данные, а понять по нему, чего не хватает, можно.
 *
 * Список выведен из двух настоящих рельсов, а не придуман: у Робокассы
 * это параметры уведомления ResultURL, у звёзд — поля
 * `successful_payment`, `refunded_payment` и апдейта `subscription`.
 * Читателей у столбца нет ни одного (ни запроса, ни раздела панели),
 * поэтому лишнее в нём не нужно никому — а личное в нём вредно всем.
 */

/** Поля, которые остаются. Вложенные разрешаются своим именем. */
const KEEP = new Set([
  // Оболочки апдейта Telegram.
  'message',
  'successful_payment',
  'refunded_payment',
  'subscription',

  // Звёзды: сумма, метка, ключ платежа и признаки продления.
  'currency',
  'total_amount',
  'invoice_payload',
  'telegram_payment_charge_id',
  'provider_payment_charge_id',
  'subscription_expiration_date',
  'is_recurring',
  'is_first_recurring',
  'state',
  'date',
  'message_id',

  // Робокасса: параметры уведомления ResultURL.
  'OutSum',
  'IncSum',
  'OutSumCurrency',
  'IncCurrLabel',
  'InvId',
  'Fee',
  'PaymentMethod',
  'Currency',
  'SignatureValue',
  'crc',
  'IsTest',
  'Recurring',
  'PreviousInvoiceID',
]);

/**
 * Наши собственные метки. Их значения — наш номер счёта и вид платежа.
 *
 * Берутся по префиксу, как их и читает провайдер: «все с `Shp_`, а не
 * только знакомые». Своё же имя счёта прятать от себя незачем.
 */
const OURS = /^shp_/iu;

/** Глубже настоящие тела не уходят; предел — против кольцевых ссылок. */
const MAX_DEPTH = 8;

function allowed(key: string): boolean {
  return KEEP.has(key) || OURS.test(key);
}

interface Walked {
  readonly value: unknown;
  readonly dropped: readonly string[];
}

function walk(value: unknown, depth: number): Walked {
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return { value: [], dropped: [] };

    const items: unknown[] = [];
    const dropped: string[] = [];

    for (const item of value) {
      const inner = walk(item, depth + 1);
      items.push(inner.value);
      dropped.push(...inner.dropped);
    }

    return { value: items, dropped };
  }

  if (typeof value !== 'object' || value === null) return { value, dropped: [] };

  if (depth >= MAX_DEPTH) return { value: {}, dropped: [] };

  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, inner] of Object.entries(value)) {
    if (!allowed(key)) {
      dropped.push(key);
      continue;
    }

    const walked = walk(inner, depth + 1);
    kept[key] = walked.value;
    dropped.push(...walked.dropped);
  }

  return { value: kept, dropped };
}

/**
 * Тело события без личного — то, что можно хранить вечно.
 *
 * Возвращает объект всегда: столбец `not null`, а «тело не разобралось»
 * — само по себе сведение, которое стоит записать. Имена выпавших полей
 * складываются в `вымарано`; повторы убраны, порядок задан, чтобы
 * снимки не дрожали.
 */
export function safePayload(raw: unknown): Record<string, unknown> {
  const walked = walk(raw, 0);

  const body =
    typeof walked.value === 'object' && walked.value !== null && !Array.isArray(walked.value)
      ? (walked.value as Record<string, unknown>)
      : { значение: walked.value };

  if (walked.dropped.length === 0) return body;

  return {
    ...body,
    вымарано: [...new Set(walked.dropped)].sort((one, two) => one.localeCompare(two)),
  };
}
