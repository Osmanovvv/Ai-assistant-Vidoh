import type { TextProfile } from '../../texts/types.js';

/**
 * Сферы, которые бот предлагает включить в настройках (§12.1): базовый
 * набор §6.4 плюс те, что чаще всего называют отдельно.
 *
 * До 14.09.2026 этот же список был вопросом опроса «какие сферы важны».
 * Заказчица шаг убрала (её правка, п. 1.1): сферы — внутренняя
 * организация бота, он заводит их сам по содержанию, а человек при
 * желании исправляет. Исправлять он может здесь, в настройках, — и там
 * рядом с этими девятью стоят его собственные сферы, заведённые ботом.
 */
export const TOPIC_CHOICES = [
  'семья',
  'здоровье',
  'работа',
  'покупки',
  'дом',
  'дети',
  'деньги',
  'учёба',
  'личное',
] as const;

export interface TopicButton {
  readonly label: string;
  readonly action: string;
}

/**
 * Клавиатура сфер для настроек: предложенные и свои, по три в ряд.
 * Включённые помечаются галочкой в подписи.
 *
 * Свои сферы человека идут после предложенных: их имена не из списка, а
 * снять их должно быть так же просто, как предложенные, — иначе сфера,
 * которую бот завёл по содержанию, была бы неисправима.
 */
export function topicRows(
  texts: TextProfile,
  mine: readonly string[],
  prefix: string,
): readonly (readonly TopicButton[])[] {
  const marked = new Set(mine);
  const shown: string[] = [...TOPIC_CHOICES, ...mine.filter((name) => !isChoice(name))];
  const rows: TopicButton[][] = [];

  for (let index = 0; index < shown.length; index += 3) {
    rows.push(
      shown.slice(index, index + 3).map((name) => ({
        label: marked.has(name) ? texts.settings.topicChosen(name) : name,
        action: `${prefix}${name}`,
      })),
    );
  }

  return rows;
}

export function isChoice(name: string): name is (typeof TOPIC_CHOICES)[number] {
  return (TOPIC_CHOICES as readonly string[]).includes(name);
}
