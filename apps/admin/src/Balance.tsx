import { useEffect, useState } from 'react';

import { yandexBalance, type YandexBalance } from './api.js';

/**
 * Плитка баланса Yandex Cloud (проджект, 21.09.2026: «сколько на балансе
 * щас»).
 *
 * Стоит в «Обзоре» (блок «Расходы») и в «Расходах»: рядом с тем, сколько
 * потратили, — сколько осталось. Три состояния словами, а не пустотой:
 * «не настроено» (ключа нет), «не ответило» (облако), и число — с
 * пометкой «устарело», если последний ответ был раньше, чем спросили
 * сейчас. Ниже порога плитка красная: порог правится в «Настройках».
 */

function rubles(value: number): string {
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/** «5 мин назад», «2 ч назад» — по часам браузера. */
function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${String(minutes)} мин назад`;
  const hours = Math.round(minutes / 60);
  return `${String(hours)} ч назад`;
}

export function BalanceTile(): React.ReactElement {
  const [state, setState] = useState<YandexBalance | 'считаю' | 'отказ'>('считаю');

  useEffect(() => {
    let alive = true;

    void yandexBalance()
      .then((fresh) => {
        if (alive) setState(fresh);
      })
      .catch(() => {
        if (alive) setState('отказ');
      });

    return () => {
      alive = false;
    };
  }, []);

  const name = <span className="итог__имя">Баланс Yandex Cloud</span>;

  if (state === 'считаю') {
    return (
      <div className="итог" data-testid="yandex-balance">
        {name}
        <span className="итог__число">…</span>
      </div>
    );
  }

  if (state === 'отказ') {
    return (
      <div className="итог" data-testid="yandex-balance">
        {name}
        <span className="итог__число">—</span>
        <span className="панель__кто" style={{ display: 'block', marginTop: 2 }}>
          не удалось спросить
        </span>
      </div>
    );
  }

  if (!state.configured) {
    return (
      <div className="итог" data-testid="yandex-balance">
        {name}
        <span className="итог__число">—</span>
        <span className="панель__кто" style={{ display: 'block', marginTop: 2 }}>
          не настроено: нужен файл ключа сервисного аккаунта на сервере
        </span>
      </div>
    );
  }

  if (!state.ok) {
    return (
      <div className="итог" data-testid="yandex-balance">
        {name}
        <span className="итог__число">—</span>
        <span className="панель__кто" style={{ display: 'block', marginTop: 2 }}>
          облако не ответило: {state.why}
        </span>
      </div>
    );
  }

  const threshold =
    state.thresholdRub > 0 ? `порог ${rubles(state.thresholdRub)}` : 'порог выключен';
  const when = `обновлено ${ago(state.fetchedAt, new Date())}`;

  return (
    <div
      className={state.low ? 'итог итог--тревога' : 'итог'}
      data-testid="yandex-balance"
      data-low={state.low ? 'true' : 'false'}
    >
      {name}
      <span className="итог__число">{rubles(state.balanceRub)}</span>
      <span className="панель__кто" style={{ display: 'block', marginTop: 2 }}>
        {state.low ? 'ниже порога — пора пополнить · ' : ''}
        {threshold} · {when}
        {state.stale ? ` · устарело: ${state.why ?? 'облако не ответило'}` : ''}
      </span>
    </div>
  );
}
