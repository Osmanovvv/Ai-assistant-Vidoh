/**
 * Одна сфера под разными формами имени (бой 26.09.2026, 02:03).
 *
 * Модель назвала сферу машины «покупка», у человека своя «покупки»; имена
 * сравнивались точно, и бот завёл вторую сферу с веткой в чате. Две почти
 * одинаковые сферы человек прочтёт как поломку — и будет прав.
 *
 * У однословного имени — набор возможных основ: само слово и слово без
 * каждого подходящего окончания из закрытого списка, основа не короче трёх
 * букв. Имена — одна сфера, если наборы пересекаются: «покупка/покупки»,
 * «финансы/финансов», «здоровье/здоровья», «саморазвитие/саморазвития»,
 * «дом/дома» — да; «работа/рабочее», «здоровье/здоровый», «учёба/учёт» —
 * нет. Одна основа на слово здесь не годится: у «саморазвитие» окончание
 * «-ие» прилагательного отрезало бы лишнюю букву. Имя из нескольких слов
 * сравнивается целиком: окончания там не угадываются.
 */
const ENDINGS = [
  'ого',
  'его',
  'ами',
  'ями',
  'ов',
  'ев',
  'ей',
  'ой',
  'ий',
  'ый',
  'ое',
  'ее',
  'ая',
  'яя',
  'ые',
  'ие',
  'ам',
  'ям',
  'ах',
  'ях',
  'ом',
  'ем',
  'а',
  'я',
  'ы',
  'и',
  'о',
  'е',
  'ь',
  'у',
  'ю',
] as const;

function normalized(name: string): string {
  return name.trim().toLowerCase().replace(/ё/gu, 'е').replaceAll(/\s+/gu, ' ');
}

function stemsOf(name: string): ReadonlySet<string> {
  const word = normalized(name);
  const stems = new Set([word]);
  if (word.includes(' ')) return stems;

  for (const ending of ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) {
      stems.add(word.slice(0, -ending.length));
    }
  }
  return stems;
}

/**
 * Деньги под разными именами (прогон Никиты 27.09.2026, 15:34): модель
 * назвала сферу банка «финансовое», и бот завёл её — без значка, рядом
 * с тем, что у человека могло уже быть «деньгами» или «финансами».
 * Закрытый список: «финанс…» — любое слово с этой основой, и «деньги».
 */
function aboutMoney(name: string): boolean {
  const word = normalized(name);
  return !word.includes(' ') && (word.startsWith('финанс') || stemsOf(word).has('деньг'));
}

/** Имя, под которым бот заводит сферу денег: у него есть значок 💰. */
export const MONEY_TOPIC = 'деньги';

/** Имя сферы из ответа модели, приведённое к известному боту, если оно о деньгах. */
export function knownTopicName(name: string): string {
  return aboutMoney(name) ? MONEY_TOPIC : name;
}

/**
 * Имя из каталога известных боту сфер — или ничего (решение Никиты
 * 27.09.2026).
 *
 * Прогон 27.09.2026, 18:05: под «куртку забрать» модель назвала сферу
 * «личные вещи», и бот завёл её — без значка, рядом с «Личным». Правило
 * заказчицы (14.09.2026, п. 1.1) — «явно нужна новая — завести; не уверен —
 * лучше без новой сферы». «Явно» теперь значит: из каталога, где у каждой
 * сферы есть значок. Сравнение — с учётом формы («детей» — «дети»,
 * «финансовое» — «деньги»); отдаётся имя каталога.
 */
export function catalogueTopic(name: string, catalogue: readonly string[]): string | undefined {
  return catalogue.find((known) => sameTopicName(known, name));
}

export function sameTopicName(one: string, other: string): boolean {
  if (aboutMoney(one) && aboutMoney(other)) return true;

  const theirs = stemsOf(other);
  for (const stem of stemsOf(one)) {
    if (theirs.has(stem)) return true;
  }
  return false;
}
