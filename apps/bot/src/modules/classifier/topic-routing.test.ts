import { describe, expect, it } from 'vitest';

import { semanticTopicFor, shouldApplySemanticTopic } from './topic-routing.js';

const TOPICS = ['семья', 'здоровье', 'работа', 'покупки', 'дом', 'личное'];

describe('осторожная проверка сферы по смыслу записи', () => {
  it('побеждает ошибочную тему соседа для посылки', () => {
    expect(semanticTopicFor('Забрать тестовую посылку', TOPICS)?.name).toBe('покупки');
  });

  it('медицинская цель сильнее слова «сын»', () => {
    expect(semanticTopicFor('Записать сына к врачу', TOPICS)?.name).toBe('здоровье');
  });

  it('различает семейную школу и медицинскую запись', () => {
    expect(semanticTopicFor('Записать сына в школу', TOPICS)?.name).toBe('семья');
  });

  it('распознаёт рабочие документы', () => {
    expect(semanticTopicFor('Проверить документы завтра', TOPICS)?.name).toBe('работа');
  });

  it('не считает документы из МФЦ рабочей задачей', () => {
    expect(semanticTopicFor('Забрать документы из МФЦ', TOPICS)).toBeUndefined();
  });

  it('не переносит звонок родственнику в работу по рабочему соседу', () => {
    expect(semanticTopicFor('Позвонить маме', TOPICS)).toBeUndefined();
  });

  it('распознаёт товар из проблемного голосового', () => {
    expect(semanticTopicFor('Заказать чеснокодавилку и отпугиватель от собак', TOPICS)?.name).toBe(
      'покупки',
    );
  });

  it('распознаёт новый товар по явному «купить»', () => {
    expect(semanticTopicFor('Купить зелёные яблоки', TOPICS)?.name).toBe('покупки');
  });

  it('относит химчистку к дому, а не к покупкам', () => {
    expect(semanticTopicFor('Сдать пальто в химчистку', TOPICS)?.name).toBe('дом');
  });

  it('не угадывает сферу у обычного массажа', () => {
    expect(semanticTopicFor('Сходить на массаж', TOPICS)).toBeUndefined();
  });

  it('не считает отправку посылки покупкой', () => {
    expect(semanticTopicFor('Отправить посылку в Калининград', TOPICS)).toBeUndefined();
  });

  it('не перебивает пользовательскую тему, которой нет в каталоге', () => {
    const target = semanticTopicFor('Записать сына к врачу', TOPICS);
    expect(shouldApplySemanticTopic('моя медицина', TOPICS, target)).toBe(false);
  });
});
