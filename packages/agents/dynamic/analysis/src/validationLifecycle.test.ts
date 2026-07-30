import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DerivedOutcome } from '@log/shared';
import { applyAiReview, residualReason, validateAgent, type AppValidationContext } from './validationLifecycle.js';

// SCP-shaped context: REQUEST→ACK→RESPONSE, RESPONSE within 30 min of ACK.
const SCP: AppValidationContext = {
  allPhases: ['REQUEST', 'ACK', 'RESPONSE'],
  completingPhase: 'RESPONSE',
  responseTimeoutMinutes: 30,
  responseTimeoutFrom: 'ACK',
};
// apiflc-shaped context: REQUEST→RESPONSE, RESPONSE within 2 min of REQUEST.
const APIFLC: AppValidationContext = {
  allPhases: ['REQUEST', 'RESPONSE'],
  completingPhase: 'RESPONSE',
  responseTimeoutMinutes: 2,
  responseTimeoutFrom: 'REQUEST',
};

const MIN = 60_000;
const base = {
  application: 'scp',
  waitingFor: undefined as string | undefined,
  phases: ['REQUEST', 'ACK', 'RESPONSE'],
  spawnedAt: 0,
  closedAt: 100,
};

test('active agent within SLA → pending', () => {
  const v = validateAgent(
    { ...base, messageId: 'm1', status: 'awaiting', active: true, waitingFor: 'RESPONSE', phaseTs: { REQUEST: 0, ACK: 1 * MIN } },
    undefined,
    5 * MIN, // 4 min after ACK, under 30
    SCP,
  );
  assert.equal(v.result, 'pending');
  assert.equal(v.slaBreached, false);
  assert.deepEqual(v.delta, []);
});

test('active scp agent past 30m after ACK → pending but SLA-overdue', () => {
  const v = validateAgent(
    { ...base, messageId: 'm2', status: 'awaiting', active: true, waitingFor: 'RESPONSE', phaseTs: { REQUEST: 0, ACK: 1 * MIN } },
    undefined,
    40 * MIN, // 39 min after ACK, over 30
    SCP,
  );
  assert.equal(v.result, 'pending');
  assert.equal(v.slaBreached, true);
  assert.match(v.detail ?? '', /overdue/);
});

test('completed scp agent, all phases, within SLA, no anomaly → success', () => {
  const v = validateAgent(
    { ...base, messageId: 'm3', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 10 * MIN } },
    undefined,
    50 * MIN,
    SCP,
  );
  assert.equal(v.result, 'success');
  assert.deepEqual(v.missingPhases, []);
  assert.equal(v.slaBreached, false);
});

test('completed scp agent missing RESPONSE phase → failure (missing phase)', () => {
  const v = validateAgent(
    { ...base, messageId: 'm4', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } },
    undefined,
    50 * MIN,
    SCP,
  );
  assert.equal(v.result, 'failure');
  assert.deepEqual(v.missingPhases, ['RESPONSE']);
  assert.match(v.delta.join(), /missing phase/);
});

test('completed scp agent whose RESPONSE arrived after 30m → failure (SLA breach)', () => {
  const v = validateAgent(
    { ...base, messageId: 'm5', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 40 * MIN } },
    undefined,
    50 * MIN,
    SCP,
  );
  assert.equal(v.result, 'failure');
  assert.equal(v.slaBreached, true);
  assert.match(v.delta.join(), /SLA breach/);
});

test('completed apiflc agent whose RESPONSE arrived after 2m → failure (SLA breach)', () => {
  const v = validateAgent(
    { ...base, application: 'apiflc', phases: ['REQUEST', 'RESPONSE'], messageId: 'm6', status: 'completed', active: false, phaseTs: { REQUEST: 0, RESPONSE: 5 * MIN } },
    undefined,
    10 * MIN,
    APIFLC,
  );
  assert.equal(v.result, 'failure');
  assert.equal(v.slaBreached, true);
  assert.match(v.delta.join(), /SLA breach/);
});

test('failed agent with high anomaly → success (missing phases are expected)', () => {
  const v = validateAgent(
    { ...base, messageId: 'm7', status: 'failed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } },
    'high',
    50 * MIN,
    SCP,
  );
  assert.equal(v.result, 'success');
  assert.deepEqual(v.missingPhases, []); // not faulted for a failed agent
});

test('error agent with wrong anomaly level → failure (wrong level)', () => {
  const v = validateAgent(
    { ...base, messageId: 'm8', status: 'error', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } },
    'high',
    50 * MIN,
    SCP,
  );
  assert.equal(v.result, 'failure');
  assert.equal(v.expectedSeverity, 'medium');
  assert.match(v.delta.join(), /wrong level/);
});

test('completed agent WITH an unexpected anomaly → failure', () => {
  const v = validateAgent(
    { ...base, messageId: 'm9', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 2 * MIN } },
    'high',
    50 * MIN,
    SCP,
  );
  assert.equal(v.result, 'failure');
  assert.match(v.delta.join(), /unexpected anomaly/);
});

const completedClean = {
  ...base,
  messageId: 'q',
  status: 'completed' as const,
  active: false,
  phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 2 * MIN },
};
const qf = (severity: string) => [{ id: 'f1', severity: severity as never, kind: 'anomaly', title: 'High integration latency' }];

test('completed + HIGH associated anomaly → completed_with_issues (not a failure)', () => {
  const v = validateAgent(completedClean, undefined, 50 * MIN, SCP, qf('high'));
  assert.equal(v.result, 'completed_with_issues');
  assert.equal(v.maxQualitySeverity, 'high');
  assert.equal(v.qualityAnomalies.length, 1);
  assert.deepEqual(v.delta, []); // lifecycle is clean — the anomaly is not a delta
});

test('completed + only INFO associated anomaly → success (anomalies still recorded)', () => {
  const v = validateAgent(completedClean, undefined, 50 * MIN, SCP, qf('info'));
  assert.equal(v.result, 'success');
  assert.equal(v.maxQualitySeverity, 'info');
  assert.equal(v.qualityAnomalies.length, 1);
});

test('completed + HIGH associated anomaly BUT missing phase → failure (delta wins)', () => {
  const v = validateAgent(
    { ...completedClean, phaseTs: { REQUEST: 0, ACK: 1 * MIN } }, // missing RESPONSE
    undefined,
    50 * MIN,
    SCP,
    qf('critical'),
  );
  assert.equal(v.result, 'failure');
  assert.match(v.delta.join(), /missing phase/);
});

test('per-app threshold: medium anomaly → issues when app sets qualityIssueSeverity=medium', () => {
  const ctx = { ...SCP, qualityIssueSeverity: 'medium' as const };
  const withMedium = validateAgent(completedClean, undefined, 50 * MIN, ctx, qf('medium'));
  assert.equal(withMedium.result, 'completed_with_issues');
  // default (high) threshold would keep a medium anomaly as success
  const defaultThreshold = validateAgent(completedClean, undefined, 50 * MIN, SCP, qf('medium'));
  assert.equal(defaultThreshold.result, 'success');
});

test('failed agent ignores quality anomalies (result unaffected)', () => {
  const v = validateAgent(
    { ...base, messageId: 'q2', status: 'failed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } },
    'high',
    50 * MIN,
    SCP,
    qf('critical'),
  );
  assert.equal(v.result, 'success'); // failed+high anomaly = correct; quality not applied
  assert.deepEqual(v.qualityAnomalies, []);
});

// ---------------------------------------------------------------------------
// The validation AI stage. These lock the two properties that make an LLM safe
// here: it is only ever consulted about transactions nothing was proven for, and
// what it says can never overturn something that was.
// ---------------------------------------------------------------------------

const closedClean = { ...base, messageId: 'r1', status: 'completed' as const, active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 2 * MIN } };
const unknownOutcome: DerivedOutcome = { status: 'unknown', evidenceLogIds: ['l1'], phasesSeen: ['REQUEST'], detail: 'no RESPONSE phase in logs' };
const provenOutcome: DerivedOutcome = { status: 'completed', evidenceLogIds: ['l1'], phasesSeen: ['REQUEST', 'ACK', 'RESPONSE'], detail: 'RESPONSE present with a success code' };

test('residual: a clean success whose outcome the logs do NOT prove is reviewable', () => {
  const v = validateAgent(closedClean, undefined, 50 * MIN, SCP, [], unknownOutcome);
  assert.equal(v.result, 'success');
  assert.match(residualReason(v, unknownOutcome) ?? '', /do not prove a terminal outcome/);
});

test('residual: a proven-outcome clean pass is still reviewable under the default scope', () => {
  // Superseded by the explicit scope tests below: a positively-derived outcome only ends
  // the review under scope='unproven'. The default reviews every deterministically-clean
  // transaction, because that is where a business failure behind a 200 actually lives.
  const v = validateAgent(closedClean, undefined, 50 * MIN, SCP, [], provenOutcome);
  assert.match(residualReason(v, provenOutcome, 'clean') ?? '', /every deterministic check passed/);
});

test('not residual: a transaction with a deterministic delta is never reopened by the AI', () => {
  // Logs show a failure the agent recorded as completed → a hard deterministic failure.
  const failedByLogs: DerivedOutcome = { status: 'failed', evidenceLogIds: ['l1'], phasesSeen: ['REQUEST'], detail: 'a phase carried a failure ackCode' };
  const v = validateAgent(closedClean, undefined, 50 * MIN, SCP, [], failedByLogs);
  assert.equal(v.result, 'failure');
  assert.equal(residualReason(v, failedByLogs), null, 'the AI is never asked about a proven verdict');
});

test('not residual: an active (pending) transaction is never reviewed', () => {
  const v = validateAgent(
    { ...base, messageId: 'r2', status: 'awaiting', active: true, waitingFor: 'RESPONSE', phaseTs: { REQUEST: 0, ACK: 1 * MIN } },
    undefined,
    5 * MIN,
    SCP,
  );
  assert.equal(residualReason(v, undefined), null);
});

test('applyAiReview relabels a residual success without touching the deterministic delta', () => {
  const v = validateAgent(closedClean, undefined, 50 * MIN, SCP, [], unknownOutcome);
  applyAiReview(
    v,
    {
      findings: [
        { kind: 'business-failure', title: 'gateway 200 over an ACCOUNT_FROZEN body', severity: 'high', evidenceLogIds: ['l1'], verifiedPredicates: 2, predicates: [{ logId: 'l1', field: 'raw', op: 'contains', value: 'x' }] },
      ],
      rejected: [{ title: 'fabricated', reason: 'cites unknown logId l9' }],
    },
    99 * MIN,
  );
  assert.equal(v.result, 'ai_suspected', 'surfaced as its own population, never as a failure');
  assert.deepEqual(v.delta, [], 'the deterministic evidence trail is untouched');
  assert.equal(v.aiFindings.length, 1);
  assert.equal(v.aiRejected, 1, 'discarded claims stay countable');
  assert.equal(v.aiReviewedAt, 99 * MIN);
});

test('applyAiReview with no admitted findings leaves the deterministic result intact', () => {
  const v = validateAgent(closedClean, undefined, 50 * MIN, SCP, [], unknownOutcome);
  applyAiReview(v, { findings: [], rejected: [{ title: 'hallucinated', reason: 'predicate failed' }] }, 99 * MIN);
  assert.equal(v.result, 'success');
  assert.equal(v.aiRejected, 1, 'a review that produced only hallucinations is still visible');
});

test('scope=clean: a proven-outcome clean pass IS reviewed (business failures live here)', () => {
  const v = validateAgent(closedClean, undefined, 50 * MIN, SCP, [], provenOutcome);
  assert.equal(v.result, 'success');
  assert.match(residualReason(v, provenOutcome, 'clean') ?? '', /outcome was derived as completed/);
});

test('scope=unproven: the narrow gate still skips a proven outcome', () => {
  const v = validateAgent(closedClean, undefined, 50 * MIN, SCP, [], provenOutcome);
  assert.equal(residualReason(v, provenOutcome, 'unproven'), null);
});

test('neither scope ever shows the agent a transaction carrying a delta', () => {
  const failedByLogs: DerivedOutcome = { status: 'failed', evidenceLogIds: ['l1'], phasesSeen: ['REQUEST'], detail: 'a phase carried a failure ackCode' };
  const v = validateAgent(closedClean, undefined, 50 * MIN, SCP, [], failedByLogs);
  assert.equal(v.result, 'failure');
  for (const scope of ['clean', 'unproven'] as const) {
    assert.equal(residualReason(v, failedByLogs, scope), null, `scope=${scope} must not reopen a proven verdict`);
  }
});

test('a FAILED review is not marked reviewed — it stays retryable and is not clean', () => {
  const v = validateAgent(closedClean, undefined, 50 * MIN, SCP, [], unknownOutcome);
  applyAiReview(v, { findings: [], rejected: [], error: 'model returned an empty reply' }, 99 * MIN);
  assert.equal(v.aiReviewedAt, undefined, 'not marked reviewed, so the next poll retries it');
  assert.match(v.aiError ?? '', /empty reply/);
  assert.equal(v.result, 'success', 'a failed review never changes the deterministic result');
});

test('a review that salvaged findings despite an error is still recorded', () => {
  const v = validateAgent(closedClean, undefined, 50 * MIN, SCP, [], unknownOutcome);
  applyAiReview(
    v,
    { findings: [{ kind: 'k', title: 'partial but verified', severity: 'high', evidenceLogIds: ['l1'], verifiedPredicates: 1, predicates: [{ logId: 'l1', field: 'raw', op: 'contains', value: 'x' }] }], rejected: [], error: 'reply truncated' },
    99 * MIN,
  );
  assert.equal(v.aiReviewedAt, 99 * MIN);
  assert.equal(v.result, 'ai_suspected');
});

test('a FAILED transaction is never reviewed — it was already flagged, not passed', () => {
  const failedAgent = { ...base, messageId: 'f1', status: 'failed' as const, active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } };
  const v = validateAgent(failedAgent, 'high', 50 * MIN, SCP, [], unknownOutcome);
  assert.equal(v.result, 'success', 'the worker correctly validated a failed agent carrying its high anomaly');
  assert.equal(residualReason(v, unknownOutcome, 'clean'), null, 'but it is not part of the false-negative population');
});

test('a TIMED-OUT transaction is never reviewed either', () => {
  const timedOut = { ...base, messageId: 'f2', status: 'error' as const, active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } };
  const v = validateAgent(timedOut, 'medium', 50 * MIN, SCP, [], unknownOutcome);
  assert.equal(v.result, 'success');
  assert.equal(residualReason(v, unknownOutcome, 'clean'), null);
});

test('a COMPLETED transaction that passed without proof is still reviewed', () => {
  const v = validateAgent(closedClean, undefined, 50 * MIN, SCP, [], unknownOutcome);
  assert.ok(residualReason(v, unknownOutcome, 'clean'), 'the false-negative population is transactions that claim they worked');
});
