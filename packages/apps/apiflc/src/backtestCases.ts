import type { Agent, GoldCase, QualityFinding, Severity } from '@log/shared';
import { MIN, apiflcRequest, apiflcTransaction } from './backtestFixtures.js';

/**
 * apiflc's hand-labelled validation gold set. Exercises the apiflc-specific paths the
 * generic engine cannot: the HTTP status re-derivation (`deriveOutcome`) resolved
 * across the handler + gateway groups, the 2-minute REQUEST→RESPONSE SLA, and quality
 * findings on a 200 response. Owned by the apiflc package.
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

const qf = (severity: Severity, title = 'Integration latency 5639ms'): QualityFinding[] => [{ id: `q-${severity}`, severity, kind: 'anomaly', title }];

export const apiflcGoldCases: GoldCase[] = [
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
    name: 'apiflc: completed 200 + HIGH latency finding → completed_with_issues',
    mode: 'false-negative',
    app: 'apiflc',
    agent: mkAgent({ messageId: 'A112', status: 'completed', phaseTs: { REQUEST: 0, RESPONSE: 1 * MIN } }),
    logs: apiflcTransaction(0, 'A112', 200),
    qualityFindings: qf('high'),
    now: NOW,
    expected: 'completed_with_issues',
  },
  {
    name: 'apiflc: completed 200 + only INFO finding → success (below threshold, suppressed)',
    mode: 'false-positive',
    app: 'apiflc',
    agent: mkAgent({ messageId: 'A113', status: 'completed', phaseTs: { REQUEST: 0, RESPONSE: 1 * MIN } }),
    logs: apiflcTransaction(0, 'A113', 200),
    qualityFindings: qf('info', 'authorized without API key'),
    now: NOW,
    expected: 'success',
  },
];
