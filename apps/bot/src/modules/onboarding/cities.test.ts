import { describe, expect, it } from 'vitest';

import { KNOWN_CITIES, stemsOfDirectory, zoneOfCity } from './cities.js';
import { TIMEZONES } from './onboarding.service.js';

/**
 * Город словами — в часовой пояс (задача 3.70).
 *
 * Замечание проджекта: «Другой город не выбирается, как ввести к примеру
 * Краснодар». Кнопок одиннадцать, и это не города, а все часовые пояса
 * России; он искал свой город и не нашёл.
 *
 * **Половина проверок ниже — про то, чего делать нельзя.** Неверный пояс
 * ломает человеку **все** сроки сразу, поэтому догадки здесь запрещены:
 * неизвестное название обязано вернуть «не знаю», а не похожий город.
 */

describe('город в пояс', () => {
  it('боевой случай проджекта: Краснодар — это время Москвы', () => {
    expect(zoneOfCity('Краснодар')).toBe('Europe/Moscow');
  });

  it('города каждого пояса находятся', () => {
    const cases: readonly [string, string][] = [
      ['Калининград', 'Europe/Kaliningrad'],
      ['Москва', 'Europe/Moscow'],
      ['Сочи', 'Europe/Moscow'],
      ['Самара', 'Europe/Samara'],
      ['Саратов', 'Europe/Samara'],
      ['Екатеринбург', 'Asia/Yekaterinburg'],
      ['Уфа', 'Asia/Yekaterinburg'],
      ['Омск', 'Asia/Omsk'],
      ['Красноярск', 'Asia/Krasnoyarsk'],
      ['Новосибирск', 'Asia/Krasnoyarsk'],
      ['Иркутск', 'Asia/Irkutsk'],
      ['Якутск', 'Asia/Yakutsk'],
      ['Чита', 'Asia/Yakutsk'],
      ['Владивосток', 'Asia/Vladivostok'],
      ['Хабаровск', 'Asia/Vladivostok'],
      ['Магадан', 'Asia/Magadan'],
      ['Южно-Сахалинск', 'Asia/Magadan'],
      ['Петропавловск-Камчатский', 'Asia/Kamchatka'],
    ];

    for (const [city, zone] of cases) {
      expect(zoneOfCity(city), city).toBe(zone);
    }
  });

  it('человек пишет так, как говорит', () => {
    // Разговорные названия и падежи: он отвечает на вопрос «где ты».
    const cases: readonly [string, string][] = [
      ['питер', 'Europe/Moscow'],
      ['Питере', 'Europe/Moscow'],
      ['я в Краснодаре', 'Europe/Moscow'],
      ['из Москвы', 'Europe/Moscow'],
      ['город Сочи', 'Europe/Moscow'],
      ['живу в Екатеринбурге', 'Asia/Yekaterinburg'],
      ['ебург', 'Asia/Yekaterinburg'],
      ['Нижний Новгород', 'Europe/Moscow'],
      ['в Нижнем Новгороде', 'Europe/Moscow'],
      ['Ростов-на-Дону', 'Europe/Moscow'],
      ['сейчас в Омске', 'Asia/Omsk'],
      ['Краснодар.', 'Europe/Moscow'],
      ['в Ростове-на-Дону', 'Europe/Moscow'],
      ['в Великом Новгороде', 'Europe/Moscow'],
      ['Грозном', 'Europe/Moscow'],
    ];

    for (const [said, zone] of cases) {
      expect(zoneOfCity(said), said).toBe(zone);
    }
  });

  describe('чего делать нельзя', () => {
    it('неизвестный город — «не знаю», а не похожий', () => {
      /**
       * Здесь и вся цена ошибки. Неверный пояс ломает **все** сроки
       * человека, поэтому справочник закрытый, а догадка по созвучию
       * запрещена.
       */
      for (const said of ['Зеленоградск', 'Ковров', 'Мытищи', 'Дубна', 'Урюпинск']) {
        expect(zoneOfCity(said), said).toBeUndefined();
      }
    });

    it('чужая страна не угадывается', () => {
      for (const said of ['Минск', 'Алматы', 'Ереван', 'Тбилиси', 'Берлин']) {
        expect(zoneOfCity(said), said).toBeUndefined();
      }
    });

    it('мысль человека городом не считается', () => {
      /**
       * Ответ приходит обычным сообщением, и если бы разбор принимал за
       * город что попало, мысль ушла бы в настройку пояса вместо разбора.
       */
      for (const said of [
        'надо купить продукты',
        'а где я — сам догадайся',
        'не помню',
        'позвонить бабушке вечером и вынести мусор',
        '',
        '   ',
        '???',
      ]) {
        expect(zoneOfCity(said), said).toBeUndefined();
      }
    });

    it('длинная фраза городом не считается', () => {
      // Больше трёх слов — это уже не ответ «где ты».
      expect(zoneOfCity('я вообще живу сейчас в городе Краснодаре')).toBeUndefined();
    });
  });

  it('все пояса справочника есть среди кнопок', () => {
    /**
     * Справочник обязан попадать в **правильное время**, а не в
     * правильное имя зоны. Пояс, которого нет на кнопках, означал бы, что
     * справочник и опрос разъехались, и человек получил бы время, которое
     * бот больше нигде не умеет считать.
     */
    const onButtons = new Set(TIMEZONES.map((one) => one.zone));

    for (const city of ['Москва', 'Самара', 'Чита', 'Южно-Сахалинск', 'Новосибирск']) {
      const zone = zoneOfCity(city);
      expect(zone, city).toBeDefined();
      expect(onButtons.has(zone ?? ''), `${city} → ${zone ?? '—'}`).toBe(true);
    }
  });

  it('основы двух разных городов не совпадают', () => {
    /**
     * Самая опасная ошибка справочника. Сверка идёт по основам, и если бы
     * основы двух городов из **разных** поясов совпали, человек получил бы
     * чужое время — то есть все его сроки поехали бы молча.
     */
    const seen = new Map<string, { readonly zone: string; readonly city: string }>();
    const clashes: string[] = [];

    for (const one of stemsOfDirectory()) {
      const already = seen.get(one.stem);

      if (already !== undefined && already.zone !== one.zone) {
        clashes.push(
          `«${one.stem}»: ${already.city} (${already.zone}) и ${one.city} (${one.zone})`,
        );
      }

      seen.set(one.stem, { zone: one.zone, city: one.city });
    }

    expect(clashes, clashes.join('; ')).toEqual([]);
  });

  it('справочник не пуст и не подозрительно мал', () => {
    // Число здесь не ради числа: пустой справочник прошёл бы все проверки
    // выше, потому что все они про «не угадывать».
    expect(KNOWN_CITIES).toBeGreaterThan(80);
  });
});
