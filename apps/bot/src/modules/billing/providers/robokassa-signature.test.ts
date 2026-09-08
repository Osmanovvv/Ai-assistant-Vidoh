import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  BadUserParamError,
  checkoutSignature,
  minorOf,
  opStateSignature,
  outSumOf,
  recurringSignature,
  resultSignature,
  userParamsPart,
} from './robokassa-signature.js';

/**
 * Подписи Робокассы (§14 ТЗ, задача 4.2).
 *
 * **Проверить подпись на живом сервисе мы сейчас не можем**: магазин
 * заказчицы ещё не подключён. Поэтому формула пиннится к строкам,
 * выписанным из документации Робокассы **дословно** — они и есть эталон.
 * Ожидаемое значение считается в проверке независимо от реализации: тест
 * собирает документированную строку сам и берёт от неё хеш.
 *
 * Так проверяется то единственное, что здесь можно проверить без
 * магазина: порядок полей, разделитель и место пароля. Ошибка в любом из
 * трёх даёт одну и ту же невнятную «ошибку 29» — и уже на боевом.
 *
 * Дословные примеры из раздела «Примеры сочетаний модификаторов»:
 *
 *     MerchantLogin:OutSum:InvId:Пароль#1
 *     MerchantLogin:OutSum:InvId:Receipt:Пароль#1
 *     MerchantLogin:OutSum:InvId:Receipt:Пароль#1:Shp_order=25
 *     MerchantLogin:OutSum:InvId:StepByStep:ResultUrl2:Пароль#1
 *     MerchantLogin:OutSum:InvId:Receipt:SuccessUrl2:SuccessUrl2Method:FailUrl2:FailUrl2Method:Пароль#1
 */

const md5 = (source: string): string => createHash('md5').update(source, 'utf8').digest('hex');

const SHOP = 'выдох-магазин';
const P1 = 'первый-пароль';
const P2 = 'второй-пароль';

describe('подпись ссылки на оплату — пароль №1', () => {
  it('без модификаторов: MerchantLogin:OutSum:InvId:Пароль#1', () => {
    // Наш случай: месячная подписка, чека нет, пользовательских нет.
    const expected = md5([SHOP, '399.00', '1001', P1].join(':'));

    expect(
      checkoutSignature({
        merchantLogin: SHOP,
        outSum: '399.00',
        invId: 1001,
        password1: P1,
      }),
    ).toBe(expected);
  });

  it('пароль стоит НЕ в конце: он перед пользовательскими параметрами', () => {
    /**
     * Первое, на чём здесь ошибаются. Привычка ставить секрет в хвост
     * строки даёт подпись, которая не сойдётся никогда, а Робокасса
     * ответит той же «ошибкой 29», что и на любую другую опечатку.
     */
    const right = md5([SHOP, '399.00', '1001', P1, 'Shp_uid=42'].join(':'));
    const wrong = md5([SHOP, '399.00', '1001', 'Shp_uid=42', P1].join(':'));

    const got = checkoutSignature({
      merchantLogin: SHOP,
      outSum: '399.00',
      invId: 1001,
      userParams: { Shp_uid: '42' },
      password1: P1,
    });

    expect(got).toBe(right);
    expect(got).not.toBe(wrong);
  });

  it('только чек: MerchantLogin:OutSum:InvId:Receipt:Пароль#1', () => {
    const receipt = '%7B%22items%22%3A%5B%5D%7D';
    const expected = md5([SHOP, '399.00', '1001', receipt, P1].join(':'));

    expect(
      checkoutSignature({
        merchantLogin: SHOP,
        outSum: '399.00',
        invId: 1001,
        modifiers: { Receipt: receipt },
        password1: P1,
      }),
    ).toBe(expected);
  });

  it('чек и пользовательский параметр — как в примере с Shp_order=25', () => {
    const receipt = '%7B%7D';
    const expected = md5([SHOP, '399.00', '1001', receipt, P1, 'Shp_order=25'].join(':'));

    expect(
      checkoutSignature({
        merchantLogin: SHOP,
        outSum: '399.00',
        invId: 1001,
        modifiers: { Receipt: receipt },
        userParams: { Shp_order: '25' },
        password1: P1,
      }),
    ).toBe(expected);
  });

  it('холдирование и второй адрес: StepByStep перед ResultUrl2', () => {
    const expected = md5([SHOP, '399.00', '1001', 'true', 'https://a/b', P1].join(':'));

    expect(
      checkoutSignature({
        merchantLogin: SHOP,
        outSum: '399.00',
        invId: 1001,
        // Нарочно в обратном порядке: порядок задаёт формула, а не мы.
        modifiers: { ResultUrl2: 'https://a/b', StepByStep: 'true' },
        password1: P1,
      }),
    ).toBe(expected);
  });

  it('чек и четыре адреса переадресации — в документированном порядке', () => {
    const expected = md5(
      [SHOP, '399.00', '1001', '%7B%7D', 'https://s', 'POST', 'https://f', 'GET', P1].join(':'),
    );

    expect(
      checkoutSignature({
        merchantLogin: SHOP,
        outSum: '399.00',
        invId: 1001,
        modifiers: {
          FailUrl2Method: 'GET',
          FailUrl2: 'https://f',
          SuccessUrl2Method: 'POST',
          SuccessUrl2: 'https://s',
          Receipt: '%7B%7D',
        },
        password1: P1,
      }),
    ).toBe(expected);
  });

  it('отсутствующий модификатор выпадает, пустого места не оставляет', () => {
    /**
     * Строка переменной длины — вот главная ловушка формулы. Заведи мы
     * пустые слоты «на всякий случай», не сошлась бы ни одна подпись:
     * двойное двоеточие в строке появляется ровно в одном месте, и это
     * место — номер счёта.
     */
    const withReceipt = checkoutSignature({
      merchantLogin: SHOP,
      outSum: '399.00',
      invId: 1001,
      modifiers: { Receipt: '%7B%7D' },
      password1: P1,
    });

    const without = checkoutSignature({
      merchantLogin: SHOP,
      outSum: '399.00',
      invId: 1001,
      password1: P1,
    });

    expect(withReceipt).not.toBe(without);
    expect(without).toBe(md5([SHOP, '399.00', '1001', P1].join(':')));
  });

  it('единственный пустой слот — номер счёта', () => {
    // Счёт без номера: Робокасса назначит его сама. Пустое место стоит на
    // позиции номера, а не суммы.
    expect(checkoutSignature({ merchantLogin: SHOP, outSum: '399.00', password1: P1 })).toBe(
      md5([SHOP, '399.00', '', P1].join(':')),
    );
  });

  it('пользовательские параметры сортируются по алфавиту, а не по порядку добавления', () => {
    const straight = checkoutSignature({
      merchantLogin: SHOP,
      outSum: '399.00',
      invId: 1001,
      userParams: { Shp_a: '1', Shp_b: '2', Shp_c: '3' },
      password1: P1,
    });

    const reversed = checkoutSignature({
      merchantLogin: SHOP,
      outSum: '399.00',
      invId: 1001,
      userParams: { Shp_c: '3', Shp_b: '2', Shp_a: '1' },
      password1: P1,
    });

    expect(straight).toBe(reversed);
    expect(straight).toBe(
      md5([SHOP, '399.00', '1001', P1, 'Shp_a=1', 'Shp_b=2', 'Shp_c=3'].join(':')),
    );
  });

  it('алгоритм — параметр, а не константа', () => {
    /**
     * Документация говорит только «по умолчанию MD5» и «должен совпадать
     * с настройками магазина». Зашей мы MD5 в код — и у магазина с
     * SHA256 молча падали бы все подписи, а искали бы мы ошибку в
     * формуле.
     */
    const source = [SHOP, '399.00', '1001', P1].join(':');

    expect(
      checkoutSignature({
        merchantLogin: SHOP,
        outSum: '399.00',
        invId: 1001,
        password1: P1,
        algo: 'sha256',
      }),
    ).toBe(createHash('sha256').update(source, 'utf8').digest('hex'));
  });
});

describe('подпись уведомления — пароль №2 и другая база', () => {
  it('OutSum:InvId:Пароль#2 плюс пользовательские параметры', () => {
    // Пример из документации: 100.000000:450009:Пароль#2:Shp_login=Vasya:Shp_oplata=1
    const expected = md5(['100.000000', '450009', P2, 'Shp_login=Vasya', 'Shp_oplata=1'].join(':'));

    expect(
      resultSignature({
        outSum: '100.000000',
        invId: '450009',
        password2: P2,
        userParams: { Shp_oplata: '1', Shp_login: 'Vasya' },
      }),
    ).toBe(expected);
  });

  it('логина магазина в этой подписи нет вовсе', () => {
    // Перепутать базу с подписью ссылки — значит отвергать настоящие
    // уведомления и потом искать ошибку в пароле.
    const withShop = md5([SHOP, '399.00', '1001', P2].join(':'));

    expect(resultSignature({ outSum: '399.00', invId: '1001', password2: P2 })).not.toBe(withShop);
  });

  it('пароли не взаимозаменяемы: №1 и №2 дают разные подписи', () => {
    /**
     * Самая дорогая путаница из возможных. Считай мы подпись уведомления
     * первым паролем — мы отвергали бы все настоящие уведомления, то
     * есть не продлевали бы ни одну подписку, и виноватой выглядела бы
     * Робокасса.
     */
    const byTwo = resultSignature({ outSum: '399.00', invId: '1001', password2: P2 });
    const byOne = resultSignature({ outSum: '399.00', invId: '1001', password2: P1 });

    expect(byTwo).not.toBe(byOne);

    /*
      Строка про SuccessURL убрана вместе с `successSignature` (ревизия
      четвёртого этапа): подпись возврата с страницы оплаты проверять
      негде — SuccessURL ведёт в чат бота, а не на наш сервер, и решение
      о продлении принимает уведомление. Формула у неё совпадала с
      формулой уведомления, и две одинаковые формулы в двух местах
      однажды разъезжаются.
    */
  });

  it('сумма берётся сырой строкой, как пришла', () => {
    // «399.00» и «399.000000» — одна сумма, но разные подписи: в бою
    // приходит вторая запись, и считать по числу нельзя.
    const short = resultSignature({ outSum: '399.00', invId: '1', password2: P2 });
    const long = resultSignature({ outSum: '399.000000', invId: '1', password2: P2 });

    expect(short).not.toBe(long);
    expect(long).toBe(md5(['399.000000', '1', P2].join(':')));
  });
});

describe('состояние операции и дочернее списание', () => {
  it('OpStateExt: MerchantLogin:InvoiceID:Пароль#2 — третий порядок', () => {
    expect(opStateSignature({ merchantLogin: SHOP, invoiceId: 1001, password2: P2 })).toBe(
      md5([SHOP, '1001', P2].join(':')),
    );
  });

  it('дочернее списание: номер материнского платежа в подпись НЕ входит', () => {
    /**
     * Единственное, что документация про эту подпись говорит прямо. Сама
     * строка не подтверждена ни одним первоисточником и получена
     * исключением — поэтому проверка здесь фиксирует наше **ожидание**,
     * а не документированный факт.
     *
     * Проверить формулу можно только первым живым списанием: тестового
     * режима у метода нет вовсе. Если Робокасса ответит иначе, красной
     * станет именно эта проверка — и это правильное место для красноты.
     */
    expect(
      recurringSignature({ merchantLogin: SHOP, outSum: '399.00', invoiceId: 1002, password1: P1 }),
    ).toBe(md5([SHOP, '399.00', '1002', P1].join(':')));
  });
});

describe('пользовательские параметры проверяются до отправки', () => {
  it('двоеточие в значении отвергается', () => {
    // Двоеточие и есть разделитель: Робокасса разберёт строку иначе, чем
    // собрали мы, и получится всё та же «ошибка 29».
    expect(() => userParamsPart({ Shp_uid: 'a:b' })).toThrow(BadUserParamError);
  });

  it('кириллица в значении отвергается', () => {
    expect(() => userParamsPart({ Shp_plan: 'месяц' })).toThrow(BadUserParamError);
  });

  it('имя без префикса отвергается', () => {
    expect(() => userParamsPart({ uid: '42' })).toThrow(BadUserParamError);
  });

  it('регистр имени значим', () => {
    // Имя в запросе и в подписи обязано браться из одного источника.
    expect(userParamsPart({ Shp_uid: '42' })).toEqual(['Shp_uid=42']);
    expect(() => userParamsPart({ shp_uid: '42' })).toThrow(BadUserParamError);
  });
});

describe('деньги строкой', () => {
  it('копейки превращаются в сумму без дробной арифметики', () => {
    /**
     * `39900 / 100` в JavaScript при некоторых значениях даёт
     * 399.00000000000006 — и такая сумма уедет в подпись как есть.
     */
    expect(outSumOf(39_900)).toBe('399.00');
    expect(outSumOf(1)).toBe('0.01');
    expect(outSumOf(100)).toBe('1.00');
    expect(outSumOf(123_456)).toBe('1234.56');
  });

  it('формат совпадает с тем, что требует Робокасса', () => {
    expect(outSumOf(39_900)).toMatch(/^\d+(\.\d+)?$/u);
  });

  it('ноль и дробь не принимаются', () => {
    expect(() => outSumOf(0)).toThrow();
    expect(() => outSumOf(-1)).toThrow();
    expect(() => outSumOf(1.5)).toThrow();
  });

  it('пришедшая сумма разбирается в копейки в любой записи', () => {
    expect(minorOf('399.00')).toBe(39_900);
    expect(minorOf('399.000000')).toBe(39_900);
    expect(minorOf('399')).toBe(39_900);
    expect(minorOf('0.01')).toBe(1);
  });

  it('мусор вместо суммы не разбирается', () => {
    expect(minorOf('')).toBeUndefined();
    expect(minorOf('399,00')).toBeUndefined();
    expect(minorOf('много')).toBeUndefined();
  });
});
