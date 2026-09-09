import { useCallback, useEffect, useState } from 'react';

import {
  promoCodes,
  putSetting,
  savePromoCode,
  settings,
  switchPromoCode,
  type PromoRow,
  type SettingsPage,
} from './api.js';

/**
 * Настройки (§15 ТЗ, задача 4.9).
 *
 * §15 просит менять числа продукта «без выкладки новой версии».
 * Условие готовности задачи названо про окно тишины: правка применяется
 * без перезапуска сервиса.
 *
 * **Значение, полученное замером, отмечено — и это важнее самой
 * возможности его менять.** Порог близости 0,35 получен замером на
 * десяти живых парах, и от него зависит §21 п.8. Правка вслепую ломает
 * проверенное, а вред виден только на контрольном наборе — платном.
 * Панель обязана сказать это **до** того, как даст поле для ввода:
 * иначе «настройка без выкладки» превращается в способ молча уронить
 * качество. Тот же принцип, что у промптов в задаче 4.8.
 *
 * **Умолчание из кода показано рядом с текущим значением.** Человек,
 * правящий число, должен видеть, откуда оно взялось и к чему вернуться.
 */

/** Человеческие имена настроек. Ключ в базе — не для глаз. */
const TITLES: Record<string, { readonly title: string; readonly hint: string }> = {
  trialDumps: {
    title: 'Пробный период',
    hint: 'Сколько разобранных выгрузок даётся бесплатно. Ноль — пробного периода нет.',
  },
  silenceWindowMs: {
    title: 'Окно ожидания тишины, мс',
    hint: 'Сколько бот ждёт после сообщения, прежде чем начать разбор. Серия голосовых — одна мысль.',
  },
  dumpsPerDay: {
    title: 'Выгрузок в сутки',
    hint: 'Потолок на человека (§10.5). Сообщения сверх него сохраняются, но разбор не заводится.',
  },
  /**
   * Предел числа тем (§6.4, §15).
   *
   * **Подпись говорит, что предел не отнимает уже созданное.** Он
   * действует на создание — начальный набор по ответам опроса и согласие
   * добавить сферу, — а у тех, у кого ветвей уже больше, ничего не
   * убавляется: отнимать у человека ветку, в которой лежат его записи,
   * настройка права не имеет.
   */
  maxTopics: {
    title: 'Сколько тем',
    hint: 'Предел на человека: столько ветвей бот заводит и не больше. Больше тем — дольше выбор у модели и длиннее список у человека. У тех, у кого ветвей уже больше, ничего не убавится.',
  },
  resolverApply: {
    title: 'Порог применения, %',
    hint: 'Ниже этого резолвер спрашивает, а не применяет.',
  },
  resolverCreate: {
    title: 'Порог создания, %',
    hint: 'Ниже этого правка не становится новой записью.',
  },
  resolverSimilarity: {
    title: 'Порог близости, %',
    hint: 'Насколько похожей должна быть запись, чтобы считаться кандидатом.',
  },
  broadcastPerSecond: {
    title: 'Темп рассылки, сообщений в секунду',
    hint: 'Telegram даёт боту около тридцати на всё — включая ответы живым людям. Двадцать оставляет им запас.',
  },

  /**
   * Цены (§14, задача 4.2).
   *
   * **Ноль означает «не продаётся».** Кнопка оплаты при нулевой цене не
   * показывается вовсе, и подсказка обязана это сказать: иначе человек,
   * оставивший ноль, будет искать, почему бот не берёт денег.
   *
   * Рубли — в копейках, и это тоже сказано вслух. «399» в поле, которое
   * ждёт копейки, означает 3 рубля 99 копеек.
   */
  priceMonthlyRub: {
    title: 'Месяц, рубли — в копейках',
    hint: '39900 = 399 ₽. Ноль — тариф не продаётся, и кнопки оплаты не будет.',
  },
  priceYearlyRub: {
    title: 'Год, рубли — в копейках',
    hint: '399000 = 3990 ₽. Ноль — тариф не продаётся.',
  },
  priceMonthlyStars: {
    title: 'Месяц, звёзды Telegram',
    hint: 'Штуками, не копейками. Подписка в звёздах бывает только месячной — потолок 10 000.',
  },
  priceYearlyStars: {
    title: 'Год, звёзды Telegram',
    hint: 'Годовой тариф в звёздах — разовый платёж: автопродления у него не бывает, так устроен Bot API.',
  },
};

export function SettingsPanel(): React.ReactElement {
  const [page, setPage] = useState<SettingsPage | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** Отказ чтения: без значений раздела нет вовсе. Отказ записи — рядом. */
  const [unread, setUnread] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    void settings()
      .then((fresh) => {
        setPage(fresh);
        setDrafts({});
      })
      .catch(() => {
        setUnread('Не удалось прочитать настройки');
      });
  }, []);

  useEffect(load, [load]);

  const save = (name: string, value: string): void => {
    setSaved(undefined);
    setProblem(undefined);

    void putSetting(name, value)
      .then(() => {
        setSaved(name);
        load();
      })
      .catch((error: unknown) => {
        // Причину называет сервер: «допустимо от 1 до 1000» человек
        // исправит, «не удалось сохранить» — нет (ревизия этапа).
        setProblem(error instanceof Error ? error.message : 'Не удалось сохранить');
      });
  };

  /**
   * Отказ чтения печатается **на месте таблицы**, а не вместо раздела.
   *
   * Ревизия четвёртого этапа сделала это для отказа записи: неудачная
   * запись убирала с экрана таблицу вместе с полями ввода, человек читал
   * причину («допустимо от 1 до 1000») и не видел поля, которое надо
   * поправить. До отказа **чтения** правку не довели, и он подменял собой
   * весь раздел вместе с блоком промокодов — а тот читается отдельным
   * запросом и мог ответить нормально (ревизия панели, находка 11).
   *
   * Цена этого: код утёк в публичный канал, его надо срочно выключить, а
   * на экране «Не удалось прочитать настройки» и выключить нечем. Ранний
   * возврат допустим только на отказ чтения того, о чём весь раздел, — а
   * промокоды в настройках не нуждаются ни в одном значении.
   */
  return (
    <div data-testid="settings">
      {page !== undefined && (
        <p className="оговорка">Значения применяются сразу, без выкладки и без перезапуска бота.</p>
      )}

      {problem !== undefined && (
        <p className="отказ" role="alert">
          {problem}
        </p>
      )}

      {unread !== undefined && (
        <p className="отказ" role="alert">
          {unread}
        </p>
      )}

      {unread === undefined && page === undefined && <p className="разрез__пусто">Читаю…</p>}

      {page !== undefined && (
        <div className="таблица-обёртка">
          <table className="таблица">
            <thead>
              <tr>
                <th>Что</th>
                <th className="таблица__число">Сейчас</th>
                <th className="таблица__число">По умолчанию</th>
                <th>Новое значение</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => {
                const known = TITLES[row.name];
                const draft = drafts[row.name] ?? String(row.value);

                return (
                  <tr key={row.name}>
                    <td>
                      <div>{known?.title ?? row.name}</div>
                      <div className="панель__кто">{known?.hint ?? row.key}</div>
                      {row.measured && (
                        <div className="оговорка" style={{ margin: '6px 0 0' }} role="note">
                          Значение получено замером. Вред от правки виден только на контрольном
                          наборе — прогоните его после изменения.
                        </div>
                      )}
                    </td>
                    <td className="таблица__число" data-testid={`now-${row.name}`}>
                      {row.value}
                      {row.rejected === undefined ? (row.set ? '' : ' (из кода)') : ' (из кода)'}
                      {/*
                        Разлад называется словами, а не молчанием.
                        Значение вне пределов реестр молча заменяет
                        умолчанием, и в журнал уходит предупреждение —
                        туда заказчица не смотрит. Без этой строки
                        панель утверждала, что в базе лежит то, что
                        показано.
                      */}
                      {row.rejected !== undefined && (
                        <div
                          className="отказ"
                          style={{ margin: '6px 0 0', fontWeight: 'normal' }}
                          data-testid={`rejected-${row.name}`}
                          role="alert"
                        >
                          В базе {row.rejected}, и это значение отвергнуто пределами: работает
                          умолчание из кода. Сохраните годное число — или его придётся править прямо
                          в базе.
                        </div>
                      )}
                    </td>
                    <td className="таблица__число">{row.fallback}</td>
                    <td>
                      <input
                        className="поле__ввод"
                        style={{ maxWidth: 120 }}
                        name={row.name}
                        inputMode="numeric"
                        value={draft}
                        onChange={(event) => {
                          setDrafts({
                            ...drafts,
                            [row.name]: event.target.value.replace(/\D/gu, ''),
                          });
                        }}
                      />
                      <button
                        type="button"
                        className="период__кнопка"
                        style={{ marginLeft: 8 }}
                        disabled={draft === String(row.value) || draft === ''}
                        onClick={() => {
                          save(row.name, draft);
                        }}
                      >
                        {saved === row.name ? 'Сохранено' : 'Сохранить'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {page?.missing.map((note) => (
        <p className="оговорка" key={note} style={{ marginTop: 20 }}>
          {note}
        </p>
      ))}

      <PromoBlock />
    </div>
  );
}

/**
 * Промокоды (§14, задача 4.4).
 *
 * §14 дословно: «Поддержка кода на первый период. Нужны для запуска
 * через блогеров». Заводить их обязана заказчица сама — иначе запуск у
 * блогера невозможен без нас, а это и есть смысл строки §14.
 *
 * Блоком в разделе настроек, а не девятым разделом панели: §15
 * перечисляет восемь разделов, и девятый был бы расширением объёма.
 *
 * **Код называет цену, а не скидку.** Подсказки говорят это словами:
 * поле в копейках без объяснения означает, что кто-нибудь введёт «199» и
 * продаст месяц за два рубля.
 *
 * **Срок действия достижим с экрана** (ревизия панели, находка 3). Бот
 * срок соблюдает и отвечает человеку «код истёк», колонка есть в базе, а
 * панель не умела ни задать срок, ни показать его: заказчице оставалось
 * помнить и выключить руками. Обратная сторона была хуже — код со сроком
 * в базе показывался живым, с кнопкой «Выключить», пока бот уже отвечал
 * «истёк», и разобрать жалобу блогера было нечем.
 */

/** Пустой черновик формы. Один на сброс после заведения и на первый вид. */
const EMPTY_DRAFT = {
  code: '',
  plan: 'monthly',
  priceRubMinor: '',
  priceStars: '',
  validUntil: '',
  maxRedemptions: '',
  note: '',
};

/**
 * Последний день действия — до конца суток, а не до его начала.
 *
 * `<input type="date">` даёт «2026-09-30», и это полночь: код, заведённый
 * «до 30 сентября», перестал бы работать в ночь **на** тридцатое — за
 * сутки до того, что человек имел в виду, и ровно тогда, когда пост
 * блогера ещё живёт. Строка без часового пояса читается по часам
 * браузера: в этом же поясе панель показывает и все прочие времена.
 */
function endOfDay(date: string): string | undefined {
  const at = new Date(`${date}T23:59:59.999`);

  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** Срок словами. Бессрочный код так и назван — пустая клетка читается как факт. */
function untilText(iso: string | null): string {
  if (iso === null) return 'без срока';

  const at = new Date(iso);

  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleDateString('ru-RU');
}

/** Истёк ли срок. То же правило, что у бота: момент прошёл — код не годится. */
function expired(iso: string | null, now: number): boolean {
  if (iso === null) return false;

  const at = new Date(iso).getTime();

  return !Number.isNaN(at) && at <= now;
}

function PromoBlock(): React.ReactElement {
  const [rows, setRows] = useState<readonly PromoRow[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const load = useCallback(() => {
    void promoCodes()
      .then((page) => {
        setRows(page.rows);
      })
      .catch(() => {
        setProblem('Не удалось прочитать промокоды');
      });
  }, []);

  useEffect(load, [load]);

  const save = (): void => {
    setProblem(undefined);

    void savePromoCode({
      code: draft.code,
      plan: draft.plan,
      priceRubMinor: Number(draft.priceRubMinor),
      priceStars: Number(draft.priceStars),
      // Пусто — без срока: единственный способ сказать «бессрочно».
      ...(draft.validUntil === '' ? {} : { validUntil: endOfDay(draft.validUntil) }),
      ...(draft.maxRedemptions === '' ? {} : { maxRedemptions: Number(draft.maxRedemptions) }),
      ...(draft.note === '' ? {} : { note: draft.note }),
    })
      .then(() => {
        setDraft(EMPTY_DRAFT);
        load();
      })
      .catch((error: unknown) => {
        /**
         * **Причина показывается названной, а не склеенной.**
         *
         * Ревизия четвёртого этапа: здесь стояла одна строка про все три
         * причины сразу, и её же человек видел на сбое сервера. То есть
         * отказ базы предъявлялся как ошибка ввода, и заказчица правила
         * то, что было верным.
         */
        setProblem(error instanceof Error ? error.message : 'Не получилось завести код');
      });
  };

  const switchOne = (code: string, enabled: boolean): void => {
    void switchPromoCode(code, enabled)
      .then(load)
      .catch((error: unknown) => {
        // Причина названа сервером — доносим её, а не пересказываем
        // одним словом «не удалось» (та же правка, что у заведения).
        setProblem(error instanceof Error ? error.message : 'Не удалось изменить код');
      });
  };

  const digitsOnly = (value: string): string => value.replace(/[^0-9]/gu, '');

  /**
   * Одно «сейчас» на весь список: две пометки «истёк», посчитанные в
   * разные миллисекунды, разошлись бы у кода, истекающего в эту секунду.
   */
  const now = Date.now();

  return (
    <div className="разрез" data-testid="promo" style={{ marginTop: 28 }}>
      <h3 className="разрез__имя">Промокоды на первый период</h3>

      <p className="оговорка">
        Код называет <b>цену</b> первого периода, а не скидку. Обе цены обязательны: скидка только
        на карту подталкивала бы людей мимо звёзд, а правила Telegram требуют паритета. Промо-платёж
        разовый — дальше человек платит обычную цену, и сам он не продлевается.
      </p>

      {problem !== undefined && (
        <p className="отказ" role="alert">
          {problem}
        </p>
      )}

      {rows !== undefined && rows.length > 0 && (
        <div className="таблица-обёртка">
          <table className="таблица">
            <thead>
              <tr>
                <th>Код</th>
                <th>Тариф</th>
                <th className="таблица__число">Рубли</th>
                <th className="таблица__число">Звёзды</th>
                <th className="таблица__число">Оплат</th>
                <th className="таблица__число">Недополучено</th>
                <th>До</th>
                <th>Кому</th>
                <th> </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                /**
                 * Истёкший срок помечен так же явно, как выключение.
                 *
                 * Иначе панель показывает код живым, с кнопкой
                 * «Выключить», пока бот отвечает человеку «код истёк», — и
                 * разобрать жалобу блогера нечем. Обе пометки рядом, когда
                 * верны обе: выключение и срок — разные причины, и человек
                 * имеет право знать, какая из них снимается кнопкой.
                 */
                const marks = [
                  ...(row.disabledAt === null ? [] : ['выключен']),
                  ...(expired(row.validUntil, now) ? ['истёк'] : []),
                ];

                return (
                  <tr key={row.code}>
                    <td data-testid={`promo-${row.code}`}>
                      {row.code}
                      {marks.length === 0 ? '' : ` (${marks.join(', ')})`}
                    </td>
                    <td>{row.plan === 'monthly' ? 'месяц' : 'год'}</td>
                    <td className="таблица__число">{(row.priceRubMinor / 100).toFixed(2)} ₽</td>
                    <td className="таблица__число">{row.priceStars} ⭐</td>
                    <td className="таблица__число">
                      {row.redeemed}
                      {row.maxRedemptions === null ? '' : ` из ${String(row.maxRedemptions)}`}
                    </td>
                    {/*
                    Недополученное — **по каждой валюте** (ревизия этапа).

                    Прежде показывалась одна величина, рублёвая, а «Оплат»
                    рядом считались по обеим: «2 применения, недополучено
                    300 ₽», хотя второе было за звёзды и звёздная скидка
                    нигде не появлялась. Складывать нельзя — курс звезды
                    задаёт Telegram, — поэтому обе величины рядом.
                  */}
                    <td className="таблица__число" data-testid={`promo-lost-${row.code}`}>
                      {row.discounts.length === 0
                        ? '—'
                        : row.discounts
                            .map((one) =>
                              one.currency === 'XTR'
                                ? `${String(one.minor)} ⭐`
                                : `${(one.minor / 100).toFixed(2)} ₽`,
                            )
                            .join(' · ')}
                    </td>
                    <td data-testid={`promo-until-${row.code}`}>{untilText(row.validUntil)}</td>
                    <td className="панель__кто">{row.note ?? ''}</td>
                    <td>
                      <button
                        type="button"
                        className="период__кнопка"
                        onClick={() => {
                          switchOne(row.code, row.disabledAt !== null);
                        }}
                      >
                        {row.disabledAt === null ? 'Выключить' : 'Включить'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows?.length === 0 && <p className="разрез__пусто">Кодов пока нет.</p>}

      <div className="период" style={{ marginTop: 16, flexWrap: 'wrap', gap: 8 }}>
        <input
          className="поле__ввод"
          style={{ maxWidth: 170 }}
          name="promoCode"
          placeholder="КОД-БЛОГЕРА"
          value={draft.code}
          onChange={(event) => {
            setDraft({ ...draft, code: event.target.value.toUpperCase() });
          }}
        />
        <select
          className="поле__ввод"
          style={{ maxWidth: 110 }}
          name="promoPlan"
          value={draft.plan}
          onChange={(event) => {
            setDraft({ ...draft, plan: event.target.value });
          }}
        >
          <option value="monthly">месяц</option>
          <option value="yearly">год</option>
        </select>
        <input
          className="поле__ввод"
          style={{ maxWidth: 130 }}
          name="promoRub"
          inputMode="numeric"
          placeholder="копейки"
          value={draft.priceRubMinor}
          onChange={(event) => {
            setDraft({ ...draft, priceRubMinor: digitsOnly(event.target.value) });
          }}
        />
        <input
          className="поле__ввод"
          style={{ maxWidth: 110 }}
          name="promoStars"
          inputMode="numeric"
          placeholder="звёзды"
          value={draft.priceStars}
          onChange={(event) => {
            setDraft({ ...draft, priceStars: digitsOnly(event.target.value) });
          }}
        />
        {/*
          Срок — датой, а не строкой: «до конца сентября» человек напишет
          пятью способами, и разбирать их значило бы однажды завести код
          бессрочным. Пусто — без срока.
        */}
        <input
          className="поле__ввод"
          style={{ maxWidth: 160 }}
          name="promoUntil"
          type="date"
          aria-label="Действует до"
          value={draft.validUntil}
          onChange={(event) => {
            setDraft({ ...draft, validUntil: event.target.value });
          }}
        />
        <input
          className="поле__ввод"
          style={{ maxWidth: 120 }}
          name="promoMax"
          inputMode="numeric"
          placeholder="сколько раз"
          value={draft.maxRedemptions}
          onChange={(event) => {
            setDraft({ ...draft, maxRedemptions: digitsOnly(event.target.value) });
          }}
        />
        <input
          className="поле__ввод"
          style={{ maxWidth: 200 }}
          name="promoNote"
          placeholder="кому выдан"
          value={draft.note}
          onChange={(event) => {
            setDraft({ ...draft, note: event.target.value });
          }}
        />
        <button
          type="button"
          className="период__кнопка"
          name="promoSave"
          disabled={draft.code === '' || draft.priceRubMinor === '' || draft.priceStars === ''}
          onClick={save}
        >
          Завести код
        </button>
      </div>

      <p className="панель__кто">
        Копейки, а не рубли: 9900 = 99 ₽. Звёзды — штуками. «Действует до» — последний день, когда
        код работает; пусто — без срока. «Сколько раз» пусто — без ограничения, а ноль не годится:
        код, который нельзя применить ни разу, не нужен никому. Считаются только оплаченные,
        брошенный счёт квоту не тратит. Код — латиница, цифры и дефис, от 4 до 24 знаков; короткий и
        словарный лучше не брать, его увидят все подписчики блогера.
      </p>

      {/*
        Правки кода нет, и об этом сказано **до** заведения, а не после
        (ревизия панели, находка 9). Опечатка в цене уже опубликованного
        кода лечится только новым кодом, то есть просьбой к блогеру
        переписать пост: человек имеет право знать это, пока цена ещё
        черновик в поле, а не строка в базе.
      */}
      <p className="панель__кто">
        Заведённый код не правится: ни цена, ни срок, ни квота, ни примечание. Ошиблись — выключите
        его и заведите новый; выключение не стирает счёт применений и недополученного.
      </p>
    </div>
  );
}
