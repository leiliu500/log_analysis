import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrompt } from '@log/shared';
import { applicationRegistry } from './index.js';

/**
 * Consistency guard: every prompt an application declares by path must actually
 * resolve at runtime. This keeps each app's own prompts — the regular-agent
 * `transaction.md`, the `validation.md`, plus the Log-Assistant / Simulator
 * prompts — wired and separate per app, and fails loudly on a typo or a moved
 * file instead of shipping a dangling reference into the Lambda / API image.
 */

/** All prompt paths an ApplicationDef can declare, labelled for a readable failure. */
function declaredPromptPaths(app: ReturnType<typeof applicationRegistry.all>[number]) {
  return [
    ['transactionPromptPath', app.transactionPromptPath],
    ['validation.promptPath', app.validation?.promptPath],
    ['assistantPromptPath', app.assistantPromptPath],
    ['simulateUnderstandingPromptPath', app.simulateUnderstandingPromptPath],
  ] as const;
}

for (const app of applicationRegistry.all()) {
  for (const [field, path] of declaredPromptPaths(app)) {
    if (!path) continue; // optional — only assert the ones this app declares
    test(`${app.id}: ${field} (${path}) loads`, () => {
      const body = loadPrompt(path);
      assert.ok(body.length > 0, `${path} is empty`);
    });
  }
}

test('scp and apiflc each declare their own transaction + validation prompts', () => {
  for (const id of ['scp', 'apiflc']) {
    const app = applicationRegistry.byId(id);
    assert.ok(app, `application ${id} is registered`);
    assert.ok(app!.transactionPromptPath?.includes(`apps/${id}/transaction.md`), `${id} has its own transaction.md`);
    assert.ok(app!.validation?.promptPath.includes(`apps/${id}/validation.md`), `${id} has its own validation.md`);
  }
});
