import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BOT_COMMANDS } from './commands.js';

const here = dirname(fileURLToPath(import.meta.url));

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

  it('содержит команды платёжной платформы Telegram (§14)', () => {
    /**
     * Отвечать на `/paysupport` бот, продающий цифровые услуги, обязан.
     * Но команда, которой нет в меню, доступна только знающему её
     * наизусть, а человек, у которого списались деньги, ищет способ
     * спросить в меню.
     */
    const names = BOT_COMMANDS.map((command) => command.command);

    expect(names).toContain('paysupport');
    expect(names).toContain('terms');
  });

  it('каждая команда меню действительно обрабатывается ботом', () => {
    /**
     * Пункт меню, за которым нет обработчика, — обещание без
     * исполнения: человек нажимает и получает тишину. Проверяется по
     * исходникам обработчиков, потому что собрать бота в юнит-проверке
     * значило бы поднять базу, Redis и Telegram.
     *
     * Тот же класс отказа, что «написано, покрыто тестами и
     * недостижимо», только с другой стороны.
     */
    const sources = readdirSync(resolve(here, 'handlers'))
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
      .map((name) => readFileSync(resolve(here, 'handlers', name), 'utf8'))
      .join(String.fromCharCode(10));

    /**
     * Поиск по кавычкам, а не регуляркой.
     *
     * Имя команды в коде всегда взято в кавычки — и когда оно одно
     * (`bot.command('menu', …)`), и когда их список
     * (`bot.command(['terms', 'support'], …)`). Регулярка со скобками
     * тут уже однажды разошлась с обоими случаями и объявила
     * несуществующую пропажу.
     */
    const nameless = BOT_COMMANDS.map((one) => one.command).filter(
      (command) => !sources.includes(`'${command}'`),
    );

    expect(nameless, `в меню есть, а обработчика нет: ${nameless.join(', ')}`).toEqual([]);
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
