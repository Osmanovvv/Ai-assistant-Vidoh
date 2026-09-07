-- Подписка и оплата (§14 ТЗ, задача 4.2).
--
-- §14 требует: тарифы месячный и годовой со стоимостью из админки, первый
-- платёж с сохранением способа оплаты и дальше автосписание, обработку
-- событий оплаты **с проверкой подписи и защитой от повторной
-- обработки**, отмену автосписания в один тап с сохранением доступа до
-- конца оплаченного периода.
--
-- **Рельсов два, таблицы одни.** Робокасса — основной, Telegram Stars —
-- обязательный второй: правила платёжной платформы Telegram требуют
-- паритета (если цифровую услугу можно купить снаружи, она обязана
-- продаваться и за звёзды). Разводить их по разным таблицам значило бы
-- поддерживать этот паритет в двух местах и однажды разойтись.

CREATE TYPE "billing_plan" AS ENUM ('monthly', 'yearly');

-- Первый платёж и продление различаются не суммой, а смыслом: первый
-- заводит подписку, продление сдвигает срок. И повторяются они по-разному.
CREATE TYPE "billing_charge_kind" AS ENUM ('initial', 'renewal');

CREATE TYPE "billing_invoice_status" AS ENUM (
  'created', 'paid', 'failed', 'expired', 'canceled'
);

CREATE TYPE "billing_sub_status" AS ENUM (
  'active', 'past_due', 'canceled', 'expired'
);

-- Номера счетов для Робокассы.
--
-- Отдельная последовательность, а не max()+1 и не случайное число:
-- повторный номер Робокасса отвергает ошибкой 40, а ноль или пустое
-- значение означает «назначу номер сам» — и тогда наш номер окажется
-- мёртвым. Начало не с единицы, чтобы номера тестового периода не
-- сталкивались с боевыми при переносе.
CREATE SEQUENCE IF NOT EXISTS "billing_inv_id_seq" START WITH 1000 INCREMENT BY 1;

-- Счёт: одна строка на каждую попытку оплаты, включая каждое продление.
CREATE TABLE IF NOT EXISTS "billing_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Чей рельс: 'robokassa:smz' или 'telegram:stars'. С двоеточием, как у
  -- моделей в учёте расхода: по имени видно, чей платёж.
  "provider" text NOT NULL,

  -- Человек уходит — счёт обезличивается, как в учёте расхода.
  --
  -- §16 требует удалить данные человека, но выручка — не его данные, а
  -- наша история: без неё нельзя сказать, сколько продукт заработал.
  -- Ни строчки его текста здесь нет, поэтому строка остаётся, а связь
  -- пропадает.
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,

  "plan" "billing_plan" NOT NULL,
  "kind" "billing_charge_kind" NOT NULL,

  -- НАШ номер счёта, отправленный Робокассе.
  "inv_id" bigint UNIQUE,

  -- ФАКТИЧЕСКИЙ номер из уведомления — и только он годится дальше.
  --
  -- Разделены нарочно. У Робокассы в документации расходятся имена поля
  -- номера счёта (`InvId` в интерфейсе оплаты против `InvoiceID` в
  -- примере материнского платежа), а неизвестное поле она игнорирует и
  -- назначает номер сама. Тогда оплата пройдёт, а наш номер окажется
  -- мёртвым — и через месяц продление всех подписок разом уйдёт в
  -- пустоту. Поэтому продлеваем по номеру, который **пришёл**.
  "provider_inv_id" bigint,

  -- Фактический номер материнского платежа: он идёт в PreviousInvoiceID.
  "parent_inv_id" bigint,

  -- Копейки у рублей, штуки у звёзд. Целое: дробная арифметика в деньгах
  -- однажды даёт 398,99999.
  "amount_minor" integer NOT NULL,
  "currency" text NOT NULL,

  -- Строки сумм хранятся сырыми, потому что подпись считается по строке,
  -- а сверка суммы — по числу. В бою Робокасса присылает шесть знаков
  -- после точки ('399.000000'), в тесте два.
  "out_sum_sent" text,
  "out_sum_received" text,

  "status" "billing_invoice_status" NOT NULL DEFAULT 'created',

  -- Наша метка, которая вернётся в уведомлении: ею событие связывается с
  -- человеком и тарифом.
  "ref" text NOT NULL,

  -- Чек НПД: состояние заведено, автоматики по нему нет.
  --
  -- Вопрос «нужна ли номенклатура Receipt при Робочеках СМЗ у
  -- самозанятой» в документации Робокассы противоречив, а по звёздам
  -- чек она не выпишет вовсе — Stars идут мимо неё. Поле есть, чтобы
  -- ручной случай был видим, а не забыт.
  "receipt_status" text NOT NULL DEFAULT 'unknown',

  -- Почему не открылась оплата. У Робокассы HTTP 200 не означает успех:
  -- код ошибки приезжает внутри страницы (RoboxContext.error.code), и без
  -- сохранённого кода разобраться задним числом нечем.
  "error_code" integer,
  "error_text" text,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "paid_at" timestamp with time zone,
  "expires_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "billing_invoices_user_idx"
  ON "billing_invoices" ("user_id", "created_at" DESC);

-- По этому индексу продление находит материнский платёж.
CREATE INDEX IF NOT EXISTS "billing_invoices_provider_inv_idx"
  ON "billing_invoices" ("provider", "provider_inv_id");

-- Подписка: одна на человека и рельс.
CREATE TABLE IF NOT EXISTS "billing_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" text NOT NULL,

  -- Здесь каскад, в отличие от счёта: подписка ушедшего человека не
  -- значит ничего, а в `subscription_ref` лежит ключ к его способу
  -- оплаты — такому переживать удаление нельзя.
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,

  "plan" "billing_plan" NOT NULL,
  "status" "billing_sub_status" NOT NULL DEFAULT 'active',

  -- Источник правды про автопродление — эта колонка, а не провайдер.
  --
  -- Bot API признака «продление отключено» не отдаёт ни одним методом: по
  -- списку транзакций видно, когда и на сколько заплатили, но не будет ли
  -- следующего платежа. Значит выключаем мы, помним мы, а ответ
  -- провайдера годится только на сверку — и только там, где он есть.
  "auto_renew" boolean NOT NULL DEFAULT true,

  -- До какого времени оплачено. §14: после отмены автосписания доступ
  -- сохраняется до конца оплаченного периода — вот до этого времени.
  --
  -- Двигается ТОЛЬКО подтверждённым уведомлением. Ответ «OK{InvoiceID}»
  -- на дочернее списание означает создание операции, а не списание
  -- денег — сдвигать срок по нему значило бы дарить месяц за неудачную
  -- попытку.
  "current_period_end" timestamp with time zone NOT NULL,

  -- Чем отменять автопродление. Смысл знает только провайдер: у звёзд
  -- это telegram_payment_charge_id, у Робокассы — фактический номер
  -- последнего успешного платежа.
  "subscription_ref" text,

  "canceled_at" timestamp with time zone,
  "last_renewal_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Один человек — одна подписка на рельс. Две активные подписки одного
-- рельса означали бы два списания за один продукт.
CREATE UNIQUE INDEX IF NOT EXISTS "billing_subscriptions_one_idx"
  ON "billing_subscriptions" ("user_id", "provider");

-- Событие оплаты: сырое уведомление и защита от повторной обработки.
CREATE TABLE IF NOT EXISTS "billing_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" text NOT NULL,

  -- Ключ провайдера: пришедший InvId у Робокассы,
  -- telegram_payment_charge_id у звёзд.
  "external_id" text NOT NULL,

  "kind" text NOT NULL,

  -- Каким пришло: 'GET' | 'POST' | 'stars'. Метод уведомления выбирает
  -- владелец магазина в личном кабинете, а не мы.
  "method" text,

  -- Сошлась ли подпись. Несошедшееся тоже записывается и НЕ меняет
  -- состояние: подделка обязана быть видна в журнале, а не выглядеть
  -- посторонним запросом (§16).
  "signature_ok" boolean NOT NULL,

  -- Тело уведомления. Личное вымарывается до записи: почта плательщика
  -- сюда не попадает, иначе она пережила бы удаление данных человека —
  -- строка-то висит на счёте, а не на нём.
  "payload" jsonb NOT NULL,

  "invoice_id" uuid REFERENCES "billing_invoices"("id") ON DELETE SET NULL,

  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone
);

-- **Главный индекс задачи.** Условие готовности 4.2 — «повторная
-- доставка события оплаты не создаёт второй платёж», и держится оно
-- здесь: уникальностью, а не проверкой «сначала посмотрели, потом
-- вставили». Робокасса повторяет уведомления, в том числе одновременно;
-- чтение перед вставкой такую гонку пропускает.
CREATE UNIQUE INDEX IF NOT EXISTS "billing_events_once_idx"
  ON "billing_events" ("provider", "external_id", "kind");

CREATE INDEX IF NOT EXISTS "billing_events_received_idx"
  ON "billing_events" ("received_at" DESC);
