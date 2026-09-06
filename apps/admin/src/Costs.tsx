import { useEffect, useState } from 'react';

import { costs, type CostRow, type Costs as CostsReport, type Money } from './api.js';

/**
 * Расходы (§15 ТЗ, §21 п.14; задача 4.7).
 *
 * §21 п.14 — прямой критерий приёмки: «в админ-панели виден расход по
 * каждому пользователю и по этапам». Три разреза, два средних и две
 * оговорки, без которых отчёт врёт.
 *
 * **Оговорка первая: неизвестные цены.** Если хоть у одного вызова нет
 * цены, суммы — нижняя граница, и об этом сказано словами, а не сноской
 * мелким шрифтом. Отчёт, выглядящий точным при неполных данных, хуже
 * отсутствующего.
 *
 * **Оговорка вторая: обезличенный расход.** §16 обнуляет `user_id` при
 * удалении данных, поэтому сумма по людям меньше общей. Разница показана
 * отдельной строкой — иначе человек будет искать ошибку там, где её нет.
 *
 * **Валюты не складываются.** Две строки вместо одного неправильного
 * числа.
 */

/** Микро-единицы в читаемую сумму. Валюта решает знак. */
function money(list: readonly Money[]): string {
  if (list.length === 0) return '—';

  return list
    .map((one) => {
      const amount = (one.micros / 1_000_000).toFixed(2);
      return one.currency === 'usd' ? `$${amount}` : `${amount} ₽`;
    })
    .join(' + ');
}

function Table({
  title,
  rows,
  head,
}: {
  readonly title: string;
  readonly rows: readonly (CostRow & { readonly label?: string })[];
  readonly head: string;
}): React.ReactElement {
  return (
    <section className="разрез">
      <h2 className="разрез__имя">{title}</h2>

      {rows.length === 0 ? (
        <p className="разрез__пусто">За период ничего не потрачено.</p>
      ) : (
        <table className="таблица">
          <thead>
            <tr>
              <th>{head}</th>
              <th className="таблица__число">Вызовов</th>
              <th className="таблица__число">Сбоев</th>
              <th className="таблица__число">Без цены</th>
              <th className="таблица__число">Расход</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.label ?? row.key}</td>
                <td className="таблица__число">{row.calls}</td>
                <td className="таблица__число">{row.failed > 0 ? row.failed : '—'}</td>
                <td className="таблица__число">
                  {row.unknownPrices > 0 ? row.unknownPrices : '—'}
                </td>
                <td className="таблица__число">{money(row.money)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Costs(): React.ReactElement {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<CostsReport | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    setProblem(undefined);

    void costs(days)
      .then(setReport)
      .catch(() => {
        // Панель говорит, что не смогла, а не показывает нули: ноль
        // расхода читается как «денег не тратили».
        setProblem('Не удалось посчитать расход');
      });
  }, [days]);

  if (problem !== undefined) {
    return (
      <p className="отказ" role="alert">
        {problem}
      </p>
    );
  }

  if (report === undefined) return <p className="разрез__пусто">Считаю…</p>;

  return (
    <div data-testid="costs">
      <div className="период">
        <span className="поле__имя">Период</span>
        {[7, 30, 90].map((option) => (
          <button
            key={option}
            type="button"
            className={option === days ? 'период__кнопка период__кнопка--выбран' : 'период__кнопка'}
            onClick={() => {
              setDays(option);
            }}
          >
            {option} дней
          </button>
        ))}
      </div>

      {!report.complete && (
        <p className="оговорка" role="note">
          У части вызовов цена неизвестна — модели нет в прайс-листе. Суммы ниже — нижняя граница, а
          не точный расход.
        </p>
      )}

      <section className="итоги">
        <div className="итог">
          <span className="итог__имя">Обращений к моделям</span>
          <span className="итог__число">{report.calls}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">Разобрано выгрузок</span>
          <span className="итог__число">{report.dumps}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">На выгрузку</span>
          <span className="итог__число">{money(report.perDump)}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">На человека</span>
          <span className="итог__число">{money(report.perUser)}</span>
        </div>
      </section>

      <Table title="По этапам" head="Этап" rows={report.byStage} />
      <Table title="По моделям" head="Модель" rows={report.byModel} />
      <Table
        title="По людям"
        head="Кто"
        rows={report.byUser.map((row) => ({ ...row, label: row.title }))}
      />

      {report.unattributed.length > 0 && (
        <p className="оговорка">
          Ещё {money(report.unattributed)} потрачено на тех, кто удалил свои данные. Их строки
          обезличены (§16), поэтому в разрез по людям они не попадают — и сумма по людям меньше
          общей на эту величину.
        </p>
      )}

      {report.userCount > report.byUser.length && (
        <p className="разрез__пусто">
          Показаны {report.byUser.length} из {report.userCount}.
        </p>
      )}
    </div>
  );
}
