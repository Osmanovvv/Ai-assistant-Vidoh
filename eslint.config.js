import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.data/**', 'docs/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // §4.1 ТЗ: никаких any в доменных типах — запрет явный, а не по умолчанию.
      '@typescript-eslint/no-explicit-any': 'error',

      // Забытый await в конвейере обработки означает потерянное сообщение,
      // а §9 ТЗ этого не допускает.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],

      // Неиспользуемое с префиксом _ разрешено: так помечают намеренно
      // проигнорированные аргументы обработчиков.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'object-shorthand': 'error',
      'prefer-const': 'error',
    },
  },

  {
    // Инвариант 4 и §12.3 ТЗ: ни одной реплики бота в коде. Условие
    // готовности задачи 2.11 требует проверять это линтером, а не глазами.
    //
    // Проверяются места, через которые текст попадает человеку: методы
    // отправки Telegram и подписи кнопок. Это точнее, чем запрет строк с
    // кириллицей вообще: сообщения в журнал и тексты исключений тоже
    // по-русски, и такой запрет дал бы десятки ложных срабатываний, а
    // правило, которое врёт, отключают целиком.
    files: ['apps/bot/src/**/*.ts'],
    ignores: ['apps/bot/src/texts/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.property.name=/^(reply|replyWithDocument|sendMessage|sendDocument|editMessageText|answerCallbackQuery)$/] > :matches(Literal[value.length>0], TemplateLiteral)',
          message:
            'Реплика человеку — только из словаря текстов (инвариант 4, §12.3 ТЗ). Добавь строку в apps/bot/src/texts и возьми её через textsFor.',
        },
        {
          selector: 'CallExpression[callee.property.name=/^(text|url)$/] > Literal:nth-child(1)',
          message:
            'Подпись кнопки — только из словаря текстов (инвариант 4, §12.3 ТЗ). Идентификатор в callback_data остаётся строкой в коде, подпись — нет.',
        },
      ],
    },
  },

  {
    // Конфигурационные файлы на JavaScript вне типизированного проекта.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    // В тестах допустимы конструкции, неуместные в рабочем коде.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
