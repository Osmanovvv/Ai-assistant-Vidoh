import { useCallback, useEffect, useState } from 'react';

import { putSetting, settings, type SettingsPage } from './api.js';

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

  const load = useCallback(() => {
    void settings()
      .then((fresh) => {
        setPage(fresh);
        setDrafts({});
      })
      .catch(() => {
        setProblem('Не удалось прочитать настройки');
      });
  }, []);

  useEffect(load, [load]);

  if (problem !== undefined) {
    return (
      <p className="отказ" role="alert">
        {problem}
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
      .catch(() => {
        setProblem('Не удалось сохранить');
      });
  };

  return (
    <div data-testid="settings">
      <p className="оговорка">Значения применяются сразу, без выкладки и без перезапуска бота.</p>

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
    </div>
  );
}
