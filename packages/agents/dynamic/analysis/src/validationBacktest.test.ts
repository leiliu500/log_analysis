import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DerivedOutcome } from '@log/shared';
import { runBacktest, type GoldCase } from './validationBacktest.js';
import type { AppValidationContext } from './validationLifecycle.js';

const MIN = 60_000;
const SCP: AppValidationContext = {
  allPhases: ['REQUEST', 'ACK', 'RESPONSE'],
  completingPhase: 'RESPONSE',
  responseTimeoutMinutes: 30,
  responseTimeoutFrom: 'ACK',
};
const APIFLC: AppValidationContext = {
  allPhases: ['REQUEST', 'RESPONSE'],
  completingPhase: 'RESPONSE',
  responseTimeoutMinutes: 2,
  responseTimeoutFrom: 'REQUEST',
};

const scpAgent = (over: Record<string, unknown>) => ({
  application: 'scp',
  phases: ['REQUEST', 'ACK', 'RESPONSE'],
  spawnedAt: 0,
  closedAt: 100,
  waitingFor: undefined as string | undefined,
  ...over,
}) as GoldCase['agent'];
const apiflcAgent = (over: Record<string, unknown>) => ({
  application: 'apiflc',
  phases: ['REQUEST', 'RESPONSE'],
  spawnedAt: 0,
  closedAt: 100,
  waitingFor: undefined as string | undefined,
  ...over,
}) as GoldCase['agent'];

const derived = (o: Partial<DerivedOutcome> & Pick<DerivedOutcome, 'status'>): DerivedOutcome => ({
  evidenceLogIds: ['e1'],
  phasesSeen: [],
  windowComplete: true,
  ...o,
});

/**
 * The hand-labelled gold set. Each case pairs an engine input with the outcome a
 * human confirmed is correct. Grouped by the failure mode it protects against.
 */
const GOLD: GoldCase[] = [
  // ---- clean/negative class: the engine must NOT surface a problem (guards FP) ----
  {
    name: 'scp completed, all phases, within SLA, logs agree → success',
    app: 'scp',
    agent: scpAgent({ messageId: 'g1', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 3 * MIN } }),
    now: 50 * MIN,
    ctx: SCP,
    derived: derived({ status: 'completed', phasesSeen: ['REQUEST', 'ACK', 'RESPONSE'] }),
    expected: 'success',
  },
  {
    name: 'scp failed, high finding present → success',
    app: 'scp',
    agent: scpAgent({ messageId: 'g2', status: 'failed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } }),
    findingSeverity: 'high',
    now: 50 * MIN,
    ctx: SCP,
    derived: derived({ status: 'failed', phasesSeen: ['REQUEST', 'ACK'] }),
    expected: 'success',
  },
  {
    name: 'scp completed + only info quality finding → success (suppressed, below threshold)',
    app: 'scp',
    agent: scpAgent({ messageId: 'g3', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 2 * MIN } }),
    now: 50 * MIN,
    ctx: SCP,
    qualityFindings: [{ id: 'f', severity: 'info', kind: 'anomaly', title: 'minor' }],
    derived: derived({ status: 'completed', phasesSeen: ['REQUEST', 'ACK', 'RESPONSE'] }),
    expected: 'success',
  },
  {
    name: 'scp completed, logs rolled off window (unknown) → success (absence never faults)',
    app: 'scp',
    agent: scpAgent({ messageId: 'g4', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 2 * MIN } }),
    now: 50 * MIN,
    ctx: SCP,
    derived: derived({ status: 'unknown', phasesSeen: [], evidenceLogIds: [], windowComplete: false }),
    expected: 'success',
  },
  {
    name: 'apiflc completed, gateway HTTP 200 → success',
    app: 'apiflc',
    agent: apiflcAgent({ messageId: 'g5', status: 'completed', active: false, phaseTs: { REQUEST: 0, RESPONSE: 1 * MIN } }),
    now: 10 * MIN,
    ctx: APIFLC,
    derived: derived({ status: 'completed', phasesSeen: ['REQUEST', 'RESPONSE'], detail: 'gateway HTTP 200' }),
    expected: 'success',
  },

  // ---- problem/positive class: the engine MUST surface a problem (guards FN) ----
  {
    name: 'scp completed but logs show a FAILED outcome → failure (hallucinated success / false positive)',
    app: 'scp',
    agent: scpAgent({ messageId: 'b1', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 2 * MIN } }),
    now: 50 * MIN,
    ctx: SCP,
    derived: derived({ status: 'failed', phasesSeen: ['REQUEST', 'ACK', 'RESPONSE'], detail: 'a phase carried a failure ackCode' }),
    expected: 'failure',
  },
  {
    name: 'apiflc completed but gateway HTTP 500 → failure (500 recorded as completed)',
    app: 'apiflc',
    agent: apiflcAgent({ messageId: 'b2', status: 'completed', active: false, phaseTs: { REQUEST: 0, RESPONSE: 1 * MIN } }),
    now: 10 * MIN,
    ctx: APIFLC,
    derived: derived({ status: 'failed', phasesSeen: ['REQUEST', 'RESPONSE'], detail: 'gateway HTTP 500' }),
    expected: 'failure',
  },
  {
    name: 'scp failed but logs show a completed outcome → failure (false negative caught)',
    app: 'scp',
    agent: scpAgent({ messageId: 'b3', status: 'failed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } }),
    findingSeverity: 'high',
    now: 50 * MIN,
    ctx: SCP,
    derived: derived({ status: 'completed', phasesSeen: ['REQUEST', 'ACK', 'RESPONSE'] }),
    expected: 'failure',
  },
  {
    name: 'scp completed but claims RESPONSE never seen in logs → failure (unverified completion)',
    app: 'scp',
    agent: scpAgent({ messageId: 'b4', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 2 * MIN } }),
    now: 50 * MIN,
    ctx: SCP,
    derived: derived({ status: 'unknown', phasesSeen: ['REQUEST'], detail: 'no RESPONSE phase in logs' }),
    expected: 'failure',
  },
  {
    name: 'scp completed missing RESPONSE phase (agent phaseTs) → failure',
    app: 'scp',
    agent: scpAgent({ messageId: 'b5', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } }),
    now: 50 * MIN,
    ctx: SCP,
    derived: derived({ status: 'unknown', phasesSeen: ['REQUEST', 'ACK'] }),
    expected: 'failure',
  },
  {
    name: 'scp error but finding at wrong level → failure',
    app: 'scp',
    agent: scpAgent({ messageId: 'b6', status: 'error', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN } }),
    findingSeverity: 'high',
    now: 50 * MIN,
    ctx: SCP,
    expected: 'failure',
  },
  {
    name: 'scp completed + HIGH quality finding → completed_with_issues',
    app: 'scp',
    agent: scpAgent({ messageId: 'i1', status: 'completed', active: false, phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 2 * MIN } }),
    now: 50 * MIN,
    ctx: SCP,
    qualityFindings: [{ id: 'f', severity: 'high', kind: 'anomaly', title: 'High integration latency' }],
    derived: derived({ status: 'completed', phasesSeen: ['REQUEST', 'ACK', 'RESPONSE'] }),
    expected: 'completed_with_issues',
  },
];

test('gold-set backtest: engine reproduces every human label (no mismatches)', () => {
  const m = runBacktest(GOLD);
  assert.deepEqual(m.mismatches, [], `engine disagreed with the gold labels: ${JSON.stringify(m.mismatches, null, 2)}`);
});

test('gold-set backtest: zero false positives and zero false negatives', () => {
  const m = runBacktest(GOLD);
  assert.equal(m.falsePositives, 0, 'engine surfaced a problem on a clean-labelled transaction');
  assert.equal(m.falseNegatives, 0, 'engine passed a transaction labelled as a problem');
  assert.equal(m.precision, 1);
  assert.equal(m.recall, 1);
});

test('gold-set backtest: per-app precision/recall are reported', () => {
  const m = runBacktest(GOLD);
  for (const app of ['scp', 'apiflc']) {
    assert.ok(m.byApp[app], `no metrics for ${app}`);
    assert.equal(m.byApp[app]!.precision, 1);
    assert.equal(m.byApp[app]!.recall, 1);
  }
});

test('backtest catches a regression: a deliberately wrong label shows up as a mismatch', () => {
  // Flip one label to prove the harness actually discriminates (guards against a
  // harness that trivially passes everything).
  const broken = GOLD.map((c) => (c.name.startsWith('apiflc completed, gateway HTTP 200') ? { ...c, expected: 'failure' as const } : c));
  const m = runBacktest(broken);
  assert.equal(m.mismatches.length, 1);
  assert.equal(m.falseNegatives, 1); // labelled a problem, engine (correctly) passed it
});
