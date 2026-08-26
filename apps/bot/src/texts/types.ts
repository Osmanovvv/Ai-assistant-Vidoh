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

  readonly errors: {
    readonly generic: string;
  };
}
