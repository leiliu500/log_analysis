import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrompt } from '@log/shared';

test('analysis prompt reasons through ordered exception stacks to the final logged root cause', () => {
  const prompt = loadPrompt('analysis/reason.md');

  assert.match(prompt, /sequence or stack of\s+errors, exceptions, warnings/i);
  assert.match(prompt, /reason\s+through that stack in the logged order/i);
  assert.match(prompt, /deepest\s+\/\s+final non-frame error message/i);
  assert.match(prompt, /logged root cause\s+error/i);
});

test('analysis prompt does not hard-code one cause-chain phrase', () => {
  const prompt = loadPrompt('analysis/reason.md');

  assert.doesNotMatch(prompt, /Caused by:/i);
});
