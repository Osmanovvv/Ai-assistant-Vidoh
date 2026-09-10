import { and, eq, isNull, sql } from 'drizzle-orm';

import { modelEnvSchema } from '../config/env.js';
import { items } from '../db/schema.js';
import { closeDb, getDb } from '../infra/db.js';
import { createLogger } from '../infra/logger.js';
import { createEmbeddingProvider } from '../modules/embedder/providers/factory.js';
import { reembedItem } from '../modules/embedder/reembed.js';
import { createRunGuard } from '../modules/metering/run-guard.js';

/**
 * Досчёт векторов у записей, оставшихся без них (задача 2.9).
 *
 * План обещает досчёт дословно: «понадобится досчёт»
 * (`docs/03-plan-razrabotki.md:986`). Его не было, и запись, у которой
 * вектор не посчитался при создании, оставалась без него **навсегда**:
 * смысловой источник кандидатов §7.2 отбирает только `embedding is not
 * null`, а починить это было нечем. Родиться такая может, когда вектор
 * упал, а классификация прошла: недоступность провайдера, перейдённый
 * потолок расхода, оборванная сеть.
 *
 * **Руками, а не автоматом, и это решение, а не лень.** Досчёт — платный
 * вызов на каждую запись, и запускать его сам продукт не должен: чинить
 * последствия чужого простоя за деньги заказчицы без её ведома нельзя.
 * Скрипт сперва показывает, сколько записей и во сколько это обойдётся,
 * и считает только по явной просьбе.
 *
 * Запуск:
 *   DATABASE_URL=… npx tsx src/scripts/backfill-embeddings.ts            — только счёт
 *   DATABASE_URL=… AI_PROVIDER=… npx tsx src/scripts/backfill-embeddings.ts --fill [сколько]
 *
 * После массового досчёта нужен `ANALYZE items` — это в плане 2.9
 * записано: планировщик Postgres иначе продолжит считать колонку пустой.
 */

const FILL = process.argv.includes('--fill');

/** Сколько записей брать за раз. Досчёт можно продолжить следующим заходом. */
const limitArg = process.argv.find((one) => /^\d+$/u.test(one));
const LIMIT = limitArg === undefined ? 200 : Number(limitArg);

const db = getDb();
const logger = createLogger({ level: 'warn' });

try {
  /**
   * Черновики не считаем: они не участвуют в выдаче вовсе, а вектор у
   * них стоил бы столько же. Ушедшие в архив — тоже.
   */
  const pending = await db
    .select({ id: items.id, text: items.text, userId: items.userId })
    .from(items)
    .where(and(isNull(items.embedding), eq(items.isDraft, false)))
    .orderBy(items.createdAt)
    .limit(LIMIT);

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(items)
    .where(and(isNull(items.embedding), eq(items.isDraft, false)));

  const total = counted?.total ?? 0;

  process.stdout.write(
    `Записей без вектора: ${String(total)}. Взято в этот заход: ${String(pending.length)}.\n`,
  );

  if (!FILL) {
    process.stdout.write(
      'Это только счёт. Чтобы досчитать, добавьте --fill: это платные вызовы.\n',
    );
  } else if (pending.length === 0) {
    process.stdout.write('Досчитывать нечего.\n');
  } else {
    const env = modelEnvSchema.parse(process.env);
    const provider = createEmbeddingProvider(env);

    // Потолок расхода — тот же, что у бота: скрипт тратит те же деньги.
    const guard = createRunGuard({ db, env, logger, startedAt: new Date() });

    const stop = await guard.checkBefore();
    if (stop !== undefined) {
      process.stderr.write(`${stop}\n`);
      process.exitCode = 1;
    } else {
      let done = 0;
      let failed = 0;

      for (const item of pending) {
        const ok = await reembedItem(
          { db, provider, spendGuard: guard.spendGuard, logger },
          { itemId: item.id, text: item.text, userId: item.userId },
        );

        if (ok) done++;
        else failed++;
      }

      process.stdout.write(
        `Досчитано: ${String(done)}, не вышло: ${String(failed)}.\n` +
          (done > 0
            ? 'Не забудьте ANALYZE items — иначе планировщик считает колонку пустой.\n'
            : ''),
      );

      process.stdout.write(
        String.fromCharCode(10) + (await guard.costReport()) + String.fromCharCode(10),
      );
    }
  }
} finally {
  await closeDb();
}
