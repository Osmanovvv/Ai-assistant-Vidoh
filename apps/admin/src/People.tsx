import { useEffect, useState } from 'react';

import {
  overview,
  peoplePage,
  personCard,
  type Funnel,
  type Money,
  type Overview,
  type PeoplePage,
  type PersonCard,
  type PersonRow,
  type Revenue,
} from './api.js';

/**
 * Обзор, список людей и карточка (§15 ТЗ, задача 4.6).
 *
 * **Карточка собрана вокруг вопроса, а не вокруг таблиц базы.** Условие
 * готовности задачи — «по жалобе „бот неправильно понял“ можно за минуту
 * найти выгрузку, версию промпта и результат», поэтому порядок такой:
 * что человек сказал → что из этого вышло → каким промптом → что потом
 * поправили. Ровно тем путём, которым 31.08.2026 пришлось идти через ssh
 * и SQL.
 *
 * **Обзор честно говорит, чего в нём нет.** Пустая колонка читается как
 * «ноль», то есть как факт, — поэтому вместо неё объяснение. Выручка и
 * переход в оплату появились с задачей 4.2. Настоящая причина оговорок
 * названа ревизией четвёртого этапа: моменты конца пробного периода
 * ведутся **с выкладки 4.4** и задним числом не досыпаются, поэтому
 * третий шаг воронки говорит только о людях, у которых пробный кончился
 * после неё. Прежде здесь стояло «переход не считается, пока неизвестен
 * размер пробного периода» — обещание, которого код не исполнял: размер
 * известен всегда, у него есть умолчание.
 *
 * **Выручка не сведена в одно число нарочно.** Рубли и звёзды — разные
 * деньги: курс звезды задаёт Telegram, он меняется, и «итого» пришлось
 * бы придумать. Плюс из звёзд Telegram берёт свою долю.
 */

const PAGE = 20;

/**
 * Сколько выгрузок карточка просит сначала и сколько может попросить.
 *
 * Двадцать — столько же, сколько сервер давал всегда, пока его параметр
 * был недостижим ниоткуда, кроме тестов. Пятьдесят — его потолок; больше
 * попросить нельзя, и панель об этом говорит словами, а не молча даёт
 * кнопку, которая ничего не меняет.
 */
const CARD_DUMPS = 20;
const CARD_DUMPS_MAX = 50;

/**
 * Пауза после нажатия клавиши, прежде чем спрашивать сервер.
 *
 * Прежде запрос уходил на **каждую** букву: набранное «Аня» давало три
 * обращения к персональному пути, то есть три строки в журнале доступа
 * §16 — а журнал заводили, чтобы он отвечал на вопрос «кто смотрел на
 * чьи данные», и по строке на нажатие клавиши он превращается в шум.
 * Плюс гонка: ответ на «Ан» мог прийти после ответа на «Аня» и подменить
 * список — на экране стояли люди, не подходящие к тому, что в поле.
 */
const TYPING_PAUSE = 350;

function money(list: readonly Money[]): string {
  if (list.length === 0) return '—';

  return list
    .map((one) => {
      const amount = (one.micros / 1_000_000).toFixed(2);
      return one.currency === 'usd' ? `$${amount}` : `${amount} ₽`;
    })
    .join(' + ');
}

/**
 * Оговорка «сумма — нижняя граница» — одними словами во всех местах.
 *
 * Обзор её печатал, а расход человека выдавался за факт: то же число, две
 * правды. Теперь она стоит и в списке, и в карточке — и текст обязан быть
 * общим, иначе читающий решит, что оговорки про разные числа.
 *
 * «У 1 вызова», а не «у 1 вызовов»: число со словом, не сходящимся с ним,
 * читается как след недоделанной панели, и человек перестаёт верить и
 * самому числу.
 */
function unpricedNote(calls: number): string {
  const one = calls % 10 === 1 && calls % 100 !== 11;

  return `не меньше: у ${String(calls)} ${one ? 'вызова' : 'вызовов'} цена неизвестна`;
}

/** Выручка суммами: «399.00 ₽» или «399.00 ₽ + 150 ⭐». */
function earned(list: readonly Revenue[]): string {
  if (list.length === 0) return '—';

  return list
    .map((one) =>
      one.currency === 'XTR' ? `${String(one.minor)} ⭐` : `${(one.minor / 100).toFixed(2)} ₽`,
    )
    .join(' + ');
}

/**
 * Сколько было платежей — отдельной строкой под суммой.
 *
 * Не украшение: одна оплата на три тысячи и тридцать по сотне — разные
 * новости, а сумма у них похожая. Но и не часть большого числа: «399.00 ₽
 * (1)» без подписи читается как непонятная приписка.
 */
function payments(list: readonly Revenue[]): string {
  const total = list.reduce((sum, one) => sum + one.payments, 0);

  if (total === 0) return 'платежей не было';

  const tail = total % 100;
  const last = total % 10;

  const word =
    tail >= 11 && tail <= 14
      ? 'платежей'
      : last === 1
        ? 'платёж'
        : last < 5
          ? 'платежа'
          : 'платежей';

  return `${String(total)} ${word}`;
}

/**
 * Переход из пробного в оплату — двумя числами, а не процентом.
 *
 * Процент от трёх человек выглядит как знание, знанием не являясь.
 * Поэтому «2 из 7», а доля пусть считается в голове того, кто смотрит.
 */
function conversionText(value: Funnel): string {
  return `${String(value.total.paidAfterTrial)} из ${String(value.total.trialOver)}`;
}

/** Подписка человека в одну строку — для списка. */
function subscriptionText(row: PersonRow): string {
  const subscription = row.subscription;

  if (subscription === undefined) return '—';

  const plan = subscription.plan === 'monthly' ? 'месяц' : 'год';
  const rail = subscription.rail === 'telegram:stars' ? 'звёзды' : 'карта';

  /**
   * «Кончилась» отличается от «не платил», и это разные строки.
   * Разбирающий жалобу обязан их различать: у первого доступ был.
   */
  if (!subscription.live) return `кончилась ${when(subscription.paidUntil)}`;

  const renew = subscription.autoRenew ? 'продлевается' : 'без продления';
  const trouble = subscription.status === 'past_due' ? ', продление не прошло' : '';

  return `${plan}, ${rail}, до ${when(subscription.paidUntil)} — ${renew}${trouble}`;
}

/**
 * Человеческие имена полей записи. Ключи из базы — не для глаз.
 *
 * Перечень изменяемых полей ведёт откат (`RESTORABLE_FIELDS` на
 * сервере) — здесь только имена, и список нарочно неполный по-другому:
 * ключ, которого в нём нет, печатается **как есть**. Это некрасиво, зато
 * новая колонка покажется в разборе жалобы сразу, а не после того, как
 * кто-то вспомнит про этот список. Молча спрятать правку было бы хуже
 * всего: карточка сказала бы «поля не менялись» про изменённое поле.
 */
const FIELD_NAMES: Record<string, string> = {
  text: 'текст',
  body: 'подробности',
  type: 'тип',
  priority: 'важность',
  topic: 'тема',
  topicId: 'тема (код)',
  status: 'статус',
  completedAt: 'выполнено',
  deadlineAt: 'срок',
  deadlineAccuracy: 'точность срока',
  isProject: 'проект',
  assignee: 'на кого',
  recurrenceRule: 'повтор (правило)',
  recurrenceText: 'повтор словами',
  recurrenceSource: 'повтор откуда',
};

/** Поля, где в снимке лежит дата: показываем датой, а не строкой ISO. */
const FIELD_DATES = new Set(['completedAt', 'deadlineAt']);

/**
 * Одна правка словами: «срок: 03.09.2026 → 04.09.2026».
 *
 * Пустое значение названо словом: пустая ячейка читается как «нет
 * данных», а здесь пусто — это и есть новость («срок сняли»).
 */
function fieldChange(one: {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
}): string {
  const name = FIELD_NAMES[one.field] ?? one.field;

  const shown = (value: string | null): string =>
    value === null ? '(пусто)' : FIELD_DATES.has(one.field) ? when(value) : value;

  return `${name}: ${shown(one.before)} → ${shown(one.after)}`;
}

/**
 * Только дата, без времени.
 *
 * Для «моменты ведутся с …» секунды не значат ничего: человек читает
 * это как «с седьмого сентября». А снимок экрана с секундами засева
 * краснел бы на каждом прогоне — то есть страж превратился бы в шум,
 * который перестают читать.
 */
function day(value: string | null): string {
  if (value === null) return '—';

  const at = new Date(value);

  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleDateString('ru-RU');
}

/** Дата в местном виде. Пусто — прочерк, а не «Invalid Date». */
function when(value: string | null): string {
  if (value === null) return '—';

  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString('ru-RU');
}

// ── Обзор ─────────────────────────────────────────────────────────────

export function OverviewPanel(): React.ReactElement {
  const [report, setReport] = useState<Overview | undefined>(undefined);
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    void overview(30)
      .then(setReport)
      .catch(() => {
        setProblem(true);
      });
  }, []);

  if (problem) {
    return (
      <p className="отказ" role="alert">
        Не удалось собрать обзор
      </p>
    );
  }

  if (report === undefined) return <p className="разрез__пусто">Считаю…</p>;

  return (
    <div data-testid="overview">
      <section className="итоги">
        <div className="итог">
          <span className="итог__имя">Всего людей за всё время</span>
          <span className="итог__число">{report.totalUsers}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">Новых за 30 дней</span>
          <span className="итог__число">{report.newUsers}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">Активных за 30 дней</span>
          <span className="итог__число">{report.activeUsers}</span>
        </div>
        <div className="итог">
          <span className="итог__имя">Выгрузок разобрано за 30 дней</span>
          <span className="итог__число">{report.dumps}</span>
        </div>
        {/*
          Число про сбои — правка ревизии панели.

          На обзоре не было ни одного, а разбор жалобы «бот молчит»
          начинают именно с него: панель открывается на обзоре. Пока
          оговорка про вызовы без цены загоралась и от отказов модели,
          страница говорила о поломке чужими словами и в неверном смысле;
          после её починки не говорила о поломке вовсе.

          Ноль здесь — факт, а не пустота, поэтому плитка стоит всегда.
          Из того же множества, что «разобрано»: `done` против `failed`.
        */}
        <div className="итог">
          <span className="итог__имя">Сорвалось выгрузок за 30 дней</span>
          <span className="итог__число" data-testid="failed-dumps">
            {report.failedDumps}
          </span>
          {report.failedDumps > 0 && (
            <span className="панель__кто" style={{ display: 'block', marginTop: 2 }}>
              что именно случилось — во вкладке «Ошибки»
            </span>
          )}
        </div>
        <div className="итог">
          <span className="итог__имя">Расход на модели за 30 дней</span>
          <span className="итог__число">{money(report.spend)}</span>
          {/*
            Оговорка про вызовы без цены — правка ревизии этапа.

            Модели нет в прайс-листе, цена не записана, и вызов молча
            выпадал из суммы: расход показывался как факт, хотя был
            нижней границей. Раздел расходов такую оговорку печатает,
            обзор молчал — и два числа про одно и то же расходились.

            Сорвавшиеся вызовы сюда не попадают: у отказа цены нет и быть
            не может, и оговорка, горящая после любого таймаута, не значит
            ничего. Про сбои говорит своя плитка выше.
          */}
          {report.unpricedCalls > 0 && (
            <span
              className="панель__кто"
              data-testid="unpriced"
              style={{ display: 'block', marginTop: 2 }}
            >
              {unpricedNote(report.unpricedCalls)}
            </span>
          )}
        </div>
        <div className="итог">
          <span className="итог__имя">Выручка за 30 дней</span>
          <span className="итог__число" data-testid="revenue">
            {earned(report.revenue)}
          </span>
          {/* Блоком, а не строкой: иначе «498.00 ₽2 платежа» слипается. */}
          <span
            className="панель__кто"
            data-testid="payments"
            style={{ display: 'block', marginTop: 2 }}
          >
            {payments(report.revenue)}
          </span>
        </div>
        {report.refunded.length > 0 && (
          <div className="итог">
            <span className="итог__имя">Возвращено за 30 дней</span>
            <span className="итог__число" data-testid="refunded">
              {earned(report.refunded)}
            </span>
            {/* Отдельной величиной, а не вычетом: «заработали и вернули»
                и «не заработали» — разные новости с одной суммой. */}
            <span className="панель__кто" style={{ display: 'block', marginTop: 2 }}>
              {payments(report.refunded)}
            </span>
          </div>
        )}
        <div className="итог">
          <span className="итог__имя">Платят сейчас (на эту минуту)</span>
          <span className="итог__число" data-testid="payers">
            {report.payers}
          </span>
        </div>
        <div className="итог">
          <span className="итог__имя">Из пробного в оплату за всё время</span>
          <span className="итог__число" data-testid="conversion">
            {conversionText(report.funnel)}
          </span>
        </div>
      </section>

      {/*
        Оговорки печатает **только** воронка — правка ревизии этапа.

        Прежде тот же список печатался и здесь: `overview` пробрасывает
        `funnel.missing` наверх, а `FunnelBlock` печатает его сам. Человек
        читал каждую оговорку дважды и решал, что это про разные числа.
      */}
      <FunnelBlock value={report.funnel} />
    </div>
  );
}

/**
 * Воронка и разрез по источникам (§15 и §14, задача 4.4).
 *
 * **Ни одного процента.** Четыре числа в ряд и знаменатель рядом:
 * процент от трёх человек выглядит как знание, знанием не являясь. На
 * боевом людей двое.
 *
 * **Источник без названия называется словом.** Пустая ячейка читается
 * как «нет данных», а человек-то есть: он пришёл по прямой ссылке.
 */
function FunnelBlock({ value }: { readonly value: Funnel }): React.ReactElement {
  const rows = [{ ...value.total, source: 'ВСЕ' }, ...value.bySource];

  return (
    <div className="разрез" data-testid="funnel">
      <h3 className="разрез__имя">Воронка по источникам</h3>

      <div className="таблица-обёртка">
        <table className="таблица">
          <thead>
            <tr>
              <th>Источник</th>
              <th className="таблица__число">Регистрация</th>
              <th className="таблица__число">Первая выгрузка</th>
              <th className="таблица__число">Конец пробного</th>
              {/*
                Две разные колонки вместо одной — правка ревизии этапа.

                «Ещё выбирает» прежде считалось как «момента нет, трата
                есть, не платил» — и в него попадали люди, которым бот
                уже отказывает: момент пишется с выкладки 4.4, а снижение
                предела из панели мгновенно переводит человека за
                границу. Заказчица читала «двадцать думают» там, где
                двадцать упёрлись в отказ.
              */}
              <th className="таблица__число">Ещё выбирает</th>
              <th className="таблица__число">Отказ без момента</th>
              <th className="таблица__число">Оплата</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.source ?? `прямой-${String(index)}`}>
                <td>
                  {index === 0 ? 'Все вместе' : (row.source ?? 'без источника (прямой заход)')}
                </td>
                <td className="таблица__число">{row.registered}</td>
                <td className="таблица__число">{row.firstDump}</td>
                <td className="таблица__число">{row.trialOver}</td>
                <td className="таблица__число">{row.trialStillRunning}</td>
                <td className="таблица__число" data-testid={`funnel-unrecorded-${String(index)}`}>
                  {row.trialOverUnrecorded}
                </td>
                <td className="таблица__число">{row.paidAfterTrial}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {value.momentsSince !== null && (
        <p className="панель__кто" data-testid="moments-since">
          Моменты конца пробного периода ведутся с {day(value.momentsSince)}
          {value.trialLimits.length > 0
            ? `; встреченные пределы: ${value.trialLimits.join(', ')}`
            : ''}
          .
        </p>
      )}

      {rows[0] !== undefined && rows[0].trialOverUnrecorded > 0 && (
        <p className="оговорка">
          «Отказ без момента» — люди, у которых пробные выгрузки кончились, а когда именно, сказать
          нечем: моменты ведутся с выкладки и задним числом не досыпаются, а снижение предела
          переводит человека за границу сразу. Бот им уже отказывает.
        </p>
      )}

      {value.missing.map((note) => (
        <p className="оговорка" key={note}>
          {note}
        </p>
      ))}
    </div>
  );
}

// ── Список и карточка ─────────────────────────────────────────────────

export function PeoplePanel(): React.ReactElement {
  const [page, setPage] = useState<PeoplePage | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState(false);

  /**
   * Один запрос на набранное слово, а не на каждую букву.
   *
   * **Задержка.** `/api/people` — персональный путь, и каждое обращение
   * пишет строку в журнал доступа §16 плюс дописывает в неё число
   * выданных людей. Набранное «Аня» давало три обращения, то есть три
   * записи о том, что кто-то смотрел на данные людей, — и журнал,
   * заведённый ради вопроса «кто смотрел на чьи данные», отвечал на него
   * шумом. Ждём паузы в наборе и спрашиваем один раз.
   *
   * **Отбрасывание устаревших ответов.** Порядок ответов сети не тот же,
   * что порядок запросов: ответ на «Ан» мог прийти после ответа на «Аня»
   * и подменить список. На экране стояли люди, не подходящие к тому, что
   * человек видит в поле, — и объяснить это было нечем. Признак `current`
   * гасится уборкой эффекта, то есть в тот же момент, когда ответ
   * перестал относиться к делу.
   *
   * Пауза — только при непустом поиске: страницы листаются кнопкой, и
   * ждать там нечего, а первое открытие списка задержки не заслуживает.
   */
  useEffect(() => {
    setProblem(false);

    let current = true;

    const timer = setTimeout(
      () => {
        void peoplePage({ limit: PAGE, offset, ...(query === '' ? {} : { query }) })
          .then((fresh) => {
            if (current) setPage(fresh);
          })
          .catch(() => {
            if (current) setProblem(true);
          });
      },
      query === '' ? 0 : TYPING_PAUSE,
    );

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [offset, query]);

  if (openId !== undefined) {
    return (
      <Card
        userId={openId}
        onBack={() => {
          setOpenId(undefined);
        }}
      />
    );
  }

  if (problem) {
    return (
      <p className="отказ" role="alert">
        Не удалось собрать список
      </p>
    );
  }

  return (
    <div data-testid="people">
      <div className="период">
        <input
          className="поле__ввод"
          style={{ maxWidth: 240 }}
          name="q"
          placeholder="Имя или @имя"
          value={query}
          onChange={(event) => {
            setOffset(0);
            setQuery(event.target.value);
          }}
        />
        {page !== undefined && (
          <span className="панель__кто">
            {offset + 1}–{Math.min(offset + PAGE, page.total)} из {page.total}
          </span>
        )}
      </div>

      {page === undefined ? (
        <p className="разрез__пусто">Считаю…</p>
      ) : page.rows.length === 0 ? (
        <p className="разрез__пусто">Никого не нашлось.</p>
      ) : (
        <div className="таблица-обёртка">
          <table className="таблица">
            <thead>
              <tr>
                <th>Кто</th>
                <th>Источник</th>
                <th>Зарегистрирован</th>
                <th>Был</th>
                {/*
                  Период назван у каждой колонки — правка ревизии этапа.

                  Рядом стояли числа за 30 дней и за всё время без
                  подписи, и разбирающий складывал одно с другим.
                */}
                {/*
                  «Разобрано», а не «выгрузок» — правка ревизии панели.

                  Число считается как `status = 'done'`, то есть это
                  разобранные, а не все. Подпись «Выгрузок за всё время»
                  обещала все, и у человека со сорвавшейся выгрузкой она
                  расходилась с карточкой, где список показывает и
                  сорвавшиеся.
                */}
                <th className="таблица__число">Разобрано за всё время</th>
                <th className="таблица__число">Пробных за всё время</th>
                <th>Подписка</th>
                <th className="таблица__число">Расход за всё время</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button
                      type="button"
                      className="кнопка кнопка--тихая"
                      style={{ width: 'auto', padding: 0, textAlign: 'left' }}
                      onClick={() => {
                        setOpenId(row.id);
                      }}
                    >
                      {row.title}
                    </button>
                    {row.blocked && <span className="панель__кто"> заблокировал бота</span>}
                  </td>
                  <td>{row.source ?? '—'}</td>
                  <td>{when(row.registeredAt)}</td>
                  <td>{when(row.lastActiveAt)}</td>
                  <td className="таблица__число">{row.dumps}</td>
                  <td className="таблица__число">{row.trialSpent}</td>
                  <td data-testid={`subscription-${row.id}`}>{subscriptionText(row)}</td>
                  {/*
                    Оговорка под расходом — правка ревизии панели.

                    Число вызовов без цены сервер считал и здесь, но оно
                    выбрасывалось по дороге: обзор печатал «расход не
                    меньше показанного», а строка человека выдавала сумму
                    за факт. Модель ушла в «latest» и выпала из
                    прайс-листа — и «10.00 ₽» неправда.
                  */}
                  <td className="таблица__число">
                    {money(row.spend)}
                    {row.unpricedCalls > 0 && (
                      <span
                        className="панель__кто"
                        data-testid={`unpriced-${row.id}`}
                        style={{ display: 'block', marginTop: 2 }}
                      >
                        {unpricedNote(row.unpricedCalls)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page !== undefined && page.total > PAGE && (
        <div className="период" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="период__кнопка"
            disabled={offset === 0}
            onClick={() => {
              setOffset(Math.max(0, offset - PAGE));
            }}
          >
            Назад
          </button>
          <button
            type="button"
            className="период__кнопка"
            disabled={offset + PAGE >= page.total}
            onClick={() => {
              setOffset(offset + PAGE);
            }}
          >
            Дальше
          </button>
        </div>
      )}
    </div>
  );
}

function Card({
  userId,
  onBack,
}: {
  readonly userId: string;
  readonly onBack: () => void;
}): React.ReactElement {
  const [card, setCard] = useState<PersonCard | undefined>(undefined);
  const [problem, setProblem] = useState(false);
  /**
   * Сколько выгрузок просить у сервера.
   *
   * Прежде параметр не передавался вовсе, и карточка была навсегда
   * обрезана двадцатью: у человека из тестовой группы с месячной
   * историей она перестала отвечать на жалобу про прошлое.
   */
  const [dumpLimit, setDumpLimit] = useState(CARD_DUMPS);

  useEffect(() => {
    void personCard(userId, dumpLimit)
      .then(setCard)
      .catch(() => {
        setProblem(true);
      });
  }, [userId, dumpLimit]);

  if (problem) {
    return (
      <div>
        <button type="button" className="период__кнопка" onClick={onBack}>
          Назад к списку
        </button>
        <p className="отказ" role="alert">
          Не удалось собрать карточку
        </p>
      </div>
    );
  }

  if (card === undefined) return <p className="разрез__пусто">Собираю…</p>;

  return (
    <div data-testid="card">
      <div className="период">
        <button type="button" className="период__кнопка" onClick={onBack}>
          Назад к списку
        </button>
        <span className="панель__кто">
          {card.person.title}
          {card.person.username === null ? '' : ` · @${card.person.username}`} ·{' '}
          {/*
            «Разобрано N из M» — правка ревизии панели.

            Прежде здесь стояло «выгрузок N», где N — только разобранные
            (`status = 'done'`), а список ниже показывает все, включая
            сорвавшиеся. У человека с двумя разобранными и одной
            сорвавшейся шапка говорила «выгрузок 2», ниже было три
            статьи, и оговорка «показаны последние N из M» не
            срабатывала: три из трёх. Разбирающий жалобу читал это как
            ошибку панели.

            Числа берутся парой из одного места, поэтому разойтись им
            больше нечем.
          */}
          разобрано {card.person.dumps} из {card.dumpsTotal} · расход {money(card.person.spend)}
          {card.person.unpricedCalls > 0 ? ` (${unpricedNote(card.person.unpricedCalls)})` : ''} ·
          подписка {subscriptionText(card.person)} ·{' '}
          {/*
            Телеграмный номер — правка ревизии панели.

            Он приезжал в панель в каждой строке списка и в карточке и не
            рисовался нигде: персональные данные ездили в браузер без
            надобности, а у человека без телеграмного имени связаться с
            ним или сверить, что это тот самый из жалобы, было нечем.

            Показан в карточке, а не в списке: карточка открывается на
            **одного** человека нарочно, и журнал доступа §16 пишет, на
            кого смотрели, — у показа есть и причина, и след. Ссылка —
            попытка довести жалобу до человека: клиент Telegram открывает
            по номеру переписку, если этого человека знает. Само число
            напечатано рядом и годится всегда: по нему человек находится
            и в журнале, и в «Ошибках».

            Поле всё ещё приезжает и в строках списка: строку списка и
            карточку собирает один и тот же код, и два разных вида одной
            строки разошлись бы. Это осталось.
          */}
          <a href={`tg://user?id=${String(card.person.tgId)}`} data-testid="tg-id">
            id {card.person.tgId}
          </a>
        </span>
      </div>

      {/*
        Сказанное вне выгрузок — правка ревизии четвёртого этапа.

        Сообщение, пришедшее после отказа гейта, сохраняется и не
        попадает ни в выгрузку, ни в записи. Прежде его не видел никто:
        человек, которому реплика обещала «всё сказанное на месте», шёл
        проверять и не находил своих слов, а разбирающий жалобу не мог
        даже подтвердить, что слова дошли.
      */}
      {card.orphans.length > 0 && (
        <section className="разрез" data-testid="orphans">
          <h2 className="разрез__имя">
            Сказано вне выгрузок
            {card.orphansTotal > card.orphans.length
              ? ` — показаны последние ${String(card.orphans.length)} из ${String(card.orphansTotal)}`
              : ''}
          </h2>

          <p className="оговорка">
            Эти сообщения сохранены, но разбора у них нет: так бывает после отказа гейта — пробные
            разборы кончились, а слова человек всё равно сказал.
          </p>

          <div className="таблица-обёртка">
            <table className="таблица">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Что сказано</th>
                </tr>
              </thead>
              <tbody>
                {card.orphans.map((one) => (
                  <tr key={one.id}>
                    <td>{when(one.at)}</td>
                    <td className="панель__кто">
                      {one.text ?? (one.kind === 'voice' ? '(голосовое, не расшифровано)' : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="разрез">
        {/*
          Сколько выгрузок всего — правка ревизии четвёртого этапа.

          Список обрезан двадцатью, и прежде об этом не было сказано
          ничего: разбирающий жалобу читал его как полный — «сказала три
          раза за месяц» вместо «двадцать первый раз не показан».
        */}
        <h2 className="разрез__имя">
          Выгрузки
          {card.dumpsTotal > card.dumps.length
            ? ` — показаны последние ${String(card.dumps.length)} из ${String(card.dumpsTotal)}`
            : ''}
        </h2>

        {/*
          Кнопка вместо признания — правка ревизии панели.

          Здесь стояло «более старые выгрузки из панели пока не открыть»:
          правда, но правда о том, что параметр глубины не передавался с
          пути, хотя сервер умеет отдать до пятидесяти. Теперь его можно
          попросить, и оговорка осталась только там, где она всё ещё
          верна — за потолком сервера.
        */}
        {card.dumpsTotal > card.dumps.length &&
          (dumpLimit < CARD_DUMPS_MAX ? (
            <button
              type="button"
              className="период__кнопка"
              data-testid="more-dumps"
              onClick={() => {
                setDumpLimit(CARD_DUMPS_MAX);
              }}
            >
              Показать ещё (до {CARD_DUMPS_MAX})
            </button>
          ) : (
            <p className="оговорка">
              Больше {CARD_DUMPS_MAX} выгрузок панель за раз не открывает. Если нужны более старые —
              они в базе, по коду человека.
            </p>
          ))}

        {card.dumps.length === 0 ? (
          <p className="разрез__пусто">Выгрузок пока не было.</p>
        ) : (
          card.dumps.map((dump) => (
            <article className="выгрузка" key={dump.id}>
              <header className="выгрузка__шапка">
                <span>{when(dump.openedAt)}</span>
                <span className="панель__кто">
                  {dump.status}
                  {dump.trialCounted ? ' · пробная' : ''}
                  {dump.prompts.length === 0
                    ? ''
                    : ` · ${dump.prompts
                        .map((one) => `${one.stage}: ${one.version ?? 'без версии'}`)
                        .join(', ')}`}
                </span>
              </header>

              {/* Что человек сказал — первым, до всякого разбора. */}
              {/*
                «Текста нет» больше не утверждается как факт (ревизия
                этапа). Склейка пишется в начале разбора: у выгрузки,
                сорвавшейся до него, поле пусто — а сообщения человека на
                месте, они сохраняются до всякого разбора. Теперь сервер
                поднимает их сам, и пустота осталась только там, где
                сообщений действительно нет.
              */}
              <p className="выгрузка__слова">
                {dump.said === null || dump.said === ''
                  ? '(сообщений в этой выгрузке нет)'
                  : dump.said}
              </p>

              {dump.error !== null && <p className="оговорка">Сбой разбора: {dump.error}</p>}

              {dump.results.length === 0 ? (
                <p className="разрез__пусто">Записей из неё не вышло.</p>
              ) : (
                <ul className="выгрузка__итог">
                  {dump.results.map((item) => (
                    <li key={item.id}>
                      {item.text}
                      <span className="панель__кто">
                        {item.isDraft
                          ? ` — черновик: ${item.draftReason ?? 'без причины'}`
                          : ` — ${item.type}${item.topic === null ? '' : `, ${item.topic}`}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))
        )}
      </section>

      <section className="разрез">
        {/*
          «Что изменилось» — правка ревизии панели.

          §15 просит у карточки применённые изменения «для разбора жалоб
          на качество», а §19 ставит первым риском «резолвер портит
          записи». Таблица давала четыре колонки — когда, запись, кто,
          почему — и ни одной про содержание правки, хотя снимки «до» и
          «после» лежат в базе целиком с третьего этапа. Жалобу «бот
          поставил не ту дату» из такой таблицы разобрать было нельзя:
          видно, что правка была, и фразу модели, а «с четверга на
          пятницу» — нет. Именно за этим 31.08.2026 ходили в боевую базу
          через ssh.

          Заголовок называет предел: список обрезан сотней, и прежде об
          этом не было сказано ничего — свежий хвост читался как полная
          история, и вывод из него был «правок не было».
        */}
        <h2 className="разрез__имя">
          Применённые изменения
          {card.changesTotal > card.changes.length
            ? ` — показаны последние ${String(card.changes.length)} из ${String(card.changesTotal)}`
            : ''}
        </h2>

        {card.changes.length === 0 ? (
          <p className="разрез__пусто">Изменений не было.</p>
        ) : (
          <div className="таблица-обёртка">
            <table className="таблица">
              <thead>
                <tr>
                  <th>Когда</th>
                  {/*
                    «Запись сейчас», а не «Запись»: текст приходит через
                    связь с записью, то есть сегодняшний. У трёх правок
                    одного текста здесь встанет одна и та же строка, и
                    прежняя подпись выдавала её за текст на момент правки.
                  */}
                  <th>Запись сейчас</th>
                  <th>Что изменилось</th>
                  <th>Слова человека</th>
                  <th>Кто</th>
                  <th>Почему</th>
                </tr>
              </thead>
              <tbody>
                {card.changes.map((change) => (
                  <tr key={change.id}>
                    <td>{when(change.at)}</td>
                    <td>{change.itemText ?? '(запись удалена)'}</td>
                    <td>
                      {change.changed.length === 0 ? (
                        '(поля записи не менялись)'
                      ) : (
                        <ul className="выгрузка__итог">
                          {change.changed.map((one) => (
                            <li key={one.field}>{fieldChange(one)}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    {/* Слова человека, а не фраза модели: `Почему` — это
                        решение резолвера его же словами, и жалобу «почему
                        бот так решил» им не разобрать. */}
                    <td className="панель__кто">{change.said ?? '—'}</td>
                    <td>{change.changedBy}</td>
                    <td>
                      {change.reason ?? '—'}
                      {change.reverted ? ' (откачено)' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="разрез">
        {/* Предел назван и здесь: сотня вопросов — не «все вопросы». */}
        <h2 className="разрез__имя">
          Заданные вопросы
          {card.questionsTotal > card.questions.length
            ? ` — показаны последние ${String(card.questions.length)} из ${String(card.questionsTotal)}`
            : ''}
        </h2>

        {card.questions.length === 0 ? (
          <p className="разрез__пусто">Вопросов не задавалось.</p>
        ) : (
          <div className="таблица-обёртка">
            <table className="таблица">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>О чём спросили</th>
                  <th>Чем кончилось</th>
                </tr>
              </thead>
              <tbody>
                {card.questions.map((question) => (
                  <tr key={question.id}>
                    <td>{when(question.at)}</td>
                    <td>{question.segment}</td>
                    <td>{question.outcome ?? 'открыт'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
