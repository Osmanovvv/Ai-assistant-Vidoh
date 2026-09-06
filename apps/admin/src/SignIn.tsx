import { useState, type SyntheticEvent } from 'react';

import { signInWithCode, signInWithPassword } from './api.js';

/**
 * Вход в два шага (§15 ТЗ, задача 4.5).
 *
 * **Отказ всегда один и тот же — «Не получилось войти».** Ни «нет
 * такого логина», ни «неверный пароль», ни «код просрочен». Сервер
 * отвечает одинаково нарочно (см. `auth.ts`), и панель не должна
 * додумывать различия за него: подсказка подбирающему одинаково вредна
 * с обеих сторон.
 *
 * **Второй шаг — отдельный экран, а не второе поле рядом.** §15 просит
 * «вход в два шага», и два шага должны быть видны человеку: код
 * набирается после пароля, когда приложение-аутентификатор уже открыто.
 * Одно окно с тремя полями — это один шаг, как его ни назови.
 *
 * **Кнопка «Начать заново»** нужна на втором шаге: приложение с кодом
 * может оказаться на другом телефоне, а тупик без выхода — худшее, что
 * можно сделать с окном входа.
 */

type Step = 'password' | 'code';

const REFUSED = 'Не получилось войти';

export function SignIn({ onSignedIn }: { readonly onSignedIn: () => void }): React.ReactElement {
  const [step, setStep] = useState<Step>('password');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submitPassword = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);

    void signInWithPassword(login, password)
      .then(() => {
        setStep('code');
        setPassword('');
      })
      .catch(() => {
        setProblem(REFUSED);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const submitCode = (event: SyntheticEvent): void => {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);

    void signInWithCode(code)
      .then(() => {
        onSignedIn();
      })
      .catch(() => {
        setProblem(REFUSED);
        setCode('');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="вход">
      <div className="вход__карточка">
        <h1 className="вход__имя">ВЫДОХ</h1>
        <p className="вход__подпись">
          {step === 'password' ? 'Панель управления' : 'Код из приложения'}
        </p>

        {problem !== undefined && (
          <p className="отказ" role="alert">
            {problem}
          </p>
        )}

        {step === 'password' ? (
          <form onSubmit={submitPassword}>
            <label className="поле">
              <span className="поле__имя">Логин</span>
              <input
                className="поле__ввод"
                name="login"
                autoComplete="username"
                autoFocus
                value={login}
                onChange={(event) => {
                  setLogin(event.target.value);
                }}
              />
            </label>

            <label className="поле">
              <span className="поле__имя">Пароль</span>
              <input
                className="поле__ввод"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </label>

            <button className="кнопка" type="submit" disabled={busy}>
              {busy ? 'Проверяю…' : 'Дальше'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <label className="поле">
              <span className="поле__имя">Шесть цифр</span>
              <input
                className="поле__ввод поле__ввод--код"
                name="code"
                // Не `type="number"`: он теряет ведущий ноль и рисует
                // стрелочки, а код — это шесть знаков, а не величина.
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/gu, ''));
                }}
              />
            </label>

            <button className="кнопка" type="submit" disabled={busy || code.length !== 6}>
              {busy ? 'Проверяю…' : 'Войти'}
            </button>

            <button
              className="кнопка кнопка--тихая"
              type="button"
              onClick={() => {
                setStep('password');
                setCode('');
                setProblem(undefined);
              }}
            >
              Начать заново
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
