import { useCallback, useEffect, useState } from 'react';

import { signOut, whoAmI } from './api.js';
import { Costs } from './Costs.js';
import { SignIn } from './SignIn.js';

/**
 * Панель (§15 ТЗ, задача 4.5).
 *
 * Пока здесь вход и расходы: остальные разделы §15 приезжают задачами
 * 4.6 и 4.8–4.10. Показывается ровно то, что уже правда, — и ни строчки
 * обещаний вроде пустых вкладок «Скоро»: пустая вкладка учит, что
 * панели верить нельзя.
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

export function App(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'checking' });

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

      <Costs />
    </div>
  );
}
