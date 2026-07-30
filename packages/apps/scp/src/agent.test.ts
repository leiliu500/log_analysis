import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentPromptContext } from '@log/shared';
import { scpIngestionAgent } from './agent.js';

/**
 * SCP's DETERMINISTIC fast path. SCP is the easy case — every deciding fact rides on the
 * cashMessage event itself — so most transitions need no model call at all. That is the
 * ingestion scaling fix: one model call per transition caps throughput at ~480/hour, and
 * the overload failure mode is silent (deferred agents time out and are recorded as
 * legitimate timeouts).
 */
const ctx = (over: Partial<AgentPromptContext> = {}): AgentPromptContext => ({
  messageId: '001',
  currentStatus: 'new',
  phaseTs: {},
  phasesThisCycle: [],
  eventLines: [],
  window: [],
  now: 0,
  ...over,
});

test('REQUEST only → awaiting ACK, no model call', () => {
  const d = scpIngestionAgent.fastPath!(ctx({ phaseTs: { REQUEST: 0 }, phasesThisCycle: ['REQUEST'] }));
  assert.equal(d?.status, 'awaiting');
  assert.equal(d?.waitingFor, 'ACK');
});

test('REQUEST + ACK → awaiting RESPONSE', () => {
  const d = scpIngestionAgent.fastPath!(ctx({ phaseTs: { REQUEST: 0, ACK: 1 }, ackCode: 'OK' }));
  assert.equal(d?.status, 'awaiting');
  assert.equal(d?.waitingFor, 'RESPONSE');
});

test('all phases with a success ackCode → completed', () => {
  const d = scpIngestionAgent.fastPath!(ctx({ phaseTs: { REQUEST: 0, ACK: 1, RESPONSE: 2 }, ackCode: 'PROCESSED_SUCCESSFULLY' }));
  assert.equal(d?.status, 'completed');
});

test('a non-success ackCode is decisive wherever it appears → failed/high', () => {
  const d = scpIngestionAgent.fastPath!(ctx({ phaseTs: { REQUEST: 0, ACK: 1 }, ackCode: 'FAILED' }));
  assert.equal(d?.status, 'failed');
  assert.equal(d?.severity, 'high');
});

test('a RESPONSE without its ACK is out of order — deferred to the model, not decided', () => {
  // SCP's own validation checks flag REQUEST→ACK→RESPONSE ordering violations, so this
  // shape is a judgement call and must not be resolved mechanically.
  const d = scpIngestionAgent.fastPath!(ctx({ phaseTs: { REQUEST: 0, RESPONSE: 2 }, ackCode: 'OK' }));
  assert.equal(d, null);
});

test('no phases at all → deferred to the model', () => {
  assert.equal(scpIngestionAgent.fastPath!(ctx()), null);
});
