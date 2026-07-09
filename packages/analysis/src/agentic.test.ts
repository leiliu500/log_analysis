import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RawLogRecord } from '@log/shared';
import { parseBatch } from './parser.js';
import { planAgentUnits, type AgentUnit } from './agentic.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function cash(tags: Record<string, string>): string {
  const body = Object.entries(tags)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  return `<ns:cashMessage xmlns:ns="http://x"><header>${body}</header></ns:cashMessage>`;
}

function rec(raw: string, ts: number): RawLogRecord {
  return { source: 'cloudwatch', stream: 'adt-d2-scp-log-group', timestamp: ts, raw, attributes: {} };
}

// One agent per ingested request: healthy stay 'clean' (no reason), incomplete
// and rejected carry a reason, orphan ACK/RESPONSE spawn no agent.
test('planAgentUnits: one transaction unit per ingested request, triaged', () => {
  const records: RawLogRecord[] = [
    // 001 — healthy complete transaction
    rec(cash({ messageType: 'REQUEST', messageId: '001' }), NOW - 3 * MIN),
    rec(cash({ messageType: 'ACK', messageId: 'ACK-001', initMessageId: '001', ackCode: 'OK' }), NOW - 3 * MIN),
    rec(cash({ messageType: 'RESPONSE', messageId: 'RSP-001', initMessageId: '001', ackCode: 'PROCESSED_SUCCESSFULLY' }), NOW - 3 * MIN),
    // 002 — incomplete: REQUEST only, older than the grace window
    rec(cash({ messageType: 'REQUEST', messageId: '002' }), NOW - 5 * MIN),
    // 003 — rejected: ACK carries a failure ackCode
    rec(cash({ messageType: 'REQUEST', messageId: '003' }), NOW - 4 * MIN),
    rec(cash({ messageType: 'ACK', messageId: 'ACK-003', initMessageId: '003', ackCode: 'FAILED' }), NOW - 4 * MIN),
    // orphan ACK — no REQUEST in window → belongs to an earlier agent, skipped
    rec(cash({ messageType: 'ACK', messageId: 'ACK-999', initMessageId: '999', ackCode: 'OK' }), NOW - 1 * MIN),
  ];

  const parsed = parseBatch(records);
  const units = planAgentUnits(parsed, { now: NOW, txGraceMs: MIN });
  const txUnits = units.filter((u): u is Extract<AgentUnit, { kind: 'transaction' }> => u.kind === 'transaction');

  // 3 ingested requests → 3 agents; orphan ACK does NOT spawn one.
  assert.equal(txUnits.length, 3);
  const byId = new Map(txUnits.map((u) => [u.tx.id, u]));
  assert.equal(byId.get('001')!.reason, undefined); // healthy → clean, no model call
  assert.match(byId.get('002')!.reason ?? '', /missing|not acknowledged|not processed/i);
  assert.match(byId.get('003')!.reason ?? '', /reject|fail/i);
});

test('planAgentUnits: non-transaction error logs get their own agent', () => {
  const records: RawLogRecord[] = [
    rec('{"level":"error","message":"payment gateway returned 500 Internal Server Error"}', NOW - 2 * MIN),
    rec('{"level":"error","message":"payment gateway returned 500 Internal Server Error"}', NOW - 1 * MIN),
  ];
  const parsed = parseBatch(records);
  const units = planAgentUnits(parsed, { now: NOW });
  assert.ok(units.some((u) => u.kind === 'error'), 'expected at least one error unit');
  assert.ok(units.every((u) => u.kind !== 'transaction'), 'plain error logs are not transactions');
});
