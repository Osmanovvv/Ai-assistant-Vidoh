import type { Item } from '../../db/schema.js';
import type { TextProfile } from '../../texts/index.js';
import type { ProjectContext } from './projects.service.js';

/**
 * Ответ про проект (§21 п.6 ТЗ, задача 3.13).
 *
 * «Что там с днём рождения» через неделю — бот показывает, **что уже
 * решено, что осталось и следующий шаг, не переспрашивая известное**.
 *
 * Порядок частей не случаен. Сначала сделанное: человек, вернувшийся
 * через неделю, чаще всего помнит только то, что не успел, и первое, что
 * ему нужно, — увидеть, что он не с нуля. Потом остаток, и лишь потом
 * один шаг, за который можно взяться.
 *
 * **Ни одного вопроса.** Переспросить здесь — значит показать, что бот не
 * помнит, а весь третий этап про то, что помнит.
 */
export function describeProject(item: Item, context: ProjectContext, texts: TextProfile): string {
  const project = texts.project;
  const lines: string[] = [project.header(item.text)];

  if (context.steps.length === 0) {
    lines.push('', project.noSteps);
    return lines.join('\n');
  }

  if (context.done.length > 0) {
    lines.push('', project.doneHeader, ...context.done.map((step) => project.line(step.text)));
  }

  if (context.next === undefined) {
    lines.push('', project.finished);
    return lines.join('\n');
  }

  /**
   * Остаток показывается без ближайшего шага.
   *
   * Иначе он назван дважды — в списке и отдельной строкой, — и человек
   * читает одно и то же, гадая, разные ли это дела.
   */
  const rest = context.remaining.filter((step) => step.id !== context.next?.id);

  if (rest.length > 0) {
    lines.push('', project.remainingHeader, ...rest.map((step) => project.line(step.text)));
  }

  lines.push('', project.nextStep(context.next.text));
  return lines.join('\n');
}
