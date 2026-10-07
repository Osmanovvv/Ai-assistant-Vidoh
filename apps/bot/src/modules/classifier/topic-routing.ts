import { sameTopicName } from '../topics/topic-key.js';

/** Канонические базовые сферы, которые можно подтвердить по смыслу записи. */
type BaseTopic = 'семья' | 'здоровье' | 'работа' | 'покупки' | 'дом' | 'личное';

interface Signal {
  readonly topic: BaseTopic;
  readonly score: number;
}

interface TopicMatch {
  readonly topic: BaseTopic;
  readonly name: string;
}

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const has = (text: string, expression: RegExp): boolean => expression.test(text);

const ACTION =
  /(?:^|\s)(?:купить|куплю|покупать|заказать|закажу|приобрести|оплатить|забрать|получить|сходить|съездить)(?:$|\s)/iu;
const MEDICAL =
  /(?:врач|доктор|стоматолог|ортодонт|педиатр|поликлиник|больниц|клиник|анализ|обследован|прививк|вакцин|ветеринар|ветклиник|лечен|лечеб|реабилит|терапевт|медицин)/iu;
const MEDICINE = /(?:лекарств|медикамент|таблетк|мазь|витамин)/iu;
const WORK =
  /(?:работ|офис|клиент|коллег|начальник|заказчик|отчет|отчёт|продаж|касс|договор|счет|счёт|проект|совещан|юрист|бухгалтер|рабоч)/iu;
/**
 * «Документы» сами по себе не рабочий признак: их можно забрать из МФЦ,
 * школы или поликлиники. Рабочим считаем только явное действие проверки
 * или подготовки документов, либо соседний рабочий контекст.
 */
const WORK_DOCUMENT =
  /(?:проверить|сверить|подготовить|оформить|подписать)\s+(?:все\s+)?документ/iu;
const PURCHASE =
  /(?:товар|продукт|подар|шампун|чеснокодавил|отпугивател|подушк|подгузник|коллаген|корм|молочк|посылк|заказ|wildberries|вайлдбер|озон|маркетплейс|пункт\s+выдач)/iu;
const HOME =
  /(?:дом|квартир|химчист|ремонт|почин|уборк|помыть|убраться|одежд|пальто|стирал|кран|иск?упать|подстричь\s+собак|вычесать\s+собак|груминг)/iu;
const BUY_VERB = /(?:^|\s)(?:купить|куплю|покупать|заказать|закажу|приобрести)(?:$|\s)/iu;
const BUY_ITEM_VERB = /(?:^|\s)(?:купить|куплю|покупать)(?:$|\s)/iu;
const RECEIVE = /(?:^|\s)(?:забрать|получить)(?:$|\s)/iu;
const SEND = /(?:^|\s)(?:отправить|послать|сдать|отнести)(?:$|\s)/iu;
const PERSONAL_SERVICE = /(?:маникюр|педикюр|косметолог|салон)/iu;

function topicInList(topics: readonly string[], canonical: BaseTopic): TopicMatch | undefined {
  const name = topics.find((candidate) => sameTopicName(candidate, canonical));
  return name === undefined ? undefined : { topic: canonical, name };
}

function strongest(signals: readonly Signal[]): BaseTopic | undefined {
  if (signals.length === 0) return undefined;
  const highest = Math.max(...signals.map((signal) => signal.score));
  const winners = new Set(
    signals.filter((signal) => signal.score === highest).map((signal) => signal.topic),
  );
  // Равные признаки означают, что назначение не названо достаточно ясно.
  return winners.size === 1 && highest >= 3 ? [...winners][0] : undefined;
}

/**
 * Возвращает только высокоуверенное смысловое исправление темы.
 *
 * Контекст ветки сюда намеренно не входит: он применяется после этой
 * проверки как тема по умолчанию. Поэтому явный смысл записи побеждает
 * ветку, а спорная запись остаётся для ветки/модели и не угадывается кодом.
 */
export function semanticTopicFor(text: string, topics: readonly string[]): TopicMatch | undefined {
  const value = normalize(text);
  if (value === '') return undefined;

  const signals: Signal[] = [];
  const hasBirthday = has(value, /день\s+рожд|именин/iu);
  const hasChild = has(value, /ребен|детск|сын|доч|малыш/iu);
  const hasSchoolContext = has(value, /школ|садик|детсад|круж|секци|танц/iu);
  const hasMedicalPlace = has(value, MEDICAL);
  const hasMedicine = has(value, MEDICINE);

  // Медицинская цель сильнее слова о родственнике. Доставка лекарства
  // родственнику сама по себе медицинской задачей не считается.
  if (hasMedicalPlace) signals.push({ topic: 'здоровье', score: 5 });
  if (hasMedicine && (BUY_VERB.test(value) || RECEIVE.test(value))) {
    signals.push({ topic: 'здоровье', score: 4 });
  }

  // Семейные события и детская организация жизни. «Сходить в школу» без
  // того, кто и зачем идёт, оставляем неоднозначным (score 2).
  if (hasBirthday) signals.push({ topic: 'семья', score: hasChild ? 5 : 4 });
  if (hasSchoolContext) {
    signals.push({ topic: 'семья', score: hasChild || has(value, /садик|детсад/iu) ? 4 : 2 });
  }
  if (has(value, /оплатить\s+(?:круж|садик|школ)/iu)) {
    signals.push({ topic: 'семья', score: 5 });
  }

  // Рабочая сфера требует самого рабочего объекта/контекста. Имя человека
  // и слово «документы» без назначения рабочего контекста не считаются.
  if (has(value, WORK) || has(value, WORK_DOCUMENT)) signals.push({ topic: 'работа', score: 4 });

  // Покупки: отправка посылки и сдача вещи услугой покупками не являются.
  // Подарок на день рождения — семейное событие, поэтому семейный сигнал
  // выше общего глагола «купить».
  const isPurchaseAction = ACTION.test(value) && !SEND.test(value);
  if (isPurchaseAction && has(value, PURCHASE)) signals.push({ topic: 'покупки', score: 4 });
  // Покупка с конкретным глаголом остаётся покупкой даже для нового товара,
  // которого нет в словаре (например, «купить зелёные яблоки»).
  if (BUY_ITEM_VERB.test(value) && !SEND.test(value)) {
    signals.push({ topic: 'покупки', score: 3 });
  }
  if (has(value, /сходить\s+(?:на\s+)?(?:wildberries|вайлдбер|озон|маркетплейс)/iu)) {
    signals.push({ topic: 'покупки', score: 5 });
  }
  if (RECEIVE.test(value) && has(value, /посылк|заказ|пункт\s+выдач|wildberries|вайлдбер|озон/iu)) {
    signals.push({ topic: 'покупки', score: 5 });
  }
  if (BUY_VERB.test(value) && hasBirthday) {
    signals.push({ topic: 'семья', score: 5 });
  }

  // Дом: бытовая услуга, имущество или уход за животным. Само слово
  // «собака» сферу не определяет: «выкупать собаку» остаётся как выбрала
  // модель/ветка.
  if (has(value, HOME) && !hasMedicalPlace) signals.push({ topic: 'дом', score: 4 });

  // Личные услуги и хобби. Обычный «массаж» намеренно не маршрутизируем:
  // без слов лечения это может быть и личная услуга, и здоровье.
  if (has(value, PERSONAL_SERVICE) || has(value, /рисова|хобби|саморазвит|пополнить\s+баланс/iu)) {
    signals.push({ topic: 'личное', score: 4 });
  }

  const winner = strongest(signals);
  if (winner === undefined) return undefined;

  const match = topicInList(topics, winner);
  return match;
}

/** Сильный сигнал не должен перебивать явно пользовательскую тему, которой нет в каталоге. */
export function shouldApplySemanticTopic(
  currentTopic: string | undefined,
  topics: readonly string[],
  target: TopicMatch | undefined,
): boolean {
  if (currentTopic === undefined || target === undefined) return false;
  return (
    !sameTopicName(currentTopic, target.name) &&
    topics.some((topic) => sameTopicName(topic, currentTopic))
  );
}
