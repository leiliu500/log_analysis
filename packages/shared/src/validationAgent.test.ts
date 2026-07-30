import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeParsedLog, resetLogIds } from './backtest.js';
import {
  admitClaims,
  evaluatePredicate,
  reviewFromSpec,
  type ValidationAgentInput,
  type ValidationClaim,
} from './validationAgent.js';

/**
 * The admission gate is the whole safety argument for putting a model in the validation
 * path, so it is tested the way the deterministic engine is: as code, with no model in
 * the loop. Each case is one way a hallucination reaches the gate — a fabricated log id,
 * an inexact quote, an unwitnessed assertion — and asserts it is DISCARDED rather than
 * recorded. What survives is only ever a claim whose every citation and predicate was
 * re-executed against the real log rows.
 */

resetLogIds();
const REQ = makeParsedLog('apiflc-handler', 1_000, 'REQUEST correlationID=abc-123 amount=500', 'log-req');
const RES = makeParsedLog('apiflc-gateway', 5_000, 'Method completed with status: 200 body={"error":"ACCOUNT_FROZEN"}', 'log-res');
const LOGS = [REQ, RES];

const claim = (over: Partial<ValidationClaim> = {}): ValidationClaim => ({
  kind: 'business-failure-behind-2xx',
  title: 'The gateway returned 200 over a body reporting ACCOUNT_FROZEN',
  severity: 'high',
  evidenceLogIds: ['log-res'],
  predicates: [{ logId: 'log-res', field: 'raw', op: 'contains', value: 'ACCOUNT_FROZEN' }],
  ...over,
});

test('admits a claim whose citations and predicates all re-verify', () => {
  const out = admitClaims([claim()], LOGS);
  assert.equal(out.rejected.length, 0);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0]!.verifiedPredicates, 1);
  assert.deepEqual(out.findings[0]!.evidenceLogIds, ['log-res']);
});

test('discards a claim citing a log id that does not exist (fabricated evidence)', () => {
  const out = admitClaims([claim({ evidenceLogIds: ['log-does-not-exist'], predicates: [{ logId: 'log-does-not-exist', field: 'raw', op: 'contains', value: 'ACCOUNT_FROZEN' }] })], LOGS);
  assert.equal(out.findings.length, 0);
  assert.match(out.rejected[0]!.reason, /unknown logId/);
});

test('discards a claim whose quoted value is not actually in the cited line (inexact quote)', () => {
  const out = admitClaims([claim({ predicates: [{ logId: 'log-res', field: 'raw', op: 'contains', value: 'ACCOUNT_CLOSED' }] })], LOGS);
  assert.equal(out.findings.length, 0);
  assert.match(out.rejected[0]!.reason, /predicate failed/);
});

test('discards a claim with no witness (no predicates) — an assertion is not evidence', () => {
  const out = admitClaims([claim({ predicates: [] })], LOGS);
  assert.equal(out.findings.length, 0);
  assert.match(out.rejected[0]!.reason, /no verifiable predicate/);
});

test('discards a claim whose predicate tests a log it did not cite as evidence', () => {
  const out = admitClaims([claim({ evidenceLogIds: ['log-res'], predicates: [{ logId: 'log-req', field: 'raw', op: 'contains', value: 'REQUEST' }] })], LOGS);
  assert.equal(out.findings.length, 0);
  assert.match(out.rejected[0]!.reason, /not cited as evidence/);
});

test('a claim is all-or-nothing: one failing predicate discards the whole claim', () => {
  const out = admitClaims(
    [
      claim({
        predicates: [
          { logId: 'log-res', field: 'raw', op: 'contains', value: 'ACCOUNT_FROZEN' },
          { logId: 'log-res', field: 'raw', op: 'contains', value: 'status: 500' },
        ],
      }),
    ],
    LOGS,
  );
  assert.equal(out.findings.length, 0);
  assert.equal(out.rejected.length, 1);
});

test('admits the good claims and discards the bad ones from the same reply', () => {
  const out = admitClaims([claim(), claim({ title: 'fabricated', evidenceLogIds: ['nope'], predicates: [{ logId: 'nope', field: 'raw', op: 'contains', value: 'x' }] })], LOGS);
  assert.equal(out.findings.length, 1);
  assert.equal(out.rejected.length, 1);
});

test('evaluatePredicate: every operator only ever passes on positive proof', () => {
  assert.equal(evaluatePredicate({ logId: 'log-res', field: 'raw', op: 'contains', value: 'status: 200' }, RES), true);
  assert.equal(evaluatePredicate({ logId: 'log-res', field: 'raw', op: 'not_contains', value: 'status: 500' }, RES), true);
  assert.equal(evaluatePredicate({ logId: 'log-res', field: 'stream', op: 'equals', value: 'apiflc-gateway' }, RES), true);
  assert.equal(evaluatePredicate({ logId: 'log-res', field: 'raw', op: 'matches', value: 'status:\\s*2\\d\\d' }, RES), true);
  assert.equal(evaluatePredicate({ logId: 'log-res', field: 'timestamp', op: 'gt', value: '1000' }, RES), true);
  // Anything the gate cannot decide is FALSE, never true.
  assert.equal(evaluatePredicate({ logId: 'log-res', field: 'raw', op: 'matches', value: '([a-z+' }, RES), false, 'uncompilable regex proves nothing');
  assert.equal(evaluatePredicate({ logId: 'log-res', field: 'timestamp', op: 'lt', value: 'soon' }, RES), false, 'non-numeric comparison proves nothing');
  assert.equal(evaluatePredicate({ logId: 'log-res', field: 'raw', op: 'contains', value: '' }, RES), false, 'an empty value proves nothing');
});

const input = (): ValidationAgentInput => ({
  messageId: 'abc-123',
  application: 'apiflc',
  agentStatus: 'completed',
  relatedLogs: LOGS,
  deterministicResult: 'success',
  deterministicDetail: 'phases complete within SLA; no anomaly expected',
  residualReason: 'the logs do not prove a terminal outcome',
  phases: ['REQUEST', 'RESPONSE'],
  phaseTs: { REQUEST: 1_000, RESPONSE: 5_000 },
});

const reply = (claims: ValidationClaim[]): string => JSON.stringify({ claims });

test('reviewFromSpec sends the app spec as the system prompt and gates the reply', async () => {
  let sawSystem = '';
  let sawUser = '';
  const out = await reviewFromSpec('apps/apiflc/validation.agent.md', 'EVIDENCE-MARKER', input(), async (system, user) => {
    sawSystem = system;
    sawUser = user;
    return reply([claim()]);
  });
  assert.ok(sawSystem.length > 0, "the app's validation.agent.md is the system prompt");
  assert.match(sawUser, /EVIDENCE-MARKER/, 'the app-built evidence is passed through');
  assert.match(sawUser, /RE-EXECUTED/, 'the reply contract tells the model its claims are re-verified');
  assert.equal(out.findings.length, 1);
  assert.equal(out.error, undefined);
});

/**
 * The failure modes observed in production. Each one must be DISTINGUISHABLE from a clean
 * review: a model that never answered is not a model that found nothing, and recording it
 * as the latter is a false negative wearing the costume of reassurance.
 */

test('a model error is reported as an error, not as a clean review', async () => {
  const out = await reviewFromSpec('apps/apiflc/validation.agent.md', 'e', input(), async () => {
    throw new Error('bedrock exploded');
  });
  assert.equal(out.findings.length, 0);
  assert.match(out.error ?? '', /bedrock exploded/);
});

test('an empty reply (reasoning burned the whole budget) is an error, not a clean review', async () => {
  const out = await reviewFromSpec('apps/apiflc/validation.agent.md', 'e', input(), async () => '   ');
  assert.match(out.error ?? '', /empty reply/);
});

test('a TRUNCATED reply still yields its complete claims (the prod failure)', async () => {
  // Exactly the shape that failed in prod: valid JSON cut off mid-string in the last claim.
  const truncated = `{"claims":[${JSON.stringify(claim())},{"kind":"other","title":"cut off here`;
  const out = await reviewFromSpec('apps/apiflc/validation.agent.md', 'e', input(), async () => truncated);
  assert.equal(out.findings.length, 1, 'the complete claim ahead of the cut is recovered');
  assert.equal(out.error, undefined, 'a salvage that produced findings is not an error');
});

test('a truncated reply that yields NOTHING is flagged, not passed off as clean', async () => {
  const out = await reviewFromSpec('apps/apiflc/validation.agent.md', 'e', input(), async () => '{"claims":[{"title":"cut');
  assert.equal(out.findings.length, 0);
  assert.match(out.error ?? '', /truncated/);
});

test('salvaged claims are still gated — truncation cannot smuggle one past re-verification', async () => {
  const bad = claim({ evidenceLogIds: ['log-fabricated'], predicates: [{ logId: 'log-fabricated', field: 'raw', op: 'contains', value: 'x' }] });
  const out = await reviewFromSpec('apps/apiflc/validation.agent.md', 'e', input(), async () => `{"claims":[${JSON.stringify(bad)},{"title":"cut`);
  assert.equal(out.findings.length, 0);
  assert.equal(out.rejected.length, 1);
});

test('a fenced reply is unwrapped rather than treated as unparseable', async () => {
  const out = await reviewFromSpec('apps/apiflc/validation.agent.md', 'e', input(), async () => '```json\n' + reply([claim()]) + '\n```');
  assert.equal(out.findings.length, 1);
});

test('reviewFromSpec with a missing spec reviews nothing rather than improvising', async () => {
  let called = false;
  const out = await reviewFromSpec('apps/nope/validation.agent.md', 'e', input(), async () => {
    called = true;
    return reply([claim()]);
  });
  assert.equal(called, false);
  assert.equal(out.findings.length, 0);
});
