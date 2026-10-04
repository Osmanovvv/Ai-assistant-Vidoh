import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Обещания оферты доезжают до боевой сборки (письмо Робокассы от
 * 11.09.2026: «автопродление без уведомления», «изменение цены без
 * предупреждения» — избегайте).
 *
 * Обе связки — необязательные аргументы: `startRenewals` без
 * `onPriceChange` сверяет цену молча, а `startRenewalNotices` можно
 * просто не вызвать. Проверки служб зелёные и так — уведомитель в них
 * подставной. Значит забытую строку в `src/index.ts` не заметит никто,
 * кроме подписчика, которому спишут без предупреждения. Тот же приём,
 * что у реестра настроек: по исходнику, а не подъёмом.
 */
const index = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../index.ts'),
  'utf8',
);

/** Вызов без комментариев: закомментированная строка — не связка. */
function callOf(name: string): string {
  const at = index.indexOf(`${name}(`);
  expect(at, `${name} в src/index.ts не вызывается`).toBeGreaterThan(-1);

  return index
    .slice(at, index.indexOf(');', at))
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/\/\/.*$/gmu, '');
}

describe('уведомления по оферте п. 7.4 и 7.8 подключены в боевой сборке', () => {
  it('предупреждение о списании — своим проходом, с уведомителем', () => {
    const call = callOf('startRenewalNotices');

    expect(call).toContain('renewalAhead');
  });

  it('новая цена — подписчикам через проход продлений', () => {
    const call = callOf('startRenewals');

    expect(call).toContain('onPriceChange');
    expect(call).toContain('priceChange');
  });

  it('проход предупреждений останавливается вместе с остальными', () => {
    expect(index).toContain('Promise.resolve(stopRenewalNotices()),');
    expect(index).toContain('Promise.allSettled(stopping)');
  });
});
