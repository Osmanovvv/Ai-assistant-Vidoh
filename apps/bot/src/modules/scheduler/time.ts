import { localDateParts, startOfDayInZone, type DateParts } from '../classifier/dates.js';

/**
 * Когда наступит «08:30 по-местному» (§11 ТЗ, задача 3.14).
 *
 * «Все времена хранятся в UTC, показываются в поясе пользователя.»
 * Задание планировщика — это момент времени, а человек называет час:
 * между ними стоит пояс, и вся сложность здесь.
 *
 * **Прибавить часы к полуночи недостаточно.** В поясах с переходом на
 * летнее время сутки бывают в 23 и 25 часов, и «полночь плюс восемь с
 * половиной» попадёт на 07:30 или 09:30. В России перехода нет, но
 * продукт не обязан этого знать: одна проверка обходится дешевле, чем
 * напоминание, приходящее на час раньше половину года.
 */

/** Часы и минуты из строки вида «08:30» или «08:30:00». */
export function parseLocalTime(value: string): { hours: number; minutes: number } {
  const [hours = '0', minutes = '0'] = value.split(':');

  return {
    hours: Math.min(23, Math.max(0, Number.parseInt(hours, 10) || 0)),
    minutes: Math.min(59, Math.max(0, Number.parseInt(minutes, 10) || 0)),
  };
}

const MINUTE_MS = 60_000;

/** Сколько минут прошло с местной полуночи в этот момент. */
function localMinutesOf(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const value = (type: string): number =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);

  return value('hour') * 60 + value('minute');
}

/**
 * Момент, в который в поясе человека наступит названное местное время.
 *
 * `onDate` — местная дата, а не UTC: «утро вторника» для Камчатки и для
 * Москвы наступает в разные моменты, но обе называют его вторником.
 */
export function localTimeToUtc(onDate: DateParts, localTime: string, timeZone: string): Date {
  const { hours, minutes } = parseLocalTime(localTime);
  const midnight = startOfDayInZone(onDate, timeZone);

  let candidate = new Date(midnight.getTime() + (hours * 60 + minutes) * MINUTE_MS);

  /**
   * Одна поправка, и её достаточно.
   *
   * Переход сдвигает местное время ровно на час, а второго перехода в
   * тех же сутках не бывает. Проверяем, что попали, и если нет —
   * двигаем на разницу.
   */
  const wantedMinutes = hours * 60 + minutes;
  const actualMinutes = localMinutesOf(candidate, timeZone);

  if (actualMinutes !== wantedMinutes) {
    candidate = new Date(candidate.getTime() + (wantedMinutes - actualMinutes) * MINUTE_MS);
  }

  return candidate;
}

/**
 * Ближайшее наступление местного времени, начиная с указанного момента.
 *
 * Если сегодня оно уже прошло — завтра. Иначе планировщик, запущенный в
 * девять утра, поставил бы утреннее напоминание на восемь тридцать
 * сегодняшнего дня, то есть в прошлое, и отправил бы его немедленно.
 *
 * **Ровно назначенная минута считается наступающей, а не прошедшей.**
 * Строгое сравнение выглядело осторожнее, а на деле пробивало дыру: проход
 * планировщика, случившийся секунда в секунду, уводил напоминание на сутки
 * вперёд, и человек оставался без него молча. От повторной отправки
 * защищает не это сравнение, а ключ задания.
 */
export function nextLocalTime(after: Date, localTime: string, timeZone: string): Date {
  const today = localDateParts(after, timeZone);
  const candidate = localTimeToUtc(today, localTime, timeZone);

  if (candidate.getTime() >= after.getTime()) return candidate;

  const tomorrow = localDateParts(
    new Date(startOfDayInZone(today, timeZone).getTime() + 36 * 60 * MINUTE_MS),
    timeZone,
  );

  return localTimeToUtc(tomorrow, localTime, timeZone);
}

/** Местная дата строкой ГГГГ-ММ-ДД: из неё собирается ключ задания. */
export function localDateKey(at: Date, timeZone: string): string {
  const parts = localDateParts(at, timeZone);

  return [
    String(parts.year),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-');
}
