import { beforeEach, describe, expect, it } from 'vitest';

import { testDb } from '../test/db.js';
import type { AiClientDeps } from '../modules/ai/client.js';
import { PromptRegistry } from '../modules/ai/prompts/registry.js';
import { activatePrompt, seedPrompt } from '../modules/ai/prompts/seed.js';
import { MockLlmProvider } from '../modules/ai/providers/mock.js';
import { RESOLVER_SCHEMA_NAME } from '../modules/ai/schemas/index.js';
import { resolverCaseSchema } from './resolver-dataset.js';
import { runResolverCase } from './resolver-runner.js';

/**
 * Прогонщик стенда передаёт разговор случая резолверу (план docs/26,
 * задача 2), а с `withoutDialog` — нет: так на том же наборе меряется
 * «как сейчас», и повтор по прежней плёнке сходится без промахов.
 */

const item = resolverCaseSchema.parse({
  id: 'd03',
  note: 'n',
  segment: 'посылку давай на субботу',
  now: '2026-09-23T13:20:00.000Z',
  dialog: [{ role: 'bot', text: 'Через 30 минут: Забрать посылки с Вайлдберриз', minutesAgo: 1 }],
  candidates: [
    { text: 'Забрать посылку', updatedMinutesAgo: 6 },
    { text: 'Забрать посылки с Вайлдберриз', updatedMinutesAgo: 1440 },
  ],
  expected: { kind: 'apply', target: 2 },
});

let provider: MockLlmProvider;
let deps: AiClientDeps;

beforeEach(async () => {
  await seedPrompt(testDb(), {
    stage: 'resolver',
    version: 'resolver@test',
    prompt: 'реши, о какой записи речь',
    schemaName: RESOLVER_SCHEMA_NAME,
  });
  await activatePrompt(testDb(), 'resolver', 'resolver@test');

  provider = new MockLlmProvider({
    respond: () =>
      JSON.stringify({
        action: 'update',
        mode: 'replace',
        itemId: '2',
        confidence: 0.9,
        changes: {
          note: '',
          text: '',
          deadline: '2026-09-26',
          deadlineAccuracy: 'day',
          recurrenceKind: 'none',
          recurrenceInterval: 0,
          recurrenceText: '',
        },
        reason: 'про посылки с ВБ',
      }),
  });
  deps = {
    db: testDb(),
    provider,
    prompts: new PromptRegistry(testDb()),
    retry: { attempts: 1, sleep: () => Promise.resolve() },
  };
});

describe('прогонщик и разговор случая', () => {
  it('разговор случая доходит до входа модели', async () => {
    await runResolverCase(deps, item);

    expect(provider.requests[0]?.input).toContain(
      'Бот (1 мин назад): Через 30 минут: Забрать посылки с Вайлдберриз',
    );
  });

  it('без разговора (замер «как сейчас») — блока нет', async () => {
    await runResolverCase(deps, item, { withoutDialog: true });

    expect(provider.requests[0]?.input).not.toContain('Недавний разговор');
    expect(provider.requests[0]?.input).not.toContain('Вайлдберриз»');
  });
});
