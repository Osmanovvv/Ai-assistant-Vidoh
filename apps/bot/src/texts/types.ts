/**
 * Форма словаря реплик (задача 2.11).
 *
 * Инвариант 4 и §12.3 ТЗ: ни одной реплики бота в коде. §13.9 добавляет
 * требование менять тексты без выкладки — на четвёртом этапе их правит
 * админка, и тогда рядом с этим профилем встанет источник из базы.
 * Поэтому обращение к текстам идёт через `textsFor`, а не импортом
 * объекта: подменить источник позже можно будет, не трогая вызовы.
 *
 * §13.8 ТЗ: тон — это профиль, переключаемый на уровне пользователя.
 * Заказчик рассматривает более тёплый вариант второй версией, и он должен
 * добавляться сюда, а не в ядро разбора. Отсюда интерфейс: второй профиль
 * обязан заполнить те же поля, и забыть половину реплик не выйдет —
 * не соберётся сборка.
 *
 * Род бота женский — решение §13 ТЗ. Формы, зависящие от рода
 * пользователя, не используются: иначе пришлось бы спрашивать пол на
 * онбординге, а §13.1 запрещает любые вопросы до первой выгрузки.
 */

export interface TextProfile {
  readonly start: {
    /**
     * Первый экран целиком, вместе со ссылкой на политику (§13.1, §16).
     *
     * Одной функцией, а не двумя строками, которые склеиваются в коде:
     * §13.9 требует менять тексты без выкладки, а склейка в обработчике
     * означает, что порядок и отбивка живут в коде и без выкладки не
     * меняются.
     */
    readonly screen: (policyUrl: string) => string;
    readonly buttonVoice: string;
    readonly buttonText: string;
    readonly hintVoice: string;
    readonly hintText: string;
  };

  readonly listening: {
    readonly acknowledged: string;
    readonly working: string;
    readonly nothingHeard: string;
    /**
     * Не всё расшифровано: запись длиннее десяти минут или выгрузка
     * длиннее двадцати (§10.5 ТЗ).
     *
     * До 27.08.2026 обрезка уходила только в журнал: человек говорил
     * двадцать пять минут, получал разбор первых двадцати и не знал, что
     * остальное потеряно. §10.5 требует предупреждения, и требует
     * справедливо — молчание здесь выглядит как «бот меня не слушал».
     */
    readonly tooLong: string;
  };

  /**
   * Ответ на выгрузку по §13.2: признание одной фразой, ограниченный
   * список действий, одна фраза о том, что остальное сохранено, ровно
   * один вопрос, кнопки.
   *
   * Признание пишет модель — оно зависит от того, что человек наговорил.
   * Всё остальное здесь, потому что не зависит: список собирает фильтр
   * выдачи, а вопрос и кнопки одни и те же.
   */
  readonly answer: {
    /**
     * Замена признанию, когда модель нарушила правила §13.7 или §13.9.
     * Нейтральная фраза хуже удачной, но лучше запрещённой.
     */
    readonly acknowledgementFallback: string;
    /** То же, когда в выгрузке есть эмоция: §13.7 требует одной строки. */
    readonly acknowledgementTiredFallback: string;

    readonly actionsLead: string;
    /** §13.7: при «я на нуле» предлагается ровно одно дело. */
    readonly actionsLeadSingle: string;
    readonly bullet: (text: string) => string;

    /** §13.2: одна фраза о сохранённом, без перечисления. */
    readonly restSaved: string;
    /** Когда за пределами выдачи ничего не осталось. */
    readonly nothingHidden: string;
    /** Разобрать было что, но срочного нет. */
    readonly nothingUrgent: string;

    readonly question: string;
    /**
     * §13.7: при усталости разговор закрывается, а не продолжается
     * вопросом. Это не вопрос — двух вопросов в реплике не бывает,
     * а здесь их ноль.
     */
    readonly closingTired: string;
    /** §13.7: эмоциональный монолог без дел — одна реплика и один вопрос. */
    readonly questionEmotionOnly: string;

    readonly buttonDoNow: string;
    readonly buttonShowAll: string;
    readonly buttonLater: string;

    /** §17: разобрать не удалось, но текст сохранён. */
    readonly savedUnparsed: string;
    /**
     * Разбирать было нечего: человек поздоровался или наговорил только
     * заполнение паузы. Реплика короткая (§13.9) и не выдаёт разбор.
     */
    readonly nothingToParse: string;
  };

  /**
   * Меню и карточка записи (§12.1, §12.2 ТЗ, задача 2.18).
   *
   * Пунктов меньше, чем в §12.1: показывать кнопку, за которой ничего
   * нет, хуже, чем не показывать её вовсе. «Проекты», «Настройки» и
   * «Подписка» появятся вместе со своими задачами.
   */
  readonly menu: {
    readonly title: string;
    readonly buttonVoice: string;
    readonly buttonText: string;
    readonly buttonAll: string;
    readonly buttonToday: string;
    readonly buttonHelp: string;
    readonly buttonDeleteData: string;
    readonly buttonBack: string;

    readonly topicsTitle: string;
    readonly noTopics: string;
    readonly todayTitle: string;
    readonly todayEmpty: string;
    readonly help: string;
  };

  /** Карточка записи по §12.2: заголовок, тема, срок, статус, кнопки. */
  readonly card: {
    readonly topicLabel: string;
    readonly deadlineLabel: string;
    /** Срок с неточной датой: «на следующей неделе» — это не число. */
    readonly deadlineApprox: (date: string) => string;
    readonly statusLabel: string;
    /** Регулярность — словами человека, а не нашим пересказом правила. */
    readonly recurrenceLabel: string;
    readonly statusName: (status: string) => string;
    readonly noDeadline: string;

    readonly buttonDone: string;
    readonly buttonSnooze: string;
    readonly buttonEdit: string;
    readonly buttonDelete: string;

    readonly done: string;
    readonly snoozed: string;
    readonly deleted: string;
    /**
     * Правка голосом, а не кнопками: §7 ТЗ строит её на речи, и учить
     * человека формам вместо разговора значит идти против продукта.
     */
    readonly editHint: string;
    readonly gone: string;
  };

  /**
   * Закреплённая сводка темы (§8.2 ТЗ, задача 2.16).
   *
   * Одно сообщение на ветку, обновляется редактированием. Вопросов в нём
   * нет вовсе: сводка — это список, а не разговор.
   */
  readonly summary: {
    readonly header: (topic: string) => string;
    readonly line: (text: string) => string;
    readonly lineWithDate: (text: string, date: string) => string;
    readonly empty: string;
    /** Сколько записей не показано: сводка не растёт бесконечно. */
    readonly more: (count: number) => string;
  };

  /**
   * Онбординг (§12.2 ТЗ, задача 2.13).
   *
   * Идёт после первой выгрузки, не до неё, и весь состоит из кнопок:
   * свободный ответ пришёл бы обычным сообщением и попал в буфер
   * выгрузки, то есть либо потерялась бы мысль, либо именем стало бы
   * «надо купить продукты».
   *
   * В каждой реплике ровно один вопрос — §13.9.
   */
  readonly onboarding: {
    readonly nameConfirm: (name: string) => string;
    readonly buttonNameYes: string;
    readonly buttonNameLater: string;

    readonly timezoneMoscow: string;
    readonly buttonTimezoneMoscow: string;
    readonly buttonTimezoneOther: string;
    readonly timezoneChoose: string;

    readonly morning: string;
    readonly evening: string;
    readonly buttonEveningOff: string;

    readonly topics: string;
    readonly buttonTopicsDone: string;
    /** Отметка выбранной сферы. §12.4: эмодзи как маркер, не украшение. */
    readonly topicChosen: (name: string) => string;

    readonly finished: string;
    /** Ни одной сферы не выбрано: берём базовый набор §6.4 и не спорим. */
    readonly finishedDefault: string;

    /**
     * §6.4: дела, не попавшие ни в одну выбранную сферу, уходят в тему по
     * умолчанию, **а бот предлагает создать новую**. Предлагает, а не
     * создаёт: создавать темы без спроса запрещено.
     */
    readonly offerTopics: (names: readonly string[]) => string;
    readonly buttonAddTopics: string;
    readonly buttonSkipTopics: string;
    readonly topicsAdded: (names: readonly string[]) => string;
    readonly topicsNotAdded: string;
    /** Больше сфер, чем продукт готов держать (§6.4: количество ограничено). */
    readonly topicsLimit: string;
  };

  /**
   * Острый кризис (§13.7, задача 2.12).
   *
   * Единственный текст, который модель не видит вовсе: она о нём не
   * знает, не генерирует его и не переписывает. Формулировка
   * согласуется с заказчиком отдельно — §13.7 говорит это прямо.
   */
  readonly safety: {
    readonly crisis: string;
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

  /**
   * Сбои, о которых человек обязан узнать (§17 ТЗ).
   *
   * Три случая, а не один: сказать «попробуй ещё раз» там, где выгрузка
   * уже стоит в очереди на повтор, — это позвать человека сделать
   * работу дважды и заплатить дважды.
   */
  readonly errors: {
    /** Разбор сорвался окончательно, повтора не будет. */
    readonly generic: string;
    /** Сорвался, но выгрузка вернулась в очередь: §17 требует сказать о задержке. */
    readonly delayed: string;
    /** Расшифровка не удалась: §17 требует предложить прислать текстом. */
    readonly speechFailed: string;
  };
}
