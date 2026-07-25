import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFromSpec, type TransitionDecision } from './ingestionAgent.js';

const SPEC = 'apps/scp/transaction.md'; // a real spec so loadPrompt resolves

test('decideFromSpec loads the app spec, appends the JSON contract, and normalizes', async () => {
  let sawSystem = '';
  let sawUser = '';
  const reason = async (system: string, user: string): Promise<Partial<TransitionDecision>> => {
    sawSystem = system;
    sawUser = user;
    return { status: 'completed', detail: 'done' };
  };
  const d = await decideFromSpec(SPEC, 'EVIDENCE-MARKER', reason);
  assert.equal(d?.status, 'completed');
  assert.ok(sawSystem.length > 0, 'the transaction.md spec is the system prompt');
  assert.match(sawUser, /EVIDENCE-MARKER/); // the app-built evidence is passed through
  assert.match(sawUser, /Respond ONLY with JSON/); // the shared response contract is appended
});

test('decideFromSpec defaults severity by status (failed ⇒ high)', async () => {
  const d = await decideFromSpec(SPEC, 'x', async () => ({ status: 'failed', detail: 'bad ack' }));
  assert.equal(d?.severity, 'high');
});

test('decideFromSpec returns null on a model error (caller defers, no fallback)', async () => {
  const d = await decideFromSpec(SPEC, 'x', async () => {
    throw new Error('bedrock down');
  });
  assert.equal(d, null);
});

test('decideFromSpec returns null when the app declares no spec', async () => {
  const d = await decideFromSpec(undefined, 'x', async () => ({ status: 'completed', detail: 'x' }));
  assert.equal(d, null);
});

test('decideFromSpec returns null on an invalid model status', async () => {
  const d = await decideFromSpec(SPEC, 'x', async () => ({ status: 'bogus' as TransitionDecision['status'], detail: 'x' }));
  assert.equal(d, null);
});
