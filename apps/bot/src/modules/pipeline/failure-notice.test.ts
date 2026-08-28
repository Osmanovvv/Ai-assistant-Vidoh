import { describe, expect, it } from 'vitest';

import { TransientError } from '../../infra/failures.js';
import { profiles } from '../../texts/index.js';
import { PermanentSpeechError, TransientSpeechError } from '../speech/providers/types.js';
import { noticeKindOf } from './failure-notice.js';

/**
 * Какой текст говорить человеку о сорвавшемся разборе (§17 ТЗ).
 *
 * Сверка с ТЗ 28.08.2026 нашла, что не говорилось вообще ничего: текст
 * `errors.generic` лежал в словаре и не вызывался ни разу. Человек видел
 * «Секунду, слушаю запись» и больше ничего, навсегда.
 *
 * Здесь проверяется само решение — какой из трёх случаев. Спутать их
 * дороже, чем кажется: «попробуй ещё раз» там, где выгрузка уже стоит в
 * очереди на повтор, звало бы человека сделать работу дважды и заплатить
 * дважды.
 */

describe('выбор текста о сбое', () => {
  it('повтор впереди — говорим о задержке, а не о поражении', () => {
    // §17: «выгрузка сохраняется в очередь с повтором, пользователю
    // честное короткое сообщение о задержке».
    expect(noticeKindOf({ retryable: true, error: new Error('сеть моргнула') })).toBe('delayed');
  });

  it('повтор впереди важнее природы ошибки', () => {
    // Даже если сорвалась расшифровка: пока повтор впереди, просить
    // прислать текстом рано.
    expect(noticeKindOf({ retryable: true, error: new TransientSpeechError('занято') })).toBe(
      'delayed',
    );
  });

  it('расшифровка не удалась окончательно — просим текстом', () => {
    // §17, первая строка: «бот просит прислать текстом или повторить».
    expect(noticeKindOf({ retryable: false, error: new PermanentSpeechError('формат') })).toBe(
      'speechFailed',
    );
  });

  it('прочий окончательный сбой — общий текст', () => {
    expect(noticeKindOf({ retryable: false, error: new Error('модель молчит') })).toBe('generic');
    expect(noticeKindOf({ retryable: false, error: new TransientError('исчерпаны попытки') })).toBe(
      'generic',
    );
  });
});

describe('тексты о сбое годны для человека', () => {
  const kinds = ['generic', 'delayed', 'speechFailed'] as const;

  for (const profile of Object.values(profiles)) {
    for (const kind of kinds) {
      const text = profile.errors[kind];

      it(`«${kind}»: одна-две фразы (§13.9)`, () => {
        expect(text.length).toBeLessThanOrEqual(160);
        expect(text).not.toContain('\n');
      });

      it(`«${kind}»: не бросает человека в неизвестность`, () => {
        // §9 ТЗ и есть источник доверия к продукту: сказанное не потеряно,
        // и человек обязан это услышать, а не догадаться.
        expect(text.toLowerCase()).toMatch(/сохранен|не потерял/u);
      });

      it(`«${kind}»: без вопроса — вопрос в реплике только один (§13.9)`, () => {
        expect(text).not.toContain('?');
      });
    }
  }

  it('о задержке не просят повторять: выгрузка уже в очереди', () => {
    for (const profile of Object.values(profiles)) {
      expect(profile.errors.delayed.toLowerCase()).not.toMatch(/попробуй|пришли/u);
    }
  });
});
