import type { Agent, GoldCase, QualityAnomaly, Severity } from '@log/shared';
import { MIN, apiflcRequest, apiflcResponse, apiflcTransaction } from './backtestFixtures.js';

/**
 * apiflc's hand-labelled validation gold set. Exercises the apiflc-specific paths the
 * generic engine cannot: the HTTP status re-derivation (`deriveOutcome`) resolved
 * across the handler + gateway groups, the 2-minute REQUEST→RESPONSE SLA, and quality
 * anomalies on a 200 response. Owned by the apiflc package.
 */

const NOW = 10 * MIN;

const mkAgent = (
  o: Pick<Agent, 'messageId' | 'status'> &
    Partial<Pick<Agent, 'active' | 'waitingFor' | 'phaseTs' | 'spawnedAt' | 'closedAt'>>,
): GoldCase['agent'] => ({
  messageId: o.messageId,
  application: 'apiflc',
  status: o.status,
  active: o.active ?? o.status === 'awaiting',
  waitingFor: o.waitingFor,
  phases: ['REQUEST', 'RESPONSE'],
  phaseTs: o.phaseTs ?? {},
  spawnedAt: o.spawnedAt ?? 0,
  closedAt: o.closedAt ?? (o.status === 'awaiting' ? undefined : 100),
});

const qf = (severity: Severity, title = 'Integration latency 5639ms'): QualityAnomaly[] => [{ id: `q-${severity}`, severity, kind: 'anomaly', title }];

export const apiflcGoldCases: GoldCase[] = [
  // ---- known gaps: rules the validation worker is MISSING (documented, not gate-breaking) ----
  {
    name: 'apiflc: completed with NO gateway HTTP status in logs (outcome unproven)',
    mode: 'false-negative',
    app: 'apiflc',
    agent: mkAgent({ messageId: 'GAP-API-1', status: 'completed', phaseTs: { REQUEST: 0, RESPONSE: 1 * MIN } }),
    logs: [apiflcRequest(0, 'GAP-API-1'), apiflcResponse(3000, 'GAP-API-1')],
    now: NOW,
    expected: 'failure',
    knownGap: {
      rule: 'require confirmed gateway HTTP status',
      detail: 'A completed apiflc transaction whose logs contain no API-Gateway HTTP status is accepted as success — the outcome is unproven (deriveOutcome trusts a bare handler RESPONSE line).',
    },
  },
  {
    name: 'apiflc: two RESPONSEs for one correlationID (duplicate call not detected)',
    mode: 'false-negative',
    app: 'apiflc',
    agent: mkAgent({ messageId: 'GAP-API-2', status: 'completed', phaseTs: { REQUEST: 0, RESPONSE: 1 * MIN } }),
    logs: [...apiflcTransaction(0, 'GAP-API-2', 200), apiflcResponse(6000, 'GAP-API-2')],
    now: NOW,
    expected: 'failure',
    knownGap: {
      rule: 'apiflc duplicate-phase detection',
      detail: 'apiflc declares no ordering/duplicate checks (those are SCP-only); a second RESPONSE for the same correlationID is not flagged.',
    },
  },

  {
    name: 'apiflc: clean HTTP 200 within SLA → success',
    mode: 'clean',
    app: 'apiflc',
    agent: mkAgent({ messageId: 'A100', status: 'completed', phaseTs: { REQUEST: 0, RESPONSE: 1 * MIN } }),
    logs: apiflcTransaction(0, 'A100', 200),
    now: NOW,
    expected: 'success',
  },
  {
    name: 'apiflc: active awaiting RESPONSE within 2m SLA → pending',
    mode: 'clean',
    app: 'apiflc',
    agent: mkAgent({ messageId: 'A101', status: 'awaiting', waitingFor: 'RESPONSE', phaseTs: { REQUEST: 0 } }),
    logs: [apiflcRequest(0, 'A101')],
    now: 1 * MIN,
    expected: 'pending',
  },
  {
    name: 'apiflc: agent says completed but gateway logged HTTP 500 → failure (status mismatch)',
    mode: 'hallucination',
    app: 'apiflc',
    agent: mkAgent({ messageId: 'A110', status: 'completed', phaseTs: { REQUEST: 0, RESPONSE: 1 * MIN } }),
    logs: apiflcTransaction(0, 'A110', 500),
    now: NOW,
    expected: 'failure',
    expectDelta: /status mismatch/,
  },
  {
    name: 'apiflc: completed 200 but RESPONSE arrived 5m after REQUEST → failure (SLA breach)',
    mode: 'false-negative',
    app: 'apiflc',
    agent: mkAgent({ messageId: 'A111', status: 'completed', phaseTs: { REQUEST: 0, RESPONSE: 5 * MIN } }),
    logs: apiflcTransaction(0, 'A111', 200),
    now: NOW,
    expected: 'failure',
    expectDelta: /SLA breach/,
  },
  {
    name: 'apiflc: completed 200 + HIGH latency anomaly → completed_with_issues',
    mode: 'false-negative',
    app: 'apiflc',
    agent: mkAgent({ messageId: 'A112', status: 'completed', phaseTs: { REQUEST: 0, RESPONSE: 1 * MIN } }),
    logs: apiflcTransaction(0, 'A112', 200),
    qualityAnomalies: qf('high'),
    now: NOW,
    expected: 'completed_with_issues',
  },
  {
    name: 'apiflc: completed 200 + only INFO anomaly → success (below threshold, suppressed)',
    mode: 'false-positive',
    app: 'apiflc',
    agent: mkAgent({ messageId: 'A113', status: 'completed', phaseTs: { REQUEST: 0, RESPONSE: 1 * MIN } }),
    logs: apiflcTransaction(0, 'A113', 200),
    qualityAnomalies: qf('info', 'authorized without API key'),
    now: NOW,
    expected: 'success',
  },
];
