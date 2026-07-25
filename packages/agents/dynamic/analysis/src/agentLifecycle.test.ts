import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, AgentPromptContext, ParsedLog, TransactionProtocol, TransitionDecision } from '@log/shared';
import { ApplicationRegistry, decideFromSpec } from '@log/shared';
import { stepAgentsDynamic, agentEvents, agentAnomalyFingerprint, type AgentEvent } from './agentLifecycle.js';
import { parseBatch } from './parser.js';

const NOW = 1_700_000_000_000;
const S = 1_000;
const TIMEOUT = 30 * 60_000;

/** A test protocol mirroring SCP's REQUEST → ACK → RESPONSE shape. */
const tag = (raw: string, t: string): string | undefined =>
  raw.match(new RegExp(`<(?:[\\w.-]+:)?${t}>\\s*([^<]+?)\\s*</`, 'i'))?.[1];

const testProtocol: TransactionProtocol = {
  id: 'test',
  initial: 'REQUEST',
  phases: ['ACK', 'RESPONSE'],
  allPhases: ['REQUEST', 'ACK', 'RESPONSE'],
  eventOf(log: ParsedLog) {
    const type = tag(log.raw, 'messageType')?.toUpperCase();
    if (type !== 'REQUEST' && type !== 'ACK' && type !== 'RESPONSE') return undefined;
    const corrId = type === 'REQUEST' ? tag(log.raw, 'messageId') : tag(log.raw, 'initMessageId');
    if (!corrId) return undefined;
    return { type, corrId, ackCode: tag(log.raw, 'ackCode') };
  },
  isSuccess: (c?: string) => !c || /^(OK|SUCCESS|PROCESSED_SUCCESSFULLY|ACCEPTED|COMPLETE|COMPLETED)$/i.test(c),
};

// A tiny app-owned ingestion agent for the test: its evidence carries the phases + event
// lines the stub reasoner keys off. Mirrors how a real app (scp/apiflc) owns decide().
const evidence = (ctx: AgentPromptContext): string =>
  [
    `Transaction: ${ctx.messageId}`,
    `Phases received so far: ${Object.keys(ctx.phaseTs).join(', ') || '(none)'}`,
    ...ctx.eventLines,
  ].join('\n');

// logGroups empty so registry.forLog falls back to eventOf-matching for the test.
// transactionPromptPath must resolve so decideFromSpec loads a (real) spec.
const registry = new ApplicationRegistry().register({
  id: 'test',
  displayName: 'Test',
  logGroups: [],
  transactionPromptPath: 'apps/scp/transaction.md',
  protocol: testProtocol,
  ingestionAgent: { decide: (ctx, reason) => decideFromSpec('apps/scp/transaction.md', evidence(ctx), reason) },
});

// A stub "LLM" that mirrors the test protocol from the prompt the engine builds:
// a failure ackCode ⇒ failed; all phases present ⇒ completed; else awaiting the next.
const stub = async (_system: string, user: string): Promise<Partial<TransitionDecision>> => {
  if (/FAILED/.test(user)) return { status: 'failed', severity: 'high', detail: 'stub: failure ack' };
  const received = user.match(/Phases received so far:\s*([^\n]*)/)?.[1] ?? '';
  if (/\bRESPONSE\b/.test(received)) return { status: 'completed', detail: 'stub: response seen' };
  const next = ['ACK', 'RESPONSE'].find((p) => !new RegExp(`\\b${p}\\b`).test(received)) ?? 'RESPONSE';
  return { status: 'awaiting', waitingFor: next, detail: `stub: awaiting ${next}` };
};

const ev = (type: string, corrId: string, ts: number, ackCode?: string): AgentEvent => ({
  type,
  corrId,
  ts,
  ackCode,
  application: 'test',
  raw: `<messageType>${type}</messageType>${ackCode ? `<ackCode>${ackCode}</ackCode>` : ''}`,
});

function step(events: AgentEvent[], known: Agent[] = [], now = NOW) {
  return stepAgentsDynamic(events, known, { now, timeoutMs: TIMEOUT, registry, reasoner: stub });
}

/** Build a known/active agent in the generic phase model. */
function agent(over: Partial<Agent>): Agent {
  return {
    messageId: '001',
    application: 'test',
    status: 'awaiting',
    active: true,
    waitingFor: 'ACK',
    phases: ['REQUEST', 'ACK', 'RESPONSE'],
    phaseTs: {},
    spawnedAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

test('REQUEST spawns an active agent awaiting the first phase (ACK)', async () => {
  const r = await step([ev('REQUEST', '001', NOW - 10 * S)]);
  const a = r.agents.get('001')!;
  assert.equal(r.spawned, 1);
  assert.equal(a.status, 'awaiting');
  assert.equal(a.active, true);
  assert.equal(a.waitingFor, 'ACK');
  assert.equal(a.phaseTs.REQUEST, NOW - 10 * S);
});

test('ACK success on a known agent advances to awaiting RESPONSE (still active)', async () => {
  const known = agent({ waitingFor: 'ACK', phaseTs: { REQUEST: NOW - 10 * S } });
  const r = await step([ev('ACK', '001', NOW - 9 * S, 'OK')], [known]);
  const a = r.agents.get('001')!;
  assert.equal(a.status, 'awaiting');
  assert.equal(a.waitingFor, 'RESPONSE');
  assert.equal(a.active, true);
  assert.equal(r.advanced, 1);
  assert.equal(a.ackCode, 'OK');
});

test('ACK failure closes the agent (failed, inactive)', async () => {
  const r = await step([ev('REQUEST', '001', NOW - 10 * S), ev('ACK', '001', NOW - 9 * S, 'FAILED')]);
  const a = r.agents.get('001')!;
  assert.equal(a.status, 'failed');
  assert.equal(a.active, false);
  assert.equal(a.closedAt, NOW);
  assert.equal(r.closed, 1);
});

test('RESPONSE closes the agent (completed, inactive)', async () => {
  const r = await step([
    ev('REQUEST', '001', NOW - 10 * S),
    ev('ACK', '001', NOW - 9 * S, 'OK'),
    ev('RESPONSE', '001', NOW - 8 * S, 'PROCESSED_SUCCESSFULLY'),
  ]);
  const a = r.agents.get('001')!;
  assert.equal(a.status, 'completed');
  assert.equal(a.active, false);
  assert.equal(a.phaseTs.RESPONSE, NOW - 8 * S);
});

test('a still-active agent past the timeout is closed as error (deterministic clock)', async () => {
  const known = agent({
    waitingFor: 'ACK',
    phaseTs: { REQUEST: NOW - 40 * 60_000 },
    spawnedAt: NOW - 40 * 60_000,
    updatedAt: NOW - 40 * 60_000,
  });
  const r = await step([], [known]);
  const a = r.agents.get('001')!;
  assert.equal(a.status, 'error');
  assert.equal(a.active, false);
  assert.match(a.detail ?? '', /timed out/i);
});

test('a later phase arriving before the initial lazily spawns the agent', async () => {
  const r = await step([ev('ACK', '001', NOW - 9 * S, 'OK')]);
  const a = r.agents.get('001')!;
  assert.equal(r.spawned, 1);
  assert.equal(a.status, 'awaiting');
  assert.equal(a.waitingFor, 'RESPONSE');
});

test('events on an already-terminal agent are ignored (idempotent)', async () => {
  const done = agent({
    status: 'completed',
    active: false,
    waitingFor: undefined,
    phaseTs: { REQUEST: NOW - 20 * S, RESPONSE: NOW - 18 * S },
    updatedAt: NOW - 18 * S,
    closedAt: NOW - 18 * S,
  });
  const r = await step([ev('ACK', '001', NOW - 5 * S, 'FAILED')], [done]);
  const a = r.agents.get('001')!;
  assert.equal(a.status, 'completed'); // unchanged
  assert.equal(a.active, false);
});

// message_id is the agents PRIMARY KEY: one agent per id, immutable once terminal.
// So the anomaly identity is the id alone — a second anomaly for it is a duplicate.
// It must NOT vary with closedAt (that reintroduces the duplicate the migration
// cleaned up: a new-scheme anomaly fails to match the existing tx:<id> one).
test('anomaly fingerprint is the messageId alone, independent of close time', () => {
  const a = agent({ messageId: '005', status: 'error', active: false, closedAt: NOW });
  const b = agent({ messageId: '005', status: 'error', active: false, closedAt: NOW + 60_000 });
  assert.equal(agentAnomalyFingerprint(a), 'tx:005');
  assert.equal(agentAnomalyFingerprint(a), agentAnomalyFingerprint(b), 'same id ⇒ same anomaly, whatever the close time');
});

test('a timed-out agent maps to its stable anomaly fingerprint', async () => {
  const known = agent({
    waitingFor: 'RESPONSE',
    phaseTs: { REQUEST: NOW - 40 * 60_000, ACK: NOW - 39 * 60_000 },
    spawnedAt: NOW - 40 * 60_000,
    updatedAt: NOW - 39 * 60_000,
  });
  const a = (await step([], [known])).agents.get('001')!;
  assert.equal(a.status, 'error');
  assert.equal(agentAnomalyFingerprint(a), 'tx:001');
});

test('an awaiting agent is re-reasoned when its app.pendingSignals fires (no new event)', async () => {
  // Reproduces the apiflc gateway-status case generically: the decisive signal is a
  // non-event log that arrives in a LATER poll, so nothing would re-schedule the agent
  // and it would time out — unless the app's pendingSignals hook re-schedules it.
  const plog = (raw: string): ParsedLog => ({ raw, source: 'cloudwatch', stream: 'g', timestamp: NOW } as unknown as ParsedLog);
  const gwRegistry = new ApplicationRegistry().register({
    id: 'gw',
    displayName: 'GW',
    logGroups: [],
    protocol: testProtocol,
    ingestionAgent: {
      decide: async (c) => (c.window.some((l) => /STATUS200/.test(l.raw)) ? { status: 'completed', detail: 'gateway 200' } : { status: 'awaiting', waitingFor: 'RESPONSE', detail: 'awaiting status' }),
    },
    pendingSignals: (window, ids) => (window.some((l) => /STATUS200/.test(l.raw)) ? [...ids] : []),
  });
  const known: Agent[] = [{ messageId: 'g1', application: 'gw', status: 'awaiting', active: true, waitingFor: 'RESPONSE', phases: ['REQUEST', 'ACK', 'RESPONSE'], phaseTs: { REQUEST: NOW, RESPONSE: NOW }, spawnedAt: NOW, updatedAt: NOW }];

  // Later poll: NO new events, but the gateway status is now in the window.
  const done = await stepAgentsDynamic([], structuredClone(known), { now: NOW + 60_000, timeoutMs: TIMEOUT, registry: gwRegistry, windowLogs: [plog('(abc) Method completed with STATUS200')] });
  assert.equal(done.agents.get('g1')!.status, 'completed');
  assert.equal(done.agents.get('g1')!.active, false);

  // Same poll but status not present yet ⇒ pendingSignals is silent ⇒ agent left awaiting.
  const still = await stepAgentsDynamic([], structuredClone(known), { now: NOW + 60_000, timeoutMs: TIMEOUT, registry: gwRegistry, windowLogs: [plog('(abc) Method request headers: X-Correlation-ID=g1')] });
  assert.equal(still.agents.get('g1')!.status, 'awaiting');
  assert.equal(still.agents.get('g1')!.active, true);
});

test('agentEvents extracts ordered request/ack/response from parsed logs', () => {
  const cash = (type: string, tags: Record<string, string>) =>
    `<ns:cashMessage xmlns:ns="x"><header><messageType>${type}</messageType>${Object.entries(tags)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('')}</header></ns:cashMessage>`;
  const parsed = parseBatch([
    { source: 'cloudwatch', stream: 'g', timestamp: NOW - 2 * S, attributes: {}, raw: cash('ACK', { messageId: 'A1', initMessageId: '001', ackCode: 'OK' }) },
    { source: 'cloudwatch', stream: 'g', timestamp: NOW - 3 * S, attributes: {}, raw: cash('REQUEST', { messageId: '001' }) },
  ]);
  const events = agentEvents(parsed, registry);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.type, 'REQUEST'); // sorted by ts
  assert.equal(events[0]!.corrId, '001');
  assert.equal(events[1]!.type, 'ACK');
  assert.equal(events[1]!.corrId, '001'); // via initMessageId
});
