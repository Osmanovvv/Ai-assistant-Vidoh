import { spawn } from 'node:child_process';

/**
 * Тонкая обёртка над ffmpeg и ffprobe (задача 1.14).
 *
 * Процесс запускается напрямую, без библиотеки-обёртки: аргументы
 * передаются массивом, поэтому пробелы и кириллица в путях не требуют
 * экранирования и не могут превратиться в инъекцию в командную строку.
 */

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export class FfmpegError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`${command} завершился с кодом ${String(code)}: ${stderr.slice(-500)}`);
    this.name = 'FfmpegError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function run(
  command: 'ffmpeg' | 'ffprobe',
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RunResult> {
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      finished = true;
      child.kill('SIGKILL');
      reject(new FfmpegError(command, null, `превышен таймаут ${String(timeoutMs)} мс`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    // ffmpeg пишет и прогресс, и вывод фильтров в stderr — он нам нужен.
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new FfmpegError(command, code, stderr));
      }
    });
  });
}

/** Длительность записи в секундах. */
export async function probeDurationSec(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ]);

  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe вернул некорректную длительность: ${stdout.trim()}`);
  }

  return duration;
}

/** Вывод фильтра silencedetect для последующего разбора. */
export async function detectSilence(
  path: string,
  params: { readonly noiseDb?: number; readonly minDurationSec?: number } = {},
): Promise<string> {
  const noiseDb = params.noiseDb ?? -30;
  const minDurationSec = params.minDurationSec ?? 0.5;

  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-i',
    path,
    '-af',
    `silencedetect=noise=${String(noiseDb)}dB:d=${String(minDurationSec)}`,
    '-f',
    'null',
    '-',
  ]);

  return stderr;
}

/**
 * Конвертация в моно 16 кГц WAV — формат, который принимают все
 * распознаватели речи и который не зависит от кодека Telegram.
 */
export async function convertToWav(
  input: string,
  output: string,
  range?: { readonly startSec: number; readonly endSec: number },
): Promise<void> {
  const args = ['-hide_banner', '-y'];

  if (range) {
    // -ss до -i даёт быстрый переход по ключевым кадрам.
    args.push('-ss', range.startSec.toFixed(3), '-to', range.endSec.toFixed(3));
  }

  args.push('-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output);

  await run('ffmpeg', args);
}

/**
 * Склейка нескольких записей в один моно 16 кГц WAV с паузой между ними
 * (задача 1.14, дополнено 27.08.2026).
 *
 * Зачем: SpeechKit берёт деньги блоками по 15 секунд **за запрос**. Девять
 * голосовых одной выгрузки — девять запросов и девять округлений вверх:
 * 172 секунды речи превращаются в 255 оплаченных. Склеенные в один файл,
 * те же 172 секунды стоят 180.
 *
 * Пауза между записями нужна, чтобы слова на стыке не слиплись в одно.
 * Она короткая намеренно: пауза — тоже оплаченное аудио, и по полсекунды
 * на восемь стыков это четыре секунды, то есть ни одного лишнего блока.
 */
export async function concatToWav(
  inputs: readonly string[],
  output: string,
  pauseSec: number,
): Promise<void> {
  if (inputs.length === 0) throw new Error('склеивать нечего');
  if (inputs.length === 1) {
    await convertToWav(inputs[0] ?? '', output);
    return;
  }

  const args = ['-hide_banner', '-y'];
  for (const input of inputs) args.push('-i', input);

  // Каждый вход приводится к одному формату до склейки: concat требует
  // совпадения частоты и числа каналов, а Telegram отдаёт и голосовые, и
  // пересланные аудиофайлы, у которых они разные.
  const chains: string[] = [];
  const labels: string[] = [];

  for (const [index] of inputs.entries()) {
    const pad = index === inputs.length - 1 ? '' : `,apad=pad_dur=${pauseSec.toFixed(3)}`;
    chains.push(
      `[${String(index)}:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono${pad}[a${String(index)}]`,
    );
    labels.push(`[a${String(index)}]`);
  }

  const filter = `${chains.join(';')};${labels.join('')}concat=n=${String(inputs.length)}:v=0:a=1[out]`;

  args.push('-filter_complex', filter, '-map', '[out]', '-c:a', 'pcm_s16le', output);

  await run('ffmpeg', args);
}
