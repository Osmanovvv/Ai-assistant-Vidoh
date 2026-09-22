import { describe, expect, it } from 'vitest';

import { looksLikeSomedayTask } from './someday-task.js';

/**
 * «Когда-нибудь разобрать фотографии» — дело на потом, а не желание
 * (живой набор, известный промах 17.09.2026).
 *
 * Модель отдаёт такое желанием: слово «когда-нибудь» для неё сильнее
 * названного действия. Но женщина назвала **конкретное действие**, у
 * которого нет ни срока, ни «хочу», — это дело с важностью «позже», и
 * место ему в «⏳ Позже», а не в желаниях, куда списки не заглядывают.
 *
 * Правило узкое, как у желания с рамкой срока: и «когда-нибудь», и
 * глагол действия, и **никакого** слова желания рядом.
 */
describe('дело на «когда-нибудь»', () => {
  it('«когда-нибудь разобрать фотографии на телефоне» — дело', () => {
    expect(looksLikeSomedayTask('когда-нибудь разобрать фотографии на телефоне')).toBe(true);
    expect(looksLikeSomedayTask('как-нибудь разобрать балкон')).toBe(true);
    expect(looksLikeSomedayTask('на досуге разобрать балкон')).toBe(true);
  });

  it('слово желания рядом — остаётся желанием: её правило «желание не становится задачей»', () => {
    expect(looksLikeSomedayTask('хочу когда-нибудь съездить на море')).toBe(false);
    expect(looksLikeSomedayTask('давно хочется когда-нибудь научиться рисовать')).toBe(false);
    expect(looksLikeSomedayTask('мечтаю когда-нибудь пройти этот курс')).toBe(false);
    expect(looksLikeSomedayTask('было бы здорово когда-нибудь освоить гитару')).toBe(false);
  });

  it('намерение жить иначе — желание, даже без слова «хочу» (проба 22.09.2026)', () => {
    /**
     * Первый заход правила ловил любой глагол в неопределённой форме и
     * превращал в дела «когда-нибудь научиться рисовать», «заняться
     * спортом», «съездить на море» — а это желания по её же
     * определению: намерение без обязательства. Список дел закрыт и
     * бытовой: разобрать, постирать, забрать, позвонить.
     */
    expect(looksLikeSomedayTask('когда-нибудь научиться рисовать')).toBe(false);
    expect(looksLikeSomedayTask('когда-нибудь заняться спортом')).toBe(false);
    expect(looksLikeSomedayTask('когда-нибудь похудеть')).toBe(false);
    expect(looksLikeSomedayTask('когда-нибудь освоить гитару')).toBe(false);
    expect(looksLikeSomedayTask('когда-нибудь съездить на море')).toBe(false);
    expect(looksLikeSomedayTask('когда-нибудь начать бегать по утрам')).toBe(false);
  });

  it('бытовые дела — дела: разобрать, постирать, забрать, позвонить', () => {
    expect(looksLikeSomedayTask('как-нибудь постирать шторы')).toBe(true);
    expect(looksLikeSomedayTask('когда-нибудь забрать вещи от родителей')).toBe(true);
    expect(looksLikeSomedayTask('при случае позвонить в поликлинику')).toBe(true);
    expect(looksLikeSomedayTask('на досуге разложить документы по папкам')).toBe(true);
  });

  it('живые слова тоже считаются делом: разгрести, доделать, сходить, съездить к, дойти (22.09.2026)', () => {
    expect(looksLikeSomedayTask('как-то потом разгрести фотки')).toBe(true);
    expect(looksLikeSomedayTask('когда-нибудь доделать альбом')).toBe(true);
    expect(looksLikeSomedayTask('при случае сходить в химчистку')).toBe(true);
    expect(looksLikeSomedayTask('когда-нибудь дойти до нотариуса')).toBe(true);
    expect(looksLikeSomedayTask('на досуге доразобрать коробки')).toBe(true);
    expect(looksLikeSomedayTask('как-нибудь свозить кота к ветеринару')).toBe(true);
  });

  it('и после расширения намерения остаются желаниями', () => {
    expect(looksLikeSomedayTask('когда-нибудь научиться рисовать')).toBe(false);
    expect(looksLikeSomedayTask('как-то потом заняться собой')).toBe(false);
    expect(looksLikeSomedayTask('когда-нибудь съездить на море')).toBe(false);
    expect(looksLikeSomedayTask('когда-нибудь начать новую жизнь')).toBe(false);
  });

  it('без «когда-нибудь» или без действия правило молчит', () => {
    expect(looksLikeSomedayTask('разобрать фотографии на телефоне')).toBe(false);
    expect(looksLikeSomedayTask('когда-нибудь на море')).toBe(false);
    expect(looksLikeSomedayTask('')).toBe(false);
  });

  it('«когда-нибудь» о сроке чужого дела правило не трогает: нужна своя единица', () => {
    // «Позвонить, когда-нибудь освободится» — здесь «когда-нибудь» про
    // обстоятельство, а не про откладывание; действие названо до него.
    expect(looksLikeSomedayTask('позвонить маме, когда-нибудь освободится')).toBe(false);
  });
});
