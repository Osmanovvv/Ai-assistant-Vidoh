import { readFile } from 'node:fs/promises';

import { clockTimesIn } from '../modules/classifier/clock-time.js';
import { answerRemainder, readAnswer } from '../modules/resolver/answer.js';
import { clarifiedCommand } from '../modules/resolver/clarify.js';

/**
 * Замер «как сейчас» (шаг 2 плана docs/28, 28.09.2026): как нынешний код,
 * без модели, узнаёт ответы на вопросы бота из набора
 * `docs/eval-dialog/cases.md`. Бесплатно: ни базы, ни модели.
 *
 * Итог по каждой фразе — «верно», «не понял» или «не так». «Не так» —
 * худшее: бот сделал бы не то, что сказано (выбрал не тот час, принял
 * новую мысль за ответ). «Не понял» — реплика ушла бы обычным разбором,
 * а вопрос остался без ответа.
 *
 * Запуск: npx tsx src/scripts/check-dialog-answers.ts ../../docs/eval-dialog/cases.md
 */

type Kind = 'time' | 'which' | 'move' | 'attach';

interface Section {
  readonly title: string;
  readonly kind: Kind;
  readonly command: string;
  readonly cases: { readonly say: string; readonly expect: string; readonly live: boolean }[];
}

type Verdict = 'верно' | 'не понял' | 'не так';

const KINDS: readonly Kind[] = ['time', 'which', 'move', 'attach'];

function parse(text: string): Section[] {
  const sections: Section[] = [];
  let current:
    { title: string; kind?: Kind; command: string; cases: Section['cases'][number][] } | undefined;

  const flush = (): void => {
    if (current?.kind !== undefined) {
      sections.push({
        title: current.title,
        kind: current.kind,
        command: current.command,
        cases: current.cases,
      });
    }
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      flush();
      current = { title: line.slice(3), command: '', cases: [] };
      continue;
    }
    if (current === undefined) continue;

    const header = /^(вид|команда): (.+)$/u.exec(line);
    if (header !== null) {
      const value = header[2] ?? '';
      if (header[1] === 'вид') {
        const kind = KINDS.find((one) => one === value);
        if (kind === undefined) throw new Error(`Неизвестный вид «${value}» в «${current.title}»`);
        current.kind = kind;
      } else {
        current.command = value;
      }
      continue;
    }

    const at = line.indexOf(' => ');
    if (at < 0 || line.startsWith('`')) continue;
    const say = line.slice(0, at);
    const [expect = '', source = ''] = line.slice(at + 4).split(' | ');
    current.cases.push({ say, expect: expect.trim(), live: source.includes('живое') });
  }
  flush();
  return sections;
}

/** Что понял бы нынешний код: то же слово, что в наборе, или «нет ответа». */
function codeReads(section: Section, say: string): string {
  if (section.kind === 'time') {
    const done = clarifiedCommand('time', section.command, say);
    if (done === undefined) return 'нет ответа';
    const readings = clockTimesIn(done);
    const only = readings.length === 1 && readings[0]?.length === 1 ? readings[0][0] : undefined;
    if (only === undefined) return 'двояко';
    return `${String(Math.floor(only / 60)).padStart(2, '0')}:${String(only % 60).padStart(2, '0')}`;
  }
  if (section.kind === 'which') {
    return clarifiedCommand('which', section.command, say) === undefined ? 'нет ответа' : 'дело';
  }

  const reading = readAnswer(say, { move: section.kind === 'move' });
  if (reading === 'content') return 'мысль';
  if (reading === 'unclear') return 'нет ответа';
  if (section.kind === 'move') return reading === 'attach' ? 'да' : 'нет';
  return reading === 'attach' ? 'к прошлой' : 'отдельно';
}

function judge(section: Section, say: string, expect: string, got: string): Verdict {
  const answer = expect.split(' + мысль')[0]?.trim() ?? '';
  const withThought = expect.includes('+ мысль');
  const isAnswer = !['не ответ', 'встречный вопрос', 'не решил', 'переспросить'].includes(answer);

  if (!isAnswer) {
    if (answer === 'не ответ') {
      return got === 'нет ответа' || got === 'мысль' ? 'верно' : 'не так';
    }
    // Встречный вопрос, «не знаю», двоякое: код их не различает. Главное —
    // не принять за ответ; не принял — «не понял», принял — «не так».
    if (got === 'нет ответа' || got === 'мысль' || got === 'двояко') {
      return answer === 'не решил' &&
        section.kind !== 'time' &&
        section.kind !== 'which' &&
        got === 'нет ответа'
        ? 'верно'
        : 'не понял';
    }
    return 'не так';
  }

  if (got === 'нет ответа' || got === 'мысль' || got === 'двояко') return 'не понял';
  // Ответ с мыслью: у вопроса с кнопками слова сверх ответа уходят в
  // черновик (`pending.ts`) — не потеряны, но и не разобраны; у переспроса
  // ответом целиком мысль пропала бы.
  if (withThought) {
    const kept =
      (section.kind === 'move' || section.kind === 'attach') && answerRemainder(say) !== '';
    return kept && got === answer ? 'не понял' : 'не так';
  }
  if (section.kind === 'which') return 'верно';
  return got === answer ? 'верно' : 'не так';
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) throw new Error('Путь к набору: …/docs/eval-dialog/cases.md');
  const sections = parse(await readFile(path, 'utf8'));

  const total: Record<Verdict, number> = { верно: 0, 'не понял': 0, 'не так': 0 };
  let live = { all: 0, right: 0 };

  for (const section of sections) {
    const counts: Record<Verdict, number> = { верно: 0, 'не понял': 0, 'не так': 0 };
    const wrong: string[] = [];
    const missed: string[] = [];
    for (const one of section.cases) {
      const got = codeReads(section, one.say);
      const verdict = judge(section, one.say, one.expect, got);
      counts[verdict]++;
      total[verdict]++;
      if (one.live) live = { all: live.all + 1, right: live.right + (verdict === 'верно' ? 1 : 0) };
      if (verdict === 'не так') wrong.push(`  «${one.say}» → код: ${got}; надо: ${one.expect}`);
      if (verdict === 'не понял') missed.push(`  «${one.say}» → код: ${got}; надо: ${one.expect}`);
    }
    const all = section.cases.length;
    say(
      `\n${section.title}: ${String(all)} фраз — верно ${String(counts.верно)}, не понял ${String(counts['не понял'])}, не так ${String(counts['не так'])}`,
    );
    if (wrong.length > 0) say(`Не так:\n${wrong.join('\n')}`);
    if (process.argv.includes('--missed') && missed.length > 0) {
      say(`Не понял:\n${missed.join('\n')}`);
    }
  }

  const all = total.верно + total['не понял'] + total['не так'];
  say(
    `\nВсего ${String(all)} фраз: верно ${String(total.верно)} (${String(Math.round((total.верно / all) * 100))}%), не понял ${String(total['не понял'])}, не так ${String(total['не так'])}`,
  );
  say(`Живые реплики: верно ${String(live.right)} из ${String(live.all)}`);
}

await main();
