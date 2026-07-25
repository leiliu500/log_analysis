import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationRegistry } from '@log/shared';
import type { Agent, ApplicationDef } from '@log/shared';
import { stepAgentsDynamic, type AgentEvent } from './agentLifecycle.js';
import { reasonTransition, deterministicDecision, type TransitionDecision } from './reasonTransition.js';

// A minimal SCP-shaped app. eventOf is unused by stepAgentsDynamic (events are passed
// pre-extracted); transactionPromptPath points at a real spec so the LLM path engages.
const app: ApplicationDef = {
  id: 'scp',
  displayName: 'SCP',
  logGroups: [],
  transactionPromptPath: 'apps/scp/transaction.md',
  dynamicLifecycle: true,
  protocol: {
    id: 'scp',
    initial: 'REQUEST',
    phases: ['ACK', 'RESPONSE'],
    allPhases: ['REQUEST', 'ACK', 'RESPONSE'],
    eventOf: () => undefined,
    isSuccess: (c?: string) => !c || c === 'OK',
  },
};
const registry = new ApplicationRegistry().register(app);
const MIN = 60_000;
const ev = (type: string, corrId: string, ts: number, ackCode?: string): AgentEvent => ({ type, corrId, ts, ackCode, application: 'scp', raw: `<${type}> ${ackCode ?? ''}` });

// A stub "LLM": completed when RESPONSE present, failed on a bad ack, else awaiting.
const stub = async (_system: string, user: string): Promise<Partial<TransitionDecision>> => {
  if (/ackCode=FAILED/.test(user)) return { status: 'failed', severity: 'high', detail: 'stub: failure ack' };
  if (/phase=RESPONSE/.test(user)) return { status: 'completed', detail: 'stub: response seen' };
  return { status: 'awaiting', waitingFor: 'RESPONSE', detail: 'stub: awaiting response' };
};

test('dynamic: spawn → advance → complete via reasoned transitions', async () => {
  const r = await stepAgentsDynamic(
    [ev('REQUEST', 'm1', 0), ev('ACK', 'm1', 1 * MIN, 'OK'), ev('RESPONSE', 'm1', 2 * MIN, 'OK')],
    [],
    { now: 5 * MIN, timeoutMs: 30 * MIN, registry, reasoner: stub },
  );
  const a = r.agents.get('m1')!;
  assert.equal(a.status, 'completed');
  assert.equal(a.active, false);
});

test('dynamic: reasoned failure closes with high severity', async () => {
  const r = await stepAgentsDynamic([ev('REQUEST', 'm2', 0), ev('ACK', 'm2', 1 * MIN, 'FAILED')], [], { now: 5 * MIN, timeoutMs: 30 * MIN, registry, reasoner: stub });
  const a = r.agents.get('m2')!;
  assert.equal(a.status, 'failed');
  assert.equal(a.severity, 'high');
});

test('dynamic: model error falls back to the deterministic decision', async () => {
  const boom = async (): Promise<Partial<TransitionDecision>> => {
    throw new Error('bedrock unavailable');
  };
  const r = await stepAgentsDynamic(
    [ev('REQUEST', 'm3', 0), ev('ACK', 'm3', 1 * MIN, 'OK'), ev('RESPONSE', 'm3', 2 * MIN, 'OK')],
    [],
    { now: 5 * MIN, timeoutMs: 30 * MIN, registry, reasoner: boom },
  );
  assert.equal(r.agents.get('m3')!.status, 'completed'); // deterministic fallback: all phases present
});

test('dynamic: timeout stays deterministic (no reasoning)', async () => {
  const known: Agent[] = [
    { messageId: 'm4', application: 'scp', status: 'awaiting', active: true, waitingFor: 'RESPONSE', phases: ['REQUEST', 'ACK', 'RESPONSE'], phaseTs: { REQUEST: 0, ACK: 1 * MIN }, spawnedAt: 0, updatedAt: 0 },
  ];
  const r = await stepAgentsDynamic([], known, { now: 100 * MIN, timeoutMs: 30 * MIN, registry, reasoner: stub });
  const a = r.agents.get('m4')!;
  assert.equal(a.status, 'error');
  assert.equal(a.severity, 'medium');
});

test('deterministicDecision mirrors the state-machine rules (the fallback)', () => {
  assert.equal(deterministicDecision(app, { REQUEST: 0, ACK: 1, RESPONSE: 2 }).status, 'completed');
  assert.equal(deterministicDecision(app, { REQUEST: 0 }).status, 'awaiting');
  assert.equal(deterministicDecision(app, { REQUEST: 0, ACK: 1 }, 'FAILED').status, 'failed');
});

test('reasonTransition normalizes the model output', async () => {
  const d = await reasonTransition(
    app,
    { messageId: 'x', currentStatus: 'awaiting', phaseTs: { REQUEST: 0, ACK: 1, RESPONSE: 2 }, ackCode: 'OK', events: [ev('RESPONSE', 'x', 2, 'OK')], now: 5 },
    stub,
  );
  assert.equal(d.status, 'completed');
});
