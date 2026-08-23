/**
 * Словарь реплик бота (§12.3 ТЗ: тексты не хардкодятся по коду).
 *
 * Род бота женский — решение §13 ТЗ. Формы, зависящие от рода
 * пользователя, не используются: иначе пришлось бы спрашивать пол на
 * онбординге, а §13.1 запрещает любые вопросы до первой выгрузки.
 *
 * §13.8 ТЗ: тон вынесен в профиль. Во второй версии заказчик рассматривает
 * более тёплый вариант, и он должен добавляться сюда, а не в ядро разбора.
 */

export interface TextProfile {
  readonly start: {
    readonly greeting: string;
    readonly consentNotice: (policyUrl: string) => string;
    readonly buttonVoice: string;
    readonly buttonText: string;
    readonly hintVoice: string;
    readonly hintText: string;
  };
  readonly listening: {
    readonly acknowledged: string;
  };
  readonly limits: {
    readonly tooManyDumps: string;
  };
  readonly privacy: {
    readonly deleteFirstStep: string;
    readonly deleteSecondStep: string;
    readonly deleteConfirmButton: string;
    readonly deleteFinalButton: string;
    readonly deleteCancelButton: string;
    readonly deleteDone: string;
    readonly deleteCancelled: string;
    readonly nothingToDelete: string;
    readonly nothingToExport: string;
    readonly exportReady: string;
  };
  readonly errors: {
    readonly generic: string;
  };
}

/** Сдержанный профиль. В первой версии единственный и включён постоянно. */
const reserved: TextProfile = {
  start: {
    greeting:
      'Привет. Я ВЫДОХ.\n\n' +
      'Можешь просто рассказать мне всё, что сейчас крутится в голове. ' +
      'Не надо структурировать, красиво формулировать или сортировать. Я сама разберусь.',
    consentNotice: (policyUrl) =>
      `Продолжая, ты соглашаешься на обработку данных — вот [политика конфиденциальности](${policyUrl}).`,
    buttonVoice: 'Наговорить',
    buttonText: 'Написать',
    hintVoice: 'Зажми кнопку микрофона и говори. Можно долго, можно несколькими сообщениями.',
    hintText: 'Просто напиши всё подряд, одним сообщением или несколькими.',
  },

  listening: {
    acknowledged: 'Слушаю.',
  },

  limits: {
    tooManyDumps: 'На сегодня достаточно. Всё, что прислала, сохранено — вернёмся завтра.',
  },

  privacy: {
    deleteFirstStep:
      'Удалю всё: записи, расшифровки, настройки и сам профиль. Восстановить будет нельзя.',
    deleteSecondStep: 'Последняя проверка. Удаляю всё безвозвратно?',
    deleteConfirmButton: 'Удалить',
    deleteFinalButton: 'Да, удалить безвозвратно',
    deleteCancelButton: 'Отмена',
    deleteDone: 'Готово. Всё удалено. Если захочешь начать заново — просто напиши.',
    deleteCancelled: 'Отменила. Всё на месте.',
    nothingToDelete: 'Удалять нечего: данных нет.',
    nothingToExport: 'Выгружать нечего: данных пока нет.',
    exportReady: 'Вот всё, что у меня есть.',
  },

  errors: {
    generic: 'Что-то пошло не так с моей стороны. Ничего не потерялось, попробуй ещё раз.',
  },
};

export const profiles = { reserved } as const;

export type ProfileName = keyof typeof profiles;

export const texts: TextProfile = reserved;
