import { run } from '../modules/speech/ffmpeg.js';

/**
 * Синтез записей для тестов: чередование тона и тишины заданной длины.
 *
 * Файлы делаются на лету настоящим ffmpeg, а не берутся из репозитория:
 * тогда тест проверяет весь путь — длительность, поиск паузы, нарезку,
 * склейку, — а не наши представления о том, как ffmpeg себя ведёт.
 */
export async function makeAudio(
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

  const filter = `${blocks.map((_, index) => `[${String(index)}:a]`).join('')}concat=n=${String(blocks.length)}:v=0:a=1[out]`;

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
