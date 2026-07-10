import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, ParsedLog, TransactionProtocol } from '@log/shared';
import { stepAgents, agentEvents, type AgentEvent } from './agentLifecycle.js';
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

const ev = (type: string, corrId: string, ts: number, ackCode?: string): AgentEvent => ({
  type,
  corrId,
  ts,
  ackCode,
});

function step(events: AgentEvent[], known: Agent[] = [], now = NOW) {
  return stepAgents(events, known, { now, timeoutMs: TIMEOUT, protocol: testProtocol });
}

/** Build a known/active agent in the generic phase model. */
function agent(over: Partial<Agent>): Agent {
  return {
    messageId: '001',
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

test('REQUEST spawns an active agent awaiting the first phase (ACK)', () => {
  const r = step([ev('REQUEST', '001', NOW - 10 * S)]);
  const a = r.agents.get('001')!;
  assert.equal(r.spawned, 1);
  assert.equal(a.status, 'awaiting');
  assert.equal(a.active, true);
  assert.equal(a.waitingFor, 'ACK');
  assert.equal(a.phaseTs.REQUEST, NOW - 10 * S);
});

test('ACK success advances to awaiting RESPONSE (still active)', () => {
  const r = step([ev('REQUEST', '001', NOW - 10 * S), ev('ACK', '001', NOW - 9 * S, 'OK')]);
  const a = r.agents.get('001')!;
  assert.equal(a.status, 'awaiting');
  assert.equal(a.waitingFor, 'RESPONSE');
  assert.equal(a.active, true);
  assert.equal(r.advanced, 1);
  assert.equal(a.ackCode, 'OK');
});

test('ACK failure closes the agent (failed, inactive)', () => {
  const r = step([ev('REQUEST', '001', NOW - 10 * S), ev('ACK', '001', NOW - 9 * S, 'FAILED')]);
  const a = r.agents.get('001')!;
  assert.equal(a.status, 'failed');
  assert.equal(a.active, false);
  assert.equal(a.closedAt, NOW);
  assert.equal(r.closed, 1);
});

test('RESPONSE closes the agent (completed, inactive)', () => {
  const r = step([
    ev('REQUEST', '001', NOW - 10 * S),
    ev('ACK', '001', NOW - 9 * S, 'OK'),
    ev('RESPONSE', '001', NOW - 8 * S, 'PROCESSED_SUCCESSFULLY'),
  ]);
  const a = r.agents.get('001')!;
  assert.equal(a.status, 'completed');
  assert.equal(a.active, false);
  assert.equal(a.phaseTs.RESPONSE, NOW - 8 * S);
});

test('a still-active agent past the timeout is closed as error', () => {
  const known = agent({
    waitingFor: 'ACK',
    phaseTs: { REQUEST: NOW - 40 * 60_000 },
    spawnedAt: NOW - 40 * 60_000,
    updatedAt: NOW - 40 * 60_000,
  });
  const r = step([], [known]);
  const a = r.agents.get('001')!;
  assert.equal(a.status, 'error');
  assert.equal(a.active, false);
  assert.match(a.detail ?? '', /timed out/i);
});

test('a later phase arriving before the initial lazily spawns the agent', () => {
  const r = step([ev('ACK', '001', NOW - 9 * S, 'OK')]);
  const a = r.agents.get('001')!;
  assert.equal(r.spawned, 1);
  assert.equal(a.status, 'awaiting');
  assert.equal(a.waitingFor, 'RESPONSE');
});

test('events on an already-terminal agent are ignored (idempotent)', () => {
  const done = agent({
    status: 'completed',
    active: false,
    waitingFor: undefined,
    phaseTs: { REQUEST: NOW - 20 * S, RESPONSE: NOW - 18 * S },
    updatedAt: NOW - 18 * S,
    closedAt: NOW - 18 * S,
  });
  const r = step([ev('ACK', '001', NOW - 5 * S, 'FAILED')], [done]);
  const a = r.agents.get('001')!;
  assert.equal(a.status, 'completed'); // unchanged
  assert.equal(a.active, false);
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
  const events = agentEvents(parsed, testProtocol);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.type, 'REQUEST'); // sorted by ts
  assert.equal(events[0]!.corrId, '001');
  assert.equal(events[1]!.type, 'ACK');
  assert.equal(events[1]!.corrId, '001'); // via initMessageId
});
