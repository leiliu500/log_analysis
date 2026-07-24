import type { Agent, GoldCase, QualityFinding, Severity } from '@log/shared';
import { MIN, scpLog, scpTransaction } from './backtestFixtures.js';

/**
 * SCP's hand-labelled validation gold set. Each case pairs an ingestion-agent record
 * (what the agent CLAIMS) with the raw logs (the independent ground truth) and the
 * result a human confirmed is correct — tagged with the failure mode it guards
 * against. Owned by the SCP package; the `@log/backtest` runner scores it against the
 * real validation engine.
 */

const NOW = 50 * MIN;

const mkAgent = (
  o: Pick<Agent, 'messageId' | 'status'> &
    Partial<Pick<Agent, 'active' | 'waitingFor' | 'phaseTs' | 'spawnedAt' | 'closedAt'>>,
): GoldCase['agent'] => ({
  messageId: o.messageId,
  application: 'scp',
  status: o.status,
  active: o.active ?? o.status === 'awaiting',
  waitingFor: o.waitingFor,
  phases: ['REQUEST', 'ACK', 'RESPONSE'],
  phaseTs: o.phaseTs ?? {},
  spawnedAt: o.spawnedAt ?? 0,
  closedAt: o.closedAt ?? (o.status === 'awaiting' ? undefined : 100),
});

const qf = (severity: Severity, title = 'Integration latency'): QualityFinding[] => [{ id: `q-${severity}`, severity, kind: 'anomaly', title }];

const ALL: Record<string, number> = { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 2 * MIN };

export const scpGoldCases: GoldCase[] = [
  // ---- clean baseline ----
  {
    name: 'scp: clean completed within SLA',
    mode: 'clean',
    app: 'scp',
    agent: mkAgent({ messageId: 'S001', status: 'completed', phaseTs: ALL }),
    logs: scpTransaction(0, 'S001'),
    now: NOW,
    expected: 'success',
  },
  {
    name: 'scp: active awaiting RESPONSE within SLA → pending',
    mode: 'clean',
    app: 'scp',
    agent: mkAgent({ messageId: 'S002', status: 'awaiting', waitingFor: 'RESPONSE', phaseTs: { REQUEST: 0, ACK: 1 * MIN } }),
    logs: [scpLog(0, { type: 'REQUEST', messageId: 'S002' }), scpLog(1 * MIN, { type: 'ACK', messageId: 'S002-ack', initMessageId: 'S002', ackCode: 'OK' })],
    now: 5 * MIN,
    expected: 'pending',
  },

  // ---- false-positive guards (looks suspicious, must stay quiet) ----
  {
    name: 'scp: failed agent WITH its high finding → success (not double-flagged)',
    mode: 'false-positive',
    app: 'scp',
    agent: mkAgent({ messageId: 'S010', status: 'failed', phaseTs: { REQUEST: 0, ACK: 1 * MIN } }),
    logs: [scpLog(0, { type: 'REQUEST', messageId: 'S010' }), scpLog(1 * MIN, { type: 'ACK', messageId: 'S010-ack', initMessageId: 'S010', ackCode: 'FAILED' })],
    findingSeverity: 'high',
    now: NOW,
    expected: 'success',
  },
  {
    name: 'scp: error agent WITH its medium (timeout) finding → success',
    mode: 'false-positive',
    app: 'scp',
    agent: mkAgent({ messageId: 'S011', status: 'error', phaseTs: { REQUEST: 0, ACK: 1 * MIN } }),
    logs: [scpLog(0, { type: 'REQUEST', messageId: 'S011' }), scpLog(1 * MIN, { type: 'ACK', messageId: 'S011-ack', initMessageId: 'S011', ackCode: 'OK' })],
    findingSeverity: 'medium',
    now: NOW,
    expected: 'success',
  },
  {
    name: 'scp: completed + only INFO quality finding → success (below threshold, suppressed)',
    mode: 'false-positive',
    app: 'scp',
    agent: mkAgent({ messageId: 'S012', status: 'completed', phaseTs: ALL }),
    logs: scpTransaction(0, 'S012'),
    qualityFindings: qf('info', 'minor note'),
    now: NOW,
    expected: 'success',
  },
  {
    name: 'scp: completed but its earlier logs rolled off the window → success (absence never faults)',
    mode: 'false-positive',
    app: 'scp',
    agent: mkAgent({ messageId: 'S013', status: 'completed', phaseTs: ALL }),
    logs: [scpLog(0, { type: 'REQUEST', messageId: 'S013' })], // only REQUEST still in-window
    windowComplete: false,
    now: NOW,
    expected: 'success',
  },
  {
    name: 'scp: completed with no logs in window at all → success (unknown derivation, no guess)',
    mode: 'false-positive',
    app: 'scp',
    agent: mkAgent({ messageId: 'S014', status: 'completed', phaseTs: ALL }),
    logs: [],
    windowComplete: false,
    now: NOW,
    expected: 'success',
  },

  // ---- false-negative guards (genuinely broken, must flag) ----
  {
    name: 'scp: failed agent with NO finding → failure (missing finding)',
    mode: 'false-negative',
    app: 'scp',
    agent: mkAgent({ messageId: 'S020', status: 'failed', phaseTs: { REQUEST: 0, ACK: 1 * MIN } }),
    logs: [scpLog(0, { type: 'REQUEST', messageId: 'S020' }), scpLog(1 * MIN, { type: 'ACK', messageId: 'S020-ack', initMessageId: 'S020', ackCode: 'FAILED' })],
    now: NOW,
    expected: 'failure',
    expectDelta: /missing finding/,
  },
  {
    name: 'scp: completed agent WITH an unexpected finding → failure',
    mode: 'false-negative',
    app: 'scp',
    agent: mkAgent({ messageId: 'S021', status: 'completed', phaseTs: ALL }),
    logs: scpTransaction(0, 'S021'),
    findingSeverity: 'high',
    now: NOW,
    expected: 'failure',
    expectDelta: /unexpected finding/,
  },
  {
    name: 'scp: completed but agent is missing the RESPONSE phase → failure (missing phase)',
    mode: 'false-negative',
    app: 'scp',
    agent: mkAgent({ messageId: 'S022', status: 'completed', phaseTs: { REQUEST: 0, ACK: 1 * MIN } }),
    logs: scpTransaction(0, 'S022'),
    now: NOW,
    expected: 'failure',
    expectDelta: /missing phase/,
  },
  {
    name: 'scp: completed but RESPONSE arrived 40m after ACK → failure (SLA breach)',
    mode: 'false-negative',
    app: 'scp',
    agent: mkAgent({ messageId: 'S023', status: 'completed', phaseTs: { REQUEST: 0, ACK: 1 * MIN, RESPONSE: 41 * MIN } }),
    logs: scpTransaction(0, 'S023', { respTs: 41 * MIN }),
    now: 50 * MIN,
    expected: 'failure',
    expectDelta: /SLA breach/,
  },
  {
    name: 'scp: error agent with a HIGH finding (wrong level) → failure',
    mode: 'false-negative',
    app: 'scp',
    agent: mkAgent({ messageId: 'S024', status: 'error', phaseTs: { REQUEST: 0, ACK: 1 * MIN } }),
    logs: [scpLog(0, { type: 'REQUEST', messageId: 'S024' }), scpLog(1 * MIN, { type: 'ACK', messageId: 'S024-ack', initMessageId: 'S024', ackCode: 'OK' })],
    findingSeverity: 'high',
    now: NOW,
    expected: 'failure',
    expectDelta: /wrong level/,
  },
  {
    name: 'scp: RESPONSE stamped before its ACK → failure (SCP ordering violation)',
    mode: 'false-negative',
    app: 'scp',
    agent: mkAgent({ messageId: 'S025', status: 'completed', phaseTs: { REQUEST: 0, ACK: 5 * MIN, RESPONSE: 2 * MIN } }),
    logs: scpTransaction(0, 'S025', { ackTs: 5 * MIN, respTs: 2 * MIN }),
    now: NOW,
    expected: 'failure',
    expectDelta: /ordering violation/,
  },
  {
    name: 'scp: two distinct RESPONSEs for one request → failure (SCP duplicate)',
    mode: 'false-negative',
    app: 'scp',
    agent: mkAgent({ messageId: 'S026', status: 'completed', phaseTs: ALL }),
    logs: [
      ...scpTransaction(0, 'S026'),
      scpLog(3 * MIN, { type: 'RESPONSE', messageId: 'S026-res2', initMessageId: 'S026', ackCode: 'OK' }),
    ],
    now: NOW,
    expected: 'failure',
    expectDelta: /duplicate RESPONSE/,
  },
  {
    name: 'scp: completed + HIGH quality finding → completed_with_issues',
    mode: 'false-negative',
    app: 'scp',
    agent: mkAgent({ messageId: 'S027', status: 'completed', phaseTs: ALL }),
    logs: scpTransaction(0, 'S027'),
    qualityFindings: qf('high', 'High latency 5639ms'),
    now: NOW,
    expected: 'completed_with_issues',
  },
  {
    name: 'scp: completed but the system of record shows it never settled → failure (reconciliation)',
    mode: 'false-negative',
    app: 'scp',
    agent: mkAgent({ messageId: 'S028', status: 'completed', phaseTs: ALL }),
    logs: scpTransaction(0, 'S028'),
    reconcile: { outcome: 'failed', detail: 'ledger shows no settlement' },
    now: NOW,
    expected: 'failure',
    expectDelta: /system-of-record/,
  },

  // ---- hallucination guards (agent contradicts its own logs) ----
  {
    name: 'scp: agent says completed but logs show a FAILED RESPONSE → failure (status mismatch)',
    mode: 'hallucination',
    app: 'scp',
    agent: mkAgent({ messageId: 'S030', status: 'completed', phaseTs: ALL }),
    logs: scpTransaction(0, 'S030', { ackCode: 'FAILED' }),
    now: NOW,
    expected: 'failure',
    expectDelta: /status mismatch/,
  },
  {
    name: 'scp: agent says failed but logs show a clean completion → failure (status mismatch)',
    mode: 'hallucination',
    app: 'scp',
    agent: mkAgent({ messageId: 'S031', status: 'failed', phaseTs: { REQUEST: 0, ACK: 1 * MIN } }),
    logs: scpTransaction(0, 'S031'),
    findingSeverity: 'high', // present, so the ONLY delta is the status mismatch
    now: NOW,
    expected: 'failure',
    expectDelta: /status mismatch/,
  },
  {
    name: 'scp: agent claims completed but logs prove no RESPONSE arrived → failure (unverified completion)',
    mode: 'hallucination',
    app: 'scp',
    agent: mkAgent({ messageId: 'S032', status: 'completed', phaseTs: ALL }),
    logs: [scpLog(0, { type: 'REQUEST', messageId: 'S032' })], // only REQUEST, window IS complete
    windowComplete: true,
    now: NOW,
    expected: 'failure',
    expectDelta: /unverified completion/,
  },
];
