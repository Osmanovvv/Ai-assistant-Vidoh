import { describe, expect, it } from 'vitest';

import { safePayload } from './payload.js';

/**
 * §16 в столбце, у которого нет читателей.
 *
 * Схема обещала вымарывание, код писал тело целиком. Проверки ниже
 * держат именно **разрешительность** списка: запретительный список
 * прошёл бы их все, кроме одной — той, где поле незнакомое.
 */
describe('вымарывание тела события оплаты (§16)', () => {
  it('почта плательщика Робокассы не сохраняется', () => {
    const kept = safePayload({
      OutSum: '399.00',
      InvId: '1042',
      EMail: 'anya@example.com',
      Fee: '0.00',
      SignatureValue: 'ABC123',
      PaymentMethod: 'BankCard',
      Shp_ref: 'r-42',
      Shp_kind: 'initial',
    });

    expect(JSON.stringify(kept)).not.toContain('anya@example.com');
    expect(kept['EMail']).toBeUndefined();

    // А деньги и метка — на месте: по ним разбирают спор.
    expect(kept['OutSum']).toBe('399.00');
    expect(kept['InvId']).toBe('1042');
    expect(kept['Shp_ref']).toBe('r-42');
    expect(kept['PaymentMethod']).toBe('BankCard');
  });

  it('имя и ник человека из апдейта звёзд не сохраняются', () => {
    const kept = safePayload({
      message: {
        message_id: 7,
        date: 1_760_000_000,
        from: { id: 4_001, first_name: 'Аня', username: 'anya_v', is_bot: false },
        chat: { id: 4_001, first_name: 'Аня', type: 'private' },
        successful_payment: {
          currency: 'XTR',
          total_amount: 150,
          invoice_payload: 's-42',
          telegram_payment_charge_id: 'charge-первый',
          is_recurring: true,
        },
      },
    });

    const written = JSON.stringify(kept);

    expect(written).not.toContain('Аня');
    expect(written).not.toContain('anya_v');
    expect(written).not.toContain('4001');

    const message = kept['message'] as Record<string, unknown>;
    const paid = message['successful_payment'] as Record<string, unknown>;

    expect(paid['total_amount']).toBe(150);
    expect(paid['invoice_payload']).toBe('s-42');
    expect(paid['telegram_payment_charge_id']).toBe('charge-первый');
    expect(message['from']).toBeUndefined();
    expect(message['chat']).toBeUndefined();
  });

  it('сведения о плательщике из order_info не сохраняются', () => {
    // Telegram отдаёт их в `order_info`, если счёт их просил. Наши счета
    // не просят, но список обязан держать и этот случай: просьба
    // добавляется одной строкой в другом файле.
    const kept = safePayload({
      message: {
        successful_payment: {
          total_amount: 150,
          invoice_payload: 's-42',
          telegram_payment_charge_id: 'charge',
          order_info: {
            name: 'Анна Иванова',
            phone_number: '+79990000000',
            email: 'anya@example.com',
          },
        },
      },
    });

    const written = JSON.stringify(kept);

    expect(written).not.toContain('Анна');
    expect(written).not.toContain('79990000000');
    expect(written).not.toContain('anya@example.com');
  });

  it('незнакомое поле выпадает — список разрешительный, а не запретительный', () => {
    /**
     * **Главная из проверок.** Запретительный список пропустил бы поле,
     * которого мы ещё не видели, вместе с чем угодно внутри. Именно так
     * личное и просачивается: провайдер добавляет поле, а мы узнаём об
     * этом через год.
     */
    const kept = safePayload({
      OutSum: '399.00',
      PayerFullName: 'Анна Иванова',
      NewFieldFromNextYear: { email: 'anya@example.com' },
    });

    const written = JSON.stringify(kept);

    expect(written).not.toContain('Анна');
    expect(written).not.toContain('anya@example.com');
  });

  it('имена выпавших полей записываются — иначе пропажу нечем объяснить', () => {
    const kept = safePayload({ OutSum: '399.00', EMail: 'anya@example.com', Rcp: 'что-то' });

    expect(kept['вымарано']).toEqual(['EMail', 'Rcp']);
  });

  it('имена собираются и из вложенных тел, без повторов', () => {
    // Внутрь выпавшего поля не заходим вовсе — там и лежит личное,
    // поэтому в списке стоит `from`, а не `from.first_name`.
    const kept = safePayload({
      message: { from: { first_name: 'Аня' }, chat: { id: 1 }, successful_payment: { from: {} } },
    });

    expect(kept['вымарано']).toEqual(['chat', 'from']);
  });

  it('тело без личного остаётся как есть, без лишней пометки', () => {
    const kept = safePayload({ OutSum: '399.00', InvId: '7' });

    expect(kept).toEqual({ OutSum: '399.00', InvId: '7' });
  });

  it('не объект тоже записывается: столбец not null, а «не разобралось» — сведение', () => {
    expect(safePayload(undefined)).toEqual({ значение: undefined });
    expect(safePayload('строка')).toEqual({ значение: 'строка' });
  });

  it('кольцевая ссылка не вешает вымарывание', () => {
    const loop: Record<string, unknown> = { OutSum: '1.00' };
    loop['message'] = loop;

    expect(() => safePayload(loop)).not.toThrow();
    expect(JSON.stringify(safePayload(loop))).toContain('1.00');
  });
});
