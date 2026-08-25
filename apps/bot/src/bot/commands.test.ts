import { describe, expect, it } from 'vitest';

import { BOT_COMMANDS } from './commands.js';

/**
 * §16 ТЗ: право выгрузить и удалить свои данные должно быть доступно.
 * Команда, которой нет в меню, доступна только тому, кто знает её
 * название наизусть — а это не доступность.
 */

describe('меню команд', () => {
  it('содержит выгрузку и удаление данных (§16 ТЗ)', () => {
    const names = BOT_COMMANDS.map((command) => command.command);

    expect(names).toContain('export_my_data');
    expect(names).toContain('delete_my_data');
  });

  it('соблюдает ограничения Telegram на имена', () => {
    // Только строчные латинские буквы, цифры и подчёркивание, до 32 знаков.
    for (const { command } of BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/u);
    }
  });

  it('у каждой команды есть внятное описание', () => {
    for (const { description } of BOT_COMMANDS) {
      expect(description.trim().length).toBeGreaterThan(3);
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });

  it('не содержит повторов', () => {
    const names = BOT_COMMANDS.map((command) => command.command);

    expect(new Set(names).size).toBe(names.length);
  });
});
