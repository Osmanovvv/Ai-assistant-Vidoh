import express, { Router, type Request, type Response } from 'express';
import type { Logger } from 'pino';

import type { Executor } from '../infra/db.js';
import { invoiceByRef, recordEvent } from '../modules/billing/billing.repo.js';
import type { PaymentProvider } from '../modules/billing/provider.js';
import { ROBOKASSA_RAIL } from '../modules/billing/providers/robokassa.js';
import { applyPaymentEvent } from '../modules/billing/subscription.service.js';

/**
 * Приём уведомлений об оплате (§14 ТЗ, задача 4.2).
 *
 * §14 требует «обработку статусов платежа с проверкой подписи и защитой
 * от повторной обработки». Здесь первое; второе — уровнем ниже, в
 * `applyPaymentEvent`, уникальным индексом.
 *
 * **Отвечать надо ровно `OK<номер>`.** Так требует Робокасса, и ответ
 * этот — не вежливость: не получив его, она повторит уведомление. И
 * повторит верно: значит наш ответ обязан быть или подтверждением, или
 * отказом, но никогда «двухсоткой с JSON».
 *
 * **Принимаем и GET, и POST.** Метод уведомления выбирает владелец
 * магазина в личном кабинете, а не мы. Поддержать один — значит однажды
 * не получить ни одного уведомления и искать причину в подписи.
 *
 * **Уведомление с несошедшейся подписью записывается, но ничего не
 * меняет.** Подделка обязана быть видна в журнале (§16), а не выглядеть
 * посторонним запросом: адрес нашего ResultURL знает кто угодно, и
 * попытка продлить себе подписку бесплатно — первое, что тут попробуют.
 */

/** Путь уведомления. Его же заказчица вписывает в личный кабинет. */
export const ROBOKASSA_RESULT_PATH = '/billing/robokassa/result';

export interface BillingHttpDeps {
  readonly db: Executor;
  /** Провайдер Робокассы: он и разбирает уведомление, и проверяет подпись. */
  readonly robokassa: PaymentProvider;
  readonly logger?: Logger | undefined;
  /**
   * Что делать после удавшейся оплаты — например, сказать человеку.
   *
   * Необязательно: молчаливое продление хуже, но лучше, чем упавшее
   * уведомление. Отказ здесь не должен мешать ответить Робокассе `OK`,
   * иначе она повторит доставку, а подписка уже продлена.
   */
  readonly onPaid?:
    ((params: { readonly userId: string; readonly paidUntil: Date }) => Promise<void>) | undefined;
}

/**
 * Тело уведомления как набор строк.
 *
 * Значения приходят снаружи и могут быть массивами (`?a=1&a=2`) или
 * объектами: express разбирает такое честно, а нам нужны строки. Всё
 * остальное отбрасывается — подпись по нему всё равно не сойдётся.
 */
function stringsOf(source: unknown): Record<string, string> {
  if (typeof source !== 'object' || source === null) return {};

  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string') out[name] = value;
  }

  return out;
}

export function createBillingRouter(deps: BillingHttpDeps): Router {
  const router = Router();

  /**
   * Разбор тела — только здесь и только форменный.
   *
   * Робокасса присылает `application/x-www-form-urlencoded`; JSON она не
   * присылает вовсе, и подключать его разборщик значило бы завести лишнюю
   * поверхность на пути, куда стучится кто угодно.
   */
  router.use(ROBOKASSA_RESULT_PATH, express.urlencoded({ extended: false, limit: '16kb' }));

  const handle = (method: 'GET' | 'POST') => {
    return (req: Request, res: Response): void => {
      const incoming = { ...stringsOf(req.query), ...stringsOf(req.body) };

      void (async () => {
        try {
          const event = await deps.robokassa.readEvent(incoming);

          if (event === undefined) {
            // Не уведомление Робокассы вовсе: кто-то просто зашёл по
            // адресу. Отвечаем отказом, но без шума в журнале.
            res.status(400).type('text/plain').send('не уведомление');
            return;
          }

          const outcome = await applyPaymentEvent(deps.db, {
            provider: ROBOKASSA_RAIL,
            event,
            method,
            payload: incoming,
            ...(incoming['OutSum'] === undefined ? {} : { outSum: incoming['OutSum'] }),
          });

          if (outcome.kind === 'unknown') {
            /**
             * Подпись сошлась, а метки нет ни в одном счёте.
             *
             * Это не подделка — подпись настоящая, — но и продлевать
             * некому. Такое бывает после удаления данных человека.
             * Отвечаем `OK`: повторять это уведомление незачем, ничего
             * не изменится.
             */
            deps.logger?.warn({ why: outcome.why }, 'Оплата пришла, но продлевать некому');
          }

          if (outcome.kind === 'promoSpent') {
            /**
             * Оплачена промо-ссылка, а право на скидку уже израсходовано.
             *
             * Отвечаем `OK`: уведомление доставлено, повторять незачем —
             * второй раз придёт то же самое. Но в журнале это ошибка:
             * деньги у нас, периода по этой цене человек не получил, и
             * разобрать это должен человек.
             */
            deps.logger?.error(
              { code: outcome.code, paidBefore: outcome.paidBefore },
              'Оплачена промо-ссылка повторно: право на скидку израсходовано, разбирать руками',
            );
          }

          if (outcome.kind === 'underpaid') {
            /**
             * Сумма не сошлась со счётом — доступа не дали.
             *
             * Отвечаем `OK`: уведомление доставлено, и повторять его
             * незачем — второй раз придёт та же сумма. Но в журнале это
             * ошибка, а не предупреждение: деньги у нас, услуга не
             * выдана, и разобрать это должен человек, а не следующий
             * платёж.
             */
            deps.logger?.error(
              {
                invId: incoming['InvId'],
                ожидали: outcome.expected,
                пришло: outcome.got,
                валюта: outcome.currency,
              },
              'Оплата пришла не на ту сумму: доступ не выдан',
            );
          }

          if (outcome.kind === 'applied' && deps.onPaid !== undefined) {
            const invoiceUser = await usersOfEvent(deps, event.ref);

            if (invoiceUser !== undefined) {
              /**
               * Сбой оповещения не должен мешать ответить `OK`.
               *
               * Подписка уже продлена. Не ответь мы — Робокасса повторит
               * доставку, а повтор отобьётся идемпотентностью, и человек
               * не узнает вообще ничего.
               */
              await deps
                .onPaid({ userId: invoiceUser, paidUntil: outcome.paidUntil })
                .catch((error: unknown) => {
                  deps.logger?.error({ err: error }, 'Не удалось сказать человеку про оплату');
                });
            }
          }

          /**
           * Ответ ровно `OK<номер>` — тем же текстом, что пришёл.
           *
           * Не `String(Number(invId))`: пришедшее значение уходит обратно
           * как есть. И без перевода строки: формат Робокассы — `^OK\d+$`.
           */
          res
            .status(200)
            .type('text/plain')
            .send(`OK${incoming['InvId'] ?? ''}`);
        } catch (error) {
          /**
           * Сюда попадает несошедшаяся подпись — и это главный случай.
           *
           * Записываем попытку и отвечаем отказом. Ответить `OK` значило
           * бы сказать «принято» подделке; ответить пятисотым — позвать
           * Робокассу повторять то, что повторять не нужно.
           */
          const invId = incoming['InvId'] ?? 'нет-номера';

          deps.logger?.warn(
            { err: error, invId, method },
            'Уведомление об оплате отвергнуто: не сошлась подпись или не разобралось',
          );

          await recordEvent(deps.db, {
            provider: ROBOKASSA_RAIL,
            externalId: invId,
            kind: 'forged',
            signatureOk: false,
            payload: incoming,
            method,
          }).catch((writeError: unknown) => {
            deps.logger?.error({ err: writeError }, 'Не удалось записать отвергнутое уведомление');
          });

          res.status(400).type('text/plain').send('подпись не сошлась');
        }
      })();
    };
  };

  router.get(ROBOKASSA_RESULT_PATH, handle('GET'));
  router.post(ROBOKASSA_RESULT_PATH, handle('POST'));

  return router;
}

/**
 * Кому принадлежит счёт с этой меткой.
 *
 * Отдельной функцией, потому что `applyPaymentEvent` возвращает исход, а
 * не человека: ей человек нужен внутри, а наружу она отдаёт смысл. Тащить
 * его через возврат значило бы, что каждый вызывающий получает то, что
 * ему не нужно.
 */
async function usersOfEvent(deps: BillingHttpDeps, ref: string): Promise<string | undefined> {
  const invoice = await invoiceByRef(deps.db, { provider: ROBOKASSA_RAIL, ref });

  return invoice?.userId ?? undefined;
}
