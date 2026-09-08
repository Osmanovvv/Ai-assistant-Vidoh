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
  maxTopics: {
    title: 'Сколько тем',
    hint: 'Больше тем — дольше выбор у модели и длиннее список у человека.',
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

  /**
   * Отказ **чтения** подменяет раздел, отказ **записи** — нет.
   *
   * Ревизия четвёртого этапа. Прежде состояние было одно: неудачная
   * запись убирала со экрана всю таблицу вместе с полями ввода. Человек
   * читал причину («допустимо от 1 до 1000») и не видел поля, которое
   * надо поправить, — а вернуть таблицу можно было только перезагрузкой
   * страницы. Ровно та же правка, что в разделе расходов: ожидание и
   * отказ не должны подменять собой страницу.
   */
  if (unread !== undefined) {
    return (
      <p className="отказ" role="alert">
        {unread}
      </p>
    );
  }

  if (page === undefined) return <p className="разрез__пусто">Читаю…</p>;

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

  return (
    <div data-testid="settings">
      <p className="оговорка">Значения применяются сразу, без выкладки и без перезапуска бота.</p>

      {problem !== undefined && (
        <p className="отказ" role="alert">
          {problem}
        </p>
      )}

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
                        Значение получено замером. Вред от правки виден только на контрольном наборе
                        — прогоните его после изменения.
                      </div>
                    )}
                  </td>
                  <td className="таблица__число" data-testid={`now-${row.name}`}>
                    {row.value}
                    {row.set ? '' : ' (из кода)'}
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

      {page.missing.map((note) => (
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
 */
function PromoBlock(): React.ReactElement {
  const [rows, setRows] = useState<readonly PromoRow[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState({
    code: '',
    plan: 'monthly',
    priceRubMinor: '',
    priceStars: '',
    maxRedemptions: '',
    note: '',
  });

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

  const empty = {
    code: '',
    plan: 'monthly',
    priceRubMinor: '',
    priceStars: '',
    maxRedemptions: '',
    note: '',
  };

  const save = (): void => {
    setProblem(undefined);

    void savePromoCode({
      code: draft.code,
      plan: draft.plan,
      priceRubMinor: Number(draft.priceRubMinor),
      priceStars: Number(draft.priceStars),
      ...(draft.maxRedemptions === '' ? {} : { maxRedemptions: Number(draft.maxRedemptions) }),
      ...(draft.note === '' ? {} : { note: draft.note }),
    })
      .then(() => {
        setDraft(empty);
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
                <th>Кому</th>
                <th> </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.code}>
                  <td data-testid={`promo-${row.code}`}>
                    {row.code}
                    {row.disabledAt === null ? '' : ' (выключен)'}
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
              ))}
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
        Копейки, а не рубли: 9900 = 99 ₽. Звёзды — штуками. «Сколько раз» пусто — без ограничения;
        считаются только оплаченные, брошенный счёт квоту не тратит. Код не короче шести знаков и не
        словарный: его увидят все подписчики блогера.
      </p>
    </div>
  );
}
