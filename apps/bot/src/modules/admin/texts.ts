import { eq } from 'drizzle-orm';

import { textOverrides } from '../../db/schema.js';
import type { Executor } from '../../infra/db.js';
import { defaultTexts } from '../../texts/index.js';
import { editableReplies, NOT_EDITABLE, refusalFor } from '../../texts/rules.js';

/**
 * Реплики бота для панели (§13.9, задача 4.13).
 *
 * §13.9 требует менять тексты **без выкладки новой версии**. Отсюда
 * панель берёт список реплик, сюда же пишет правки — и здесь же стоит
 * §13-проверка, потому что правка попадает людям сразу, минуя прогон и
 * чужой взгляд.
 */

/** Одна реплика на экране редактора. */
export interface TextRow {
  readonly path: string;
  /** Как говорит бот сейчас: правка, если она есть, иначе слова из кода. */
  readonly said: string;
  /** Слова из кода — чтобы видеть, что именно заменено. */
  readonly fromCode: string;
  /** Правлена ли из панели. */
  readonly edited: boolean;
  /** Сколько значений подставляется: `{1}`, `{2}` и так далее. */
  readonly places: number;
  readonly updatedAt?: string | undefined;
  readonly updatedBy?: string | undefined;
}

export interface TextsView {
  readonly rows: readonly TextRow[];
  /**
   * Реплики, которых редактор не показывает, — с причиной у каждой.
   *
   * Названы вслух нарочно: «в списке чего-то нет» человек читает как
   * потерю, если причина не рядом.
   */
  readonly hidden: readonly { readonly path: string; readonly why: string }[];
}

/** Что бот говорит сейчас и что правлено из панели. */
export async function textsView(db: Executor): Promise<TextsView> {
  const saved = await db
    .select({
      path: textOverrides.path,
      value: textOverrides.value,
      updatedAt: textOverrides.updatedAt,
      updatedBy: textOverrides.updatedBy,
    })
    .from(textOverrides);

  const byPath = new Map(saved.map((row) => [row.path, row]));

  /**
   * Каталог берётся из **кода**, а не из склеенного словаря.
   *
   * Число подстановок — свойство кодовой реплики, и спрашивать его у
   * правленой значило бы спрашивать у обёртки. Эта ловушка уже
   * срабатывала: правленая реплика выглядела простой, и следующая правка
   * с `{1}` отвергалась словами «нечего подставлять» — человек не мог
   * поправить то, что сам же и поправил.
   */
  const rows = editableReplies(defaultTexts).map((reply): TextRow => {
    const override = byPath.get(reply.path);

    return {
      path: reply.path,
      said: override?.value ?? reply.said,
      fromCode: reply.said,
      edited: override !== undefined,
      places: reply.places,
      ...(override === undefined ? {} : { updatedAt: override.updatedAt.toISOString() }),
      ...(override?.updatedBy == null ? {} : { updatedBy: override.updatedBy }),
    };
  });

  return {
    rows,
    hidden: [...NOT_EDITABLE].map(([path, why]) => ({ path, why })),
  };
}

/** Чем кончилась попытка сохранить правку. */
export type SaveOutcome =
  { readonly ok: true; readonly reset: boolean } | { readonly ok: false; readonly why: string };

/**
 * Сохранить правку реплики — или вернуть её к словам из кода.
 *
 * **Проверка стоит здесь, а не в панели.** Панель можно обойти запросом,
 * а таблицу — рукой в базе; но всё, что проходит этой дорогой, обязано
 * соблюдать §13. Иначе реплика с двумя вопросами уедет человеку молча, и
 * узнаем мы об этом по жалобе.
 *
 * Пустая правка означает «вернуть как в коде»: отдельного действия для
 * этого не нужно, а строка в таблице без нужды не залежится.
 */
export async function saveText(
  db: Executor,
  params: { readonly path: string; readonly said: string; readonly by: string },
): Promise<SaveOutcome> {
  const reply = editableReplies(defaultTexts).find((one) => one.path === params.path);

  if (reply === undefined) {
    const hidden = NOT_EDITABLE.get(params.path);

    return {
      ok: false,
      why:
        hidden === undefined
          ? `Такой реплики нет: «${params.path}».`
          : `Эту реплику из панели не правят: ${hidden}.`,
    };
  }

  if (params.said.trim() === '') {
    await db.delete(textOverrides).where(eq(textOverrides.path, params.path));

    return { ok: true, reset: true };
  }

  const refusal = refusalFor(params.said, reply.places);

  if (refusal !== undefined) return { ok: false, why: refusal };

  await db
    .insert(textOverrides)
    .values({ path: params.path, value: params.said, updatedBy: params.by })
    .onConflictDoUpdate({
      target: textOverrides.path,
      set: { value: params.said, updatedBy: params.by, updatedAt: new Date() },
    });

  return { ok: true, reset: false };
}
