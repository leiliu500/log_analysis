import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgent, type AppValidationContext } from './validationLifecycle.js';

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

test('completed scp agent, all phases, within SLA, no finding → success', () => {
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

test('failed agent with high finding → success (missing phases are expected)', () => {
  const v = validateAgent(
    { ...base, messageId: 'm7', status: 'failed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } },
    'high',
    50 * MIN,
    SCP,
  );
  assert.equal(v.result, 'success');
  assert.deepEqual(v.missingPhases, []); // not faulted for a failed agent
});

test('error agent with wrong finding level → failure (wrong level)', () => {
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

test('completed agent WITH an unexpected finding → failure', () => {
  const v = validateAgent(
    { ...base, messageId: 'm9', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 2 * MIN } },
    'high',
    50 * MIN,
    SCP,
  );
  assert.equal(v.result, 'failure');
  assert.match(v.delta.join(), /unexpected finding/);
});

const completedClean = {
  ...base,
  messageId: 'q',
  status: 'completed' as const,
  active: false,
  phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 2 * MIN },
};
const qf = (severity: string) => [{ id: 'f1', severity: severity as never, kind: 'anomaly', title: 'High integration latency' }];

test('completed + HIGH associated finding → completed_with_issues (not a failure)', () => {
  const v = validateAgent(completedClean, undefined, 50 * MIN, SCP, qf('high'));
  assert.equal(v.result, 'completed_with_issues');
  assert.equal(v.maxQualitySeverity, 'high');
  assert.equal(v.qualityFindings.length, 1);
  assert.deepEqual(v.delta, []); // lifecycle is clean — the finding is not a delta
});

test('completed + only INFO associated finding → success (findings still recorded)', () => {
  const v = validateAgent(completedClean, undefined, 50 * MIN, SCP, qf('info'));
  assert.equal(v.result, 'success');
  assert.equal(v.maxQualitySeverity, 'info');
  assert.equal(v.qualityFindings.length, 1);
});

test('completed + HIGH associated finding BUT missing phase → failure (delta wins)', () => {
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

test('per-app threshold: medium finding → issues when app sets qualityIssueSeverity=medium', () => {
  const ctx = { ...SCP, qualityIssueSeverity: 'medium' as const };
  const withMedium = validateAgent(completedClean, undefined, 50 * MIN, ctx, qf('medium'));
  assert.equal(withMedium.result, 'completed_with_issues');
  // default (high) threshold would keep a medium finding as success
  const defaultThreshold = validateAgent(completedClean, undefined, 50 * MIN, SCP, qf('medium'));
  assert.equal(defaultThreshold.result, 'success');
});

test('failed agent ignores quality findings (result unaffected)', () => {
  const v = validateAgent(
    { ...base, messageId: 'q2', status: 'failed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } },
    'high',
    50 * MIN,
    SCP,
    qf('critical'),
  );
  assert.equal(v.result, 'success'); // failed+high finding = correct; quality not applied
  assert.deepEqual(v.qualityFindings, []);
});
