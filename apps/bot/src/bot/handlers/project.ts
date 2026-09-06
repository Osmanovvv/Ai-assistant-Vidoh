import { type Bot } from 'grammy';
import type { Logger } from 'pino';

import type { Database } from '../../infra/db.js';
import { PROJECT_ACTION, stepButtons } from '../../modules/projects/project-actions.js';
import { completeStep } from '../../modules/projects/projects.service.js';
import { fromShortId } from '../../modules/shared/short-id.js';
import { outputContextOf } from '../../modules/users/state.repo.js';
import { findByTgId } from '../../modules/users/users.repo.js';
import { textsFor } from '../../texts/index.js';
import { fitKeyboard } from '../../modules/presenter/keyboard.js';

/**
 * «Шаг сделан» (§21 п.6 ТЗ, задача 3.82).
 *
 * **Что было сломано.** `completeStep` не звала ни одна кнопка бота, и
 * `projectSteps.doneAt` не заполнялся никогда. Значит «Сделано» в ответе
 * о проекте было всегда пустым, а «ближайший шаг» — всегда первым:
 * человек, вернувшийся через неделю, видел тот же шаг, что и в первый
 * день, независимо от того, сделал он его или нет. Три реплики про
 * закрытие шага — `buttonStepDone`, `stepDone`, `allStepsDone` — лежали
 * в текстах без единого читателя.
 *
 * **Владелец проверяется вместе с кодом шага.** Короткий код едет в
 * `callback_data`, то есть приходит снаружи и подделывается. Проверку
 * делает `completeStep` одним условием с идентификатором — без неё чужой
 * шаг закрывался бы по подобранному коду.
 */

const CODE = '[A-Za-z0-9_-]{22}';

export function registerProjectHandlers(bot: Bot, db: Database, logger: Logger): void {
  bot.callbackQuery(new RegExp(`^${PROJECT_ACTION.stepDone}${CODE}$`, 'u'), async (ctx) => {
    await ctx.answerCallbackQuery();

    const user = await findByTgId(db, ctx.from.id);
    if (!user) return;

    const stepId = fromShortId(ctx.callbackQuery.data.slice(PROJECT_ACTION.stepDone.length));
    if (stepId === undefined) return;

    const context = await outputContextOf(db, user.id);
    const texts = textsFor(context.textProfile);

    const outcome = await completeStep(db, { stepId, userId: user.id });

    if (outcome.kind === 'gone') {
      await ctx.editMessageText(texts.card.gone);
      return;
    }

    logger.info({ userId: user.id, stepId, outcome: outcome.kind }, 'Шаг проекта закрыт кнопкой');

    /**
     * Ответ говорит, что дальше, — и даёт кнопку следующему шагу.
     *
     * Без неё закрыть проект удалось бы ровно один раз: второй шаг
     * пришлось бы искать, спросив бота заново. Повторное нажатие
     * (`already`) отвечает тем же: кнопка из переписки не должна
     * выглядеть сломанной.
     */
    const next = outcome.next;

    await ctx.editMessageText(
      next === undefined ? texts.project.allStepsDone : texts.project.stepDone(next.text),
      next === undefined ? {} : { reply_markup: fitKeyboard([[...stepButtons(next, texts)]]) },
    );
  });
}
