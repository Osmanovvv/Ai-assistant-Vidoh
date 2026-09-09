import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeAudio } from '../../test/audio.js';
import { probeDurationSec, run } from './ffmpeg.js';
import {
  DEFAULT_AUDIO_LIMITS,
  MAX_SEGMENT_SEC,
  prepareAudio,
  withTempDir,
  type PreparedAudio,
} from './audio.service.js';

/**
 * Тесты против настоящего ffmpeg. Файлы синтезируются на лету, поэтому
 * проверяется весь путь: определение длительности, поиск пауз, нарезка
 * и конвертация — а не наши представления о том, как ведёт себя ffmpeg.
 */

/**
 * Сверяет длину каждого готового файла с тем, что о нём сказано.
 *
 * **Чего не видели проверки нарезки.** Все они читали `startSec`/`endSec`
 * — числа, которые подготовка сама же и посчитала, ещё до запуска ffmpeg.
 * Это описание намерения, а не результат: нарезку можно было выключить
 * целиком, и границы остались бы теми же, покрытие — тем же, файлы на
 * диске — на месте. Ни одна проверка не открывала произведённый файл,
 * хотя именно он уезжает в распознаватель и именно за него платят.
 *
 * Расхождение здесь означает одно из двух, и оба дорогие: либо человеку
 * расшифровали не тот отрезок, который приписан части (слова уедут в
 * чужое сообщение при раскладке), либо в запрос ушло больше секунд, чем
 * разрешал потолок, — то есть оплачено сверх обещанного.
 *
 * Допуск — десятая доля секунды: -ss/-to по PCM режут по отсчётам, а не
 * по ключевым кадрам, поэтому промах бывает только на округлении. Держать
 * его узким обязательно: при широком проверка перестанет отличать
 * обрезанный файл от целого.
 */
async function expectPartsMatchBounds(prepared: PreparedAudio): Promise<void> {
  expect(prepared.parts.length).toBeGreaterThan(0);

  for (const part of prepared.parts) {
    const promised = part.endSec - part.startSec;
    const measured = await probeDurationSec(part.path);

    expect(
      measured,
      `часть ${part.path} обещает ${promised.toFixed(3)} с (${part.startSec.toFixed(3)}–` +
        `${part.endSec.toFixed(3)}), а на диске лежит ${measured.toFixed(3)} с`,
    ).toBeCloseTo(promised, 1);
  }
}

describe('withTempDir', () => {
  it('удаляет папку после работы', async () => {
    let captured = '';
    await withTempDir((dir) => {
      captured = dir;
      return Promise.resolve();
    });

    await expect(access(captured)).rejects.toThrow();
  });

  it('удаляет папку, даже если работа упала', async () => {
    let captured = '';
    await expect(
      withTempDir((dir) => {
        captured = dir;
        return Promise.reject(new Error('расшифровка не удалась'));
      }),
    ).rejects.toThrow('расшифровка не удалась');

    // §16 ТЗ: аудио не должно пережить обработку ни при каком исходе.
    await expect(access(captured)).rejects.toThrow();
  });

  it('удаляет папку вместе с содержимым', async () => {
    let captured = '';
    await withTempDir(async (dir) => {
      captured = dir;
      await makeAudio(join(dir, 'a.wav'), [{ kind: 'tone', sec: 1 }]);
    });

    await expect(access(captured)).rejects.toThrow();
  });
});

describe('prepareAudio', () => {
  it('короткая запись остаётся одной частью', async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, 'source.ogg');
      await makeAudio(source, [{ kind: 'tone', sec: 3 }]);

      const prepared = await prepareAudio(source, dir, {
        maxSegmentSec: 60,
        maxSingleDurationSec: 600,
      });

      expect(prepared.parts).toHaveLength(1);
      expect(prepared.truncated).toBe(false);
      expect(prepared.durationSec).toBeGreaterThan(2.5);
      expect(prepared.durationSec).toBeLessThan(3.5);
      await expectPartsMatchBounds(prepared);
    });
  }, 60_000);

  it('конвертирует в моно 16 кГц WAV', async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, 'source.ogg');
      await makeAudio(source, [{ kind: 'tone', sec: 2 }]);

      const prepared = await prepareAudio(source, dir, {
        maxSegmentSec: 60,
        maxSingleDurationSec: 600,
      });

      const { stdout } = await run('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=channels,sample_rate,codec_name',
        '-of',
        'default=noprint_wrappers=1',
        prepared.parts[0]!.path,
      ]);

      expect(stdout).toContain('channels=1');
      expect(stdout).toContain('sample_rate=16000');
      expect(stdout).toContain('codec_name=pcm_s16le');
    });
  }, 60_000);

  it('длинная запись режется на части по паузе', async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, 'source.wav');
      // Речь, пауза на 8–10 секунде, снова речь. Лимит 10 секунд:
      // резать должно по паузе, а не ровно на десятой секунде.
      await makeAudio(source, [
        { kind: 'tone', sec: 8 },
        { kind: 'silence', sec: 2 },
        { kind: 'tone', sec: 8 },
      ]);

      const prepared = await prepareAudio(source, dir, {
        maxSegmentSec: 10,
        maxSingleDurationSec: 600,
      });

      expect(prepared.parts.length).toBeGreaterThan(1);
      // Разрез в середине паузы — около девятой секунды.
      expect(prepared.parts[0]?.endSec).toBeGreaterThan(8);
      expect(prepared.parts[0]?.endSec).toBeLessThanOrEqual(10);
      // Разрез сосчитан — но резать должен был ffmpeg, а не наш расчёт.
      await expectPartsMatchBounds(prepared);
    });
  }, 120_000);

  it('части покрывают запись целиком без разрывов', async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, 'source.wav');
      await makeAudio(source, [
        { kind: 'tone', sec: 6 },
        { kind: 'silence', sec: 1 },
        { kind: 'tone', sec: 6 },
        { kind: 'silence', sec: 1 },
        { kind: 'tone', sec: 6 },
      ]);

      const prepared = await prepareAudio(source, dir, {
        maxSegmentSec: 8,
        maxSingleDurationSec: 600,
      });

      expect(prepared.parts[0]?.startSec).toBe(0);
      for (let i = 1; i < prepared.parts.length; i++) {
        expect(prepared.parts[i]?.startSec).toBe(prepared.parts[i - 1]?.endSec);
      }
      expect(prepared.parts.at(-1)?.endSec).toBeCloseTo(prepared.durationSec, 1);

      // Покрытие считалось по границам, и без замера «целиком без
      // разрывов» означало лишь, что числа сходятся друг с другом.
      // Сумма измеренных частей обязана дать всю запись: иначе покрытие
      // есть на бумаге, а куска речи нет ни в одном запросе.
      await expectPartsMatchBounds(prepared);

      let total = 0;
      for (const part of prepared.parts) total += await probeDurationSec(part.path);
      expect(total).toBeCloseTo(prepared.durationSec, 1);
    });
  }, 120_000);

  it('каждая часть существует на диске', async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, 'source.wav');
      await makeAudio(source, [
        { kind: 'tone', sec: 6 },
        { kind: 'silence', sec: 1 },
        { kind: 'tone', sec: 6 },
      ]);

      const prepared = await prepareAudio(source, dir, {
        maxSegmentSec: 7,
        maxSingleDurationSec: 600,
      });

      for (const part of prepared.parts) {
        await expect(access(part.path)).resolves.toBeUndefined();
      }
      const files = await readdir(dir);
      expect(files.filter((f) => f.startsWith('part-'))).toHaveLength(prepared.parts.length);

      // Существование файла ничего не говорит о том, что в нём: пустой и
      // целиковый существуют одинаково.
      await expectPartsMatchBounds(prepared);
    });
  }, 120_000);

  it('запись сверх потолка помечается обрезанной', async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, 'source.wav');
      await makeAudio(source, [{ kind: 'tone', sec: 12 }]);

      const prepared = await prepareAudio(source, dir, {
        maxSegmentSec: 5,
        maxSingleDurationSec: 8,
      });

      expect(prepared.truncated).toBe(true);
      expect(prepared.durationSec).toBe(8);
      expect(prepared.parts.at(-1)?.endSec).toBe(8);

      // Флаг и границы — это обещание. Отброшенный хвост обязан
      // отсутствовать в файлах, а не только в числах: иначе за него
      // заплачено, а §10.5 нарушен молча.
      await expectPartsMatchBounds(prepared);

      let total = 0;
      for (const part of prepared.parts) total += await probeDurationSec(part.path);
      expect(total, 'обрезанные восемь секунд, а не все двенадцать').toBeCloseTo(8, 1);
    });
  }, 120_000);

  it('обрезка, укладывающаяся в одну часть, всё равно режет файл', async () => {
    // **Отдельный случай, потому что путь другой.** Когда план выходит из
    // одного отрезка, подготовка конвертировала запись целиком — «без
    // лишнего перехода по времени». Для целой записи это верно, а для
    // обрезанной нет: отрезок короче исходника, и пропуск -ss/-to тихо
    // возвращает отброшенный хвост.
    //
    // Так приходит остаток потолка выгрузки (§10.5): расшифровка одной
    // записи зовётся с maxSingleDurationSec, равным остатку — пятнадцать
    // секунд против части в восемьдесят две. Одна часть, обрезка
    // «состоялась», а в запрос уходит вся запись целиком.
    await withTempDir(async (dir) => {
      const source = join(dir, 'source.wav');
      await makeAudio(source, [{ kind: 'tone', sec: 12 }]);

      const prepared = await prepareAudio(source, dir, {
        maxSegmentSec: 60,
        maxSingleDurationSec: 8,
      });

      expect(prepared.truncated).toBe(true);
      expect(prepared.parts).toHaveLength(1);
      expect(prepared.durationSec).toBe(8);
      await expectPartsMatchBounds(prepared);
    });
  }, 120_000);

  it('длина части укладывается в потолок тела запроса к распознавателю', () => {
    // Не круглое число, а расчёт: WAV моно 16 кГц весит 32 кБ в секунду,
    // base64 добавляет треть, а SpeechKit обрывает соединение на теле в
    // 8 МБ (проверено живыми запросами 24.08.2026). Пятиминутная часть
    // весила бы 12,8 МБ, и распознавание длинного голосового падало бы
    // всегда — при том что короткое работало бы прекрасно.
    expect(DEFAULT_AUDIO_LIMITS.maxSegmentSec).toBe(MAX_SEGMENT_SEC);

    const bodyBytes = MAX_SEGMENT_SEC * 16_000 * 2 * (4 / 3);
    expect(bodyBytes).toBeLessThan(4_000_000);

    expect(DEFAULT_AUDIO_LIMITS.maxSingleDurationSec).toBe(600);
  });
});
