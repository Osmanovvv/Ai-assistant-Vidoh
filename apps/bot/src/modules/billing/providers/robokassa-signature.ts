import { createHash } from 'node:crypto';

/**
 * Подписи Робокассы (§14 ТЗ, задача 4.2).
 *
 * **Три разных подписи, три разных пароля, три разных порядка полей.** Их
 * легко перепутать, и перепутанные они дают одну и ту же невнятную
 * ошибку 29 «неверная подпись» — на боевом магазине, где отладки нет.
 * Поэтому здесь три отдельные функции, а не одна с параметром: параметр
 * однажды передадут не тот.
 *
 *  - **ссылка на оплату** — пароль №1, база
 *    `MerchantLogin:OutSum:InvId`, дальше модификаторы, потом пароль,
 *    потом пользовательские параметры;
 *  - **уведомление на ResultURL** — пароль №2, база `OutSum:InvId`;
 *  - **`SuccessURL`** — пароль №1, база та же, что у уведомления.
 *
 * Формулы взяты дословно из документации Робокассы и проверены на её же
 * примерах (см. проверки рядом). То, что дословного подтверждения не
 * имеет, вынесено в отдельную функцию с явной пометкой — см.
 * `recurringSignature`.
 *
 * **Алгоритм — параметр, а не константа.** Документация говорит только
 * «по умолчанию MD5» и «должен совпадать с настройками магазина». Зашей
 * мы MD5 в код — и у магазина с SHA256 молча падали бы все подписи.
 */

/** Что поддерживает Node и что встречается в настройках магазина. */
export type HashAlgo = 'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512' | 'ripemd160';

export const DEFAULT_HASH_ALGO: HashAlgo = 'md5';

/**
 * Модификаторы — строго в этом порядке и **только присутствующие**.
 *
 * Отсутствующий модификатор из строки **выпадает**, пустого места не
 * оставляет. Пустой слот в этой строке бывает ровно один — у `InvId`,
 * когда номер счёта не задан вовсе.
 */
const MODIFIERS = [
  'Receipt',
  'StepByStep',
  'ResultUrl2',
  'SuccessUrl2',
  'SuccessUrl2Method',
  'FailUrl2',
  'FailUrl2Method',
  'Token',
] as const;

export type Modifier = (typeof MODIFIERS)[number];

/** Пользовательские параметры: имя с префиксом `Shp_` и значение. */
export type UserParams = Readonly<Record<string, string>>;

export class BadUserParamError extends Error {
  constructor(name: string, why: string) {
    super(`Пользовательский параметр «${name}» не годится: ${why}`);
    this.name = 'BadUserParamError';
  }
}

/**
 * Пользовательские параметры — по алфавиту и без посторонних знаков.
 *
 * **Двоеточие в значении ломает подпись**, потому что двоеточие и есть
 * разделитель: Робокасса разберёт строку иначе, чем собрали мы, и
 * получится всё та же ошибка 29. Поэтому значение проверяется, а не
 * экранируется: экранирование пришлось бы согласовывать с чужой
 * реализацией, а согласовывать её нам не с кем.
 *
 * Сортировка строгая по имени **с префиксом**: так делает Робокасса, и
 * порядок добавления в объект не должен на подпись влиять.
 */
export function userParamsPart(params: UserParams): readonly string[] {
  const names = Object.keys(params).sort((first, second) => (first < second ? -1 : 1));

  return names.map((name) => {
    if (!/^Shp_[A-Za-z0-9_]+$/u.test(name)) {
      throw new BadUserParamError(name, 'имя обязано начинаться с Shp_ и быть латиницей');
    }

    const value = params[name] ?? '';

    if (value.includes(':')) {
      throw new BadUserParamError(name, 'двоеточие в значении ломает подпись');
    }

    if (!/^[A-Za-z0-9_.@-]*$/u.test(value)) {
      throw new BadUserParamError(name, 'в значении только латиница, цифры и . _ - @');
    }

    return `${name}=${value}`;
  });
}

function hash(algo: HashAlgo, source: string): string {
  return createHash(algo).update(source, 'utf8').digest('hex');
}

/**
 * Подпись ссылки на оплату. Пароль №1.
 *
 * Строка: `MerchantLogin:OutSum:InvId` + присутствующие модификаторы в
 * жёстком порядке + `Пароль#1` + пользовательские параметры по алфавиту.
 *
 * **Пароль стоит не в конце.** Он между модификаторами и
 * пользовательскими параметрами — и это первое, на чём здесь ошибаются:
 * привычка ставить секрет в хвост строки даёт подпись, которая никогда
 * не сойдётся.
 *
 * `Receipt` подставляется сюда **уже закодированным** — тем же самым
 * значением, что уходит в поле формы. Разойдись они хоть одним знаком,
 * подпись не сойдётся.
 */
export function checkoutSignature(params: {
  readonly merchantLogin: string;
  readonly outSum: string;
  readonly invId?: number | undefined;
  readonly modifiers?: Partial<Record<Modifier, string>> | undefined;
  readonly userParams?: UserParams | undefined;
  readonly password1: string;
  readonly algo?: HashAlgo | undefined;
}): string {
  const parts: string[] = [
    params.merchantLogin,
    params.outSum,
    // Единственный документированный пустой слот.
    params.invId === undefined ? '' : String(params.invId),
  ];

  for (const name of MODIFIERS) {
    const value = params.modifiers?.[name];
    if (value !== undefined) parts.push(value);
  }

  parts.push(params.password1);
  parts.push(...userParamsPart(params.userParams ?? {}));

  return hash(params.algo ?? DEFAULT_HASH_ALGO, parts.join(':'));
}

/**
 * Подпись уведомления на ResultURL. Пароль **№2**.
 *
 * Строка: `OutSum:InvId:Пароль#2` + пользовательские параметры по
 * алфавиту. Логина магазина здесь нет, и пароль другой — перепутать их с
 * подписью ссылки значит либо принять подделку, либо отвергнуть
 * настоящее уведомление.
 *
 * `outSum` берётся **той самой строкой, что пришла**: в бою Робокасса
 * присылает шесть знаков после точки, в тесте два, и подпись считается
 * по присланному тексту, а не по числу.
 */
export function resultSignature(params: {
  readonly outSum: string;
  readonly invId: string;
  readonly password2: string;
  readonly userParams?: UserParams | undefined;
  readonly algo?: HashAlgo | undefined;
}): string {
  const parts = [
    params.outSum,
    params.invId,
    params.password2,
    ...userParamsPart(params.userParams ?? {}),
  ];

  return hash(params.algo ?? DEFAULT_HASH_ALGO, parts.join(':'));
}

/*
  `successSignature` убрана ревизией четвёртого этапа.

  Подпись SuccessURL проверяет тот, кто принимает возврат человека с
  страницы оплаты. У нас такого пути нет: SuccessURL ведёт в чат бота, а
  не на наш сервер, и решение о продлении принимает **уведомление**
  (ResultURL) — единственное, чему можно верить. Вызывающих у функции не
  было ни одного вне проверок, а формула её совпадала с формулой
  уведомления: две одинаковые формулы в двух местах однажды разъезжаются.

  Появится серверный SuccessURL — подпись вернётся вместе с ним и со
  своим отличием от формулы уведомления, если оно будет.
*/

/**
 * Подпись запроса состояния операции (`OpStateExt`). Пароль №2.
 *
 * Строка: `MerchantLogin:InvoiceID:Пароль#2` — третий порядок полей,
 * отличный от двух предыдущих.
 */
export function opStateSignature(params: {
  readonly merchantLogin: string;
  readonly invoiceId: number;
  readonly password2: string;
  readonly algo?: HashAlgo | undefined;
}): string {
  return hash(
    params.algo ?? DEFAULT_HASH_ALGO,
    [params.merchantLogin, String(params.invoiceId), params.password2].join(':'),
  );
}

/**
 * Подпись дочернего списания. **Формула не подтверждена документацией.**
 *
 * Вынесена отдельно именно поэтому, и пометка здесь не формальность.
 * Документация Робокассы даёт по этому методу состав обязательных полей
 * (`MerchantLogin`, `InvoiceID`, `PreviousInvoiceID`, `OutSum`,
 * `SignatureValue`) и одну прямую оговорку — что `PreviousInvoiceID` в
 * расчёт подписи **не входит**. Самой строки подписи не даёт ни один
 * первоисточник.
 *
 * Отсюда строка ниже получена исключением: база как у ссылки на оплату,
 * без модификаторов (их в дочернем запросе передавать нельзя) и без
 * номера материнского платежа.
 *
 * **Проверить это в тестовом режиме нельзя**: у метода тестового режима
 * нет вовсе. Значит проверяется письмом в поддержку и первым живым
 * списанием на минимальной сумме — и до тех пор ни одно обещание
 * человеку про автопродление по этому рельсу давать нельзя.
 */
export function recurringSignature(params: {
  readonly merchantLogin: string;
  readonly outSum: string;
  readonly invoiceId: number;
  readonly userParams?: UserParams | undefined;
  readonly password1: string;
  readonly algo?: HashAlgo | undefined;
}): string {
  const parts = [
    params.merchantLogin,
    params.outSum,
    String(params.invoiceId),
    params.password1,
    ...userParamsPart(params.userParams ?? {}),
  ];

  return hash(params.algo ?? DEFAULT_HASH_ALGO, parts.join(':'));
}

/**
 * Сумма строкой для Робокассы: из копеек в «399.00».
 *
 * Целочисленно, без промежуточных дробей: `39900 / 100` в JavaScript даёт
 * 399.00000000000006 при некоторых значениях, и такая сумма уедет в
 * подпись как есть.
 */
export function outSumOf(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(`Сумма «${String(amountMinor)}» не годится: нужны целые копейки больше нуля`);
  }

  const rubles = Math.floor(amountMinor / 100);
  const kopecks = amountMinor % 100;

  return `${String(rubles)}.${String(kopecks).padStart(2, '0')}`;
}

/**
 * Разбор пришедшей суммы в копейки.
 *
 * Сравнивать строки сумм нельзя: «399.00» и «399.000000» — одна и та же
 * сумма, записанная по-разному, и в бою приходит вторая запись.
 */
export function minorOf(outSum: string): number | undefined {
  if (!/^\d+(\.\d+)?$/u.test(outSum)) return undefined;

  const [whole = '0', fraction = ''] = outSum.split('.');
  const kopecks = `${fraction}00`.slice(0, 2);

  const value = Number(whole) * 100 + Number(kopecks);

  return Number.isSafeInteger(value) ? value : undefined;
}
