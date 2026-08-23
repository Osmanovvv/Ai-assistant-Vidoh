import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run } from './ffmpeg.js';
import { DEFAULT_AUDIO_LIMITS, prepareAudio, withTempDir } from './audio.service.js';

/**
 * Тесты против настоящего ffmpeg. Файлы синтезируются на лету, поэтому
 * проверяется весь путь: определение длительности, поиск пауз, нарезка
 * и конвертация — а не наши представления о том, как ведёт себя ffmpeg.
 */

/** Синтезирует запись: чередование тона и тишины заданной длительности. */
async function makeAudio(
  path: string,
  blocks: readonly { readonly kind: 'tone' | 'silence'; readonly sec: number }[],
): Promise<void> {
  const inputs: string[] = [];
  for (const block of blocks) {
    inputs.push(
      '-f',
      'lavfi',
      '-t',
      String(block.sec),
      '-i',
      block.kind === 'tone' ? 'sine=frequency=440:sample_rate=16000' : 'anullsrc=r=16000:cl=mono',
    );
  }

  const filter = `${blocks.map((_, i) => `[${String(i)}:a]`).join('')}concat=n=${String(blocks.length)}:v=0:a=1[out]`;

  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    ...inputs,
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-ac',
    '1',
    '-ar',
    '16000',
    path,
  ]);
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
    });
  }, 120_000);

  it('значения лимитов по умолчанию разумны для голосовых Telegram', () => {
    expect(DEFAULT_AUDIO_LIMITS.maxSegmentSec).toBe(300);
    expect(DEFAULT_AUDIO_LIMITS.maxSingleDurationSec).toBe(600);
  });
});
