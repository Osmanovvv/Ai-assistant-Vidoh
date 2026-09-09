import { and, count, eq, isNotNull, sql } from 'drizzle-orm';

import { billingInvoices, promoCodes, type PromoCode } from '../../db/schema.js';
import { paidInvoicesCount } from './billing.repo.js';
import type { Executor } from '../../infra/db.js';
import type { PlanKind } from './provider.js';
import { priceOf, type Price, type Rail } from './tariffs.js';
import type { SettingsRegistry } from '../settings/settings.repo.js';

/**
 * Промокоды на первый период (§14 ТЗ, задача 4.4).
 *
 * §14 дословно: «Поддержка кода на первый период. Нужны для запуска
 * через блогеров».
 *
 * **Одна функция отвечает на все вопросы «годится ли код».** Срок,
 * выключение, квота, «первый ли это период» — вместе, а не по местам.
 * Раздельные ответы на связанные вопросы в этом проекте уже расходились:
 * так появился `sellable`, сведший «есть провайдер» и «назначена цена» в
 * одно решение.
 *
 * **«На первый период» — состояние, а не флаг.** Скидка полагается тому,
 * у кого нет ни одного оплаченного счёта. Считается запросом, потому что
 * счётчик в профиле, разойдясь с правдой, не сверяется ни с чем — тем же
 * доводом считается и трата пробного периода.
 *
 * **Отказ всегда назван.** «Код не подошёл» без причины отправляет
 * человека писать в поддержку, а причин пять, и четыре из них он может
 * исправить сам: истёк, выключен, кончился, не тот тариф, уже платил.
 */

/** Годный код с обеими ценами: по коду и без него. */
export interface PromoOffer {
  readonly code: string;
  readonly plan: PlanKind;
  readonly rail: Rail;
  /** Цена по коду. */
  readonly price: Price;
  /** Цена без кода — она уйдёт на счёт как полная. */
  readonly full: Price;
}

export type PromoOutcome =
  | { readonly ok: true; readonly offer: PromoOffer }
  /**
   * Почему не подошёл. Каждая причина названа, чтобы бот сказал человеку
   * то, что он может исправить сам.
   */
  | {
      readonly ok: false;
      readonly why: 'unknown' | 'expired' | 'disabled' | 'spent' | 'not-first' | 'no-price';
    };

/**
 * Приведение кода к единому виду.
 *
 * Блогер напишет код в посте как угодно: заглавными, строчными, с
 * пробелами по краям. Человек перепишет как увидел. Хранить и сравнивать
 * можно только что-то одно — выбраны заглавные латиница с цифрами.
 *
 * **Кириллица не принимается, и это не про подпись.** Внешние параметры
 * Робокассы ограничены латиницей, но код туда и не уходит — сумма уже
 * снижена. Причина проще: «ВЫДОХ» и «BЫДОХ» с латинской «B» человек не
 * различит, а бот различит, и разбирать это обращение будет некому.
 */
/**
 * Пределы длины кода — числами, а не только в шаблоне.
 *
 * Названы отдельно, потому что их читают три места: сам шаблон, отказ
 * сервера словами и подсказка в панели. Разбор ревизии нашёл, что они
 * расходились: подсказка обещала «не короче шести знаков», шаблон пускал
 * четыре, а отказ называл третье. Два текста одного экрана противоречили
 * друг другу, и «SALE» заводился молча.
 */
export const CODE_MIN = 4;
export const CODE_MAX = 24;

export function normalizeCode(raw: string): string | undefined {
  const trimmed = raw.trim().toUpperCase();

  // Шаблон собирается из тех же чисел, что называет отказ сервера:
  // второй экземпляр правила однажды разошёлся бы с первым молча.
  const shape = new RegExp(`^[A-Z0-9-]{${String(CODE_MIN)},${String(CODE_MAX)}}$`, 'u');

  return shape.test(trimmed) ? trimmed : undefined;
}

/** Цена по коду на этом рельсе. */
function priceOfCode(promo: PromoCode, rail: Rail): Price {
  return rail === 'telegram:stars'
    ? { amountMinor: promo.priceStars, currency: 'XTR' }
    : { amountMinor: promo.priceRubMinor, currency: 'RUB' };
}

/**
 * Годится ли код этому человеку на этот тариф и рельс.
 *
 * Зовётся дважды: когда человек вводит код (чтобы сразу сказать «да» или
 * «почему нет») и в момент выставления счёта. Второй раз обязателен:
 * между вводом и нажатием кнопки проходит время, за которое код может
 * кончиться, а сам код едет в `callback_data` и подделывается тривиально.
 */
export async function promoFor(
  db: Executor,
  params: {
    readonly code: string;
    readonly userId: string;
    readonly rail: Rail;
    readonly plan: PlanKind;
    readonly settings: SettingsRegistry;
    readonly now?: Date | undefined;
  },
): Promise<PromoOutcome> {
  const code = normalizeCode(params.code);

  if (code === undefined) return { ok: false, why: 'unknown' };

  const now = params.now ?? new Date();

  const [promo] = await db.select().from(promoCodes).where(eq(promoCodes.code, code)).limit(1);

  if (promo === undefined) return { ok: false, why: 'unknown' };
  if (promo.disabledAt !== null) return { ok: false, why: 'disabled' };
  if (promo.validUntil !== null && promo.validUntil.getTime() <= now.getTime()) {
    return { ok: false, why: 'expired' };
  }

  /**
   * Не тот тариф — это «кончился» с точки зрения человека.
   *
   * Отдельной причины у него нет нарочно: код на месяц, нажатый на
   * годовом тарифе, — не ошибка человека, а наша: кнопку со скидкой мы
   * показываем только у того тарифа, к которому код подходит. Дойти сюда
   * можно лишь подделав `callback_data`.
   */
  if (promo.plan !== params.plan) return { ok: false, why: 'unknown' };

  /**
   * Уже платил — скидки нет.
   *
   * Тот же запрос, которым обзор считает «заплатил хоть раз». Отдельной
   * уникальности «человек и код» не нужно: заплатил — второго первого
   * периода не бывает.
   */
  if ((await paidInvoicesCount(db, params.userId)) > 0) return { ok: false, why: 'not-first' };

  if (promo.maxRedemptions !== null) {
    /**
     * Квота — по **оплаченным** счетам.
     *
     * Брошенный счёт квоту тратить не должен: человек нажал кнопку и
     * ушёл думать, а таких больше, чем заплативших. Считай мы
     * выставленные — код кончился бы в первый же день, не принеся ни
     * рубля.
     */
    const [used] = await db
      .select({ total: count() })
      .from(billingInvoices)
      .where(and(eq(billingInvoices.promoCode, code), eq(billingInvoices.status, 'paid')));

    if ((used?.total ?? 0) >= promo.maxRedemptions) return { ok: false, why: 'spent' };
  }

  /**
   * Полная цена нужна и без скидки.
   *
   * Она уходит на счёт, и по ней потом видно, сколько недополучено. Нет
   * полной цены — значит тариф на этом рельсе не продаётся вовсе, и
   * продавать его со скидкой тем более нельзя.
   */
  const full = await priceOf(params.settings, { plan: params.plan, rail: params.rail });

  if (full === undefined) return { ok: false, why: 'no-price' };

  const price = priceOfCode(promo, params.rail);

  /**
   * Код дороже полной цены — не скидка.
   *
   * Так бывает после снижения цены тарифа: код на 299 при цене 199
   * означал бы, что человек по коду платит больше. Отвечаем «цены нет»,
   * а не продаём дороже: заказчице это видно как «код перестал
   * работать», и она поправит число.
   */
  if (price.amountMinor >= full.amountMinor) return { ok: false, why: 'no-price' };

  return {
    ok: true,
    offer: { code, plan: params.plan, rail: params.rail, price, full },
  };
}

/** Код целиком — для панели. */
export interface PromoRow {
  readonly code: string;
  readonly plan: string;
  readonly priceRubMinor: number;
  readonly priceStars: number;
  readonly validUntil: Date | null;
  readonly maxRedemptions: number | null;
  readonly note: string | null;
  readonly disabledAt: Date | null;
  /** Сколько раз по нему заплатили. */
  readonly redeemed: number;
  /** Сколько недополучено: разница полной цены и цены по коду. */
  readonly discountMinor: number;
  readonly currency: string;
  /**
   * Недополученное **по каждой валюте** (ревизия четвёртого этапа).
   *
   * Прежде отдавалась одна величина — рублёвая, если платили и тем и
   * другим, — а «Оплат» рядом считались по обеим. Панель показывала «2
   * применения, недополучено 300 ₽», хотя второе применение было за
   * звёзды и звёздная скидка нигде не появлялась. Складывать их нельзя
   * (курс звезды задаёт Telegram), а молчать о второй валюте —
   * значит показывать неполное число как полное.
   */
  readonly discounts: readonly { readonly currency: string; readonly minor: number }[];
}

/**
 * Все коды со счётом применений — для панели (§15).
 *
 * Одним запросом на все коды, а не по одному на строку: так пишутся
 * панели, которые «почему-то медленные».
 *
 * **Недополученное считается по счёту, а не по разнице с нынешней ценой.**
 * Цена тарифа меняется, и вычитая её сегодня, мы получили бы другую
 * скидку у платежей прошлого месяца. Поэтому полная цена сохранена в
 * самом счёте.
 */
export async function promoRows(db: Executor): Promise<readonly PromoRow[]> {
  const codes = await db.select().from(promoCodes).orderBy(promoCodes.createdAt);

  if (codes.length === 0) return [];

  const usage = await db
    .select({
      code: billingInvoices.promoCode,
      currency: billingInvoices.currency,
      redeemed: count(),
      discount: sql<string>`coalesce(sum(
        coalesce(${billingInvoices.amountFullMinor}, ${billingInvoices.amountMinor})
          - ${billingInvoices.amountMinor}
      ), 0)::bigint`,
    })
    .from(billingInvoices)
    .where(and(isNotNull(billingInvoices.promoCode), eq(billingInvoices.status, 'paid')))
    .groupBy(billingInvoices.promoCode, billingInvoices.currency);

  return codes.map((promo) => {
    const mine = usage.filter((row) => row.code === promo.code);

    /**
     * Рубли и звёзды не складываются — здесь тоже.
     *
     * Курс звезды задаёт Telegram. Если по коду платили и тем и другим,
     * показываем рублёвую часть: она главная, а звёздная видна числом
     * применений. Складывать их в «недополучено» значило бы придумать
     * курс.
     */
    const rubles = mine.find((row) => row.currency === 'RUB');
    const first = rubles ?? mine[0];

    return {
      code: promo.code,
      plan: promo.plan,
      priceRubMinor: promo.priceRubMinor,
      priceStars: promo.priceStars,
      validUntil: promo.validUntil,
      maxRedemptions: promo.maxRedemptions,
      note: promo.note,
      disabledAt: promo.disabledAt,
      redeemed: mine.reduce((sum, row) => sum + row.redeemed, 0),
      discountMinor: Number(first?.discount ?? 0),
      currency: first?.currency ?? 'RUB',
      /**
       * Все валюты — чтобы панель не показывала часть как целое.
       *
       * Порядок задан: рубли первыми, дальше по имени валюты. Без
       * порядка снимок панели дрожал бы от порядка строк Postgres.
       */
      discounts: [...mine]
        .sort((one, two) =>
          one.currency === 'RUB'
            ? -1
            : two.currency === 'RUB'
              ? 1
              : one.currency.localeCompare(two.currency),
        )
        .map((row) => ({ currency: row.currency, minor: Number(row.discount) })),
    };
  });
}

export interface NewPromo {
  readonly code: string;
  readonly plan: PlanKind;
  readonly priceRubMinor: number;
  readonly priceStars: number;
  readonly validUntil?: Date | undefined;
  readonly maxRedemptions?: number | undefined;
  readonly note?: string | undefined;
}

export type SavePromoOutcome =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly why: 'bad-code' | 'bad-price' | 'exists' };

/**
 * Завести код.
 *
 * **Повторный код не перезаписывается.** Заказчица, назвавшая уже
 * существующий код, скорее всего забыла о нём, а не хочет сменить цену:
 * молчаливая перезапись изменила бы условия тем, кто ещё не заплатил, и
 * заметить это было бы нечем.
 *
 * **Заведённый код не правится вовсе — ни здесь, ни где-то ещё.** Здесь
 * стояло обещание отдельного вызова для правки, и такого вызова не было
 * ни в модуле, ни в маршруте: обещание жило только в комментарии
 * (ревизия панели, находка 9). Цена ошибки в цене — новый код и просьба
 * к блогеру переписать пост, и панель говорит об этом словами, а не
 * оставляет догадываться.
 *
 * Правка цены заведённого кода — не мелочь, которую «потом допишем»: код
 * уже опубликован, по нему считается недополученное, а условия тем, кто
 * ещё не заплатил, менялись бы задним числом. Понадобится — заводится
 * отдельным путём, с журналом «что было и что стало», как у правок §16.
 */
export async function savePromo(db: Executor, params: NewPromo): Promise<SavePromoOutcome> {
  const code = normalizeCode(params.code);

  if (code === undefined) return { ok: false, why: 'bad-code' };

  if (
    !Number.isSafeInteger(params.priceRubMinor) ||
    params.priceRubMinor <= 0 ||
    !Number.isSafeInteger(params.priceStars) ||
    params.priceStars <= 0
  ) {
    return { ok: false, why: 'bad-price' };
  }

  const inserted = await db
    .insert(promoCodes)
    .values({
      code,
      plan: params.plan,
      priceRubMinor: params.priceRubMinor,
      priceStars: params.priceStars,
      ...(params.validUntil === undefined ? {} : { validUntil: params.validUntil }),
      ...(params.maxRedemptions === undefined ? {} : { maxRedemptions: params.maxRedemptions }),
      ...(params.note === undefined ? {} : { note: params.note }),
    })
    .onConflictDoNothing({ target: promoCodes.code })
    .returning({ code: promoCodes.code });

  return inserted.length === 0 ? { ok: false, why: 'exists' } : { ok: true, code };
}

/**
 * Выключить или включить код.
 *
 * Выключение, а не удаление: по коду считается, сколько недополучено, и
 * удаление стёрло бы этот счёт вместе с историей запуска у блогера.
 */
export async function setPromoEnabled(
  db: Executor,
  params: { readonly code: string; readonly enabled: boolean; readonly now?: Date | undefined },
): Promise<boolean> {
  const code = normalizeCode(params.code);

  if (code === undefined) return false;

  const updated = await db
    .update(promoCodes)
    .set({ disabledAt: params.enabled ? null : (params.now ?? new Date()) })
    .where(eq(promoCodes.code, code))
    .returning({ code: promoCodes.code });

  return updated.length > 0;
}
