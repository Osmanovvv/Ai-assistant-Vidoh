import { useCallback, useEffect, useState } from 'react';

import { signOut, whoAmI } from './api.js';
import { BroadcastPanel } from './Broadcast.js';
import { ErrorsPanel } from './Errors.js';
import { Costs } from './Costs.js';
import { OverviewPanel, PeoplePanel } from './People.js';
import { PromptsPanel } from './Prompts.js';
import { SettingsPanel } from './Settings.js';
import { SignIn } from './SignIn.js';

/**
 * Панель (§15 ТЗ, задачи 4.5–4.10).
 *
 * Все восемь разделов §15 на месте: обзор, люди, карточка, расходы,
 * промпты, настройки, рассылка, ошибки. Показывается ровно то, что уже
 * правда, — и ни строчки обещаний вроде пустых вкладок «Скоро»: пустая
 * вкладка учит, что панели верить нельзя.
 *
 * **Кто вошёл, спрашивается у бота, а не хранится у панели.** Пропуск
 * живёт в печенье, недоступном скриптам (`HttpOnly`), и панель о нём
 * ничего не знает — она знает только ответ на «пустят ли меня». Так
 * истёкший пропуск сам возвращает окно входа, без своих таймеров.
 */

type State =
  | { readonly kind: 'checking' }
  | { readonly kind: 'out' }
  | { readonly kind: 'in'; readonly login: string };

/**
 * Разделы панели.
 *
 * §15 просит восемь, и восемь есть — карточка человека живёт внутри
 * «Пользователей», куда её и открывают. Пустых вкладок «Скоро» здесь
 * нет и не было: пустая вкладка учит, что панели верить нельзя.
 */
const TABS = [
  { key: 'overview', title: 'Обзор' },
  { key: 'people', title: 'Пользователи' },
  { key: 'costs', title: 'Расходы' },
  { key: 'prompts', title: 'Промпты' },
  { key: 'broadcast', title: 'Рассылка' },
  { key: 'errors', title: 'Ошибки' },
  { key: 'settings', title: 'Настройки' },
] as const;

type Tab = (typeof TABS)[number]['key'];

export function App(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [tab, setTab] = useState<Tab>('overview');

  const check = useCallback(() => {
    void whoAmI()
      .then((who) => {
        setState({ kind: 'in', login: who.login });
      })
      .catch(() => {
        setState({ kind: 'out' });
      });
  }, []);

  useEffect(check, [check]);

  if (state.kind === 'checking') return <div className="вход" />;
  if (state.kind === 'out') return <SignIn onSignedIn={check} />;

  return (
    <div className="панель">
      <header className="панель__шапка">
        <h1 className="панель__имя">ВЫДОХ — панель</h1>
        <span className="панель__кто">
          {state.login}
          {' · '}
          <button
            className="кнопка кнопка--тихая"
            type="button"
            style={{ display: 'inline', width: 'auto', padding: 0 }}
            onClick={() => {
              void signOut().finally(() => {
                setState({ kind: 'out' });
              });
            }}
          >
            выйти
          </button>
        </span>
      </header>

      <nav className="вкладки">
        {TABS.map((one) => (
          <button
            key={one.key}
            type="button"
            className={one.key === tab ? 'вкладка вкладка--выбрана' : 'вкладка'}
            onClick={() => {
              setTab(one.key);
            }}
          >
            {one.title}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <OverviewPanel />}
      {tab === 'people' && <PeoplePanel />}
      {tab === 'costs' && <Costs />}
      {tab === 'prompts' && <PromptsPanel />}
      {tab === 'broadcast' && <BroadcastPanel />}
      {tab === 'errors' && <ErrorsPanel />}
      {tab === 'settings' && <SettingsPanel />}
    </div>
  );
}
