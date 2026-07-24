import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from '@log/shared';
import { scpValidationChecks } from './validationChecks.js';

let seq = 0;
const mk = (ts: number, xml: string): ParsedLog =>
  ({ raw: xml, message: xml, id: `log-${++seq}`, source: 'cloudwatch', stream: 'scp', timestamp: ts, level: 'info' }) as unknown as ParsedLog;

const REQ = (id: string) => `<messageType>REQUEST</messageType><messageId>${id}</messageId>`;
const ACK = (own: string, init: string) => `<messageType>ACK</messageType><messageId>${own}</messageId><initMessageId>${init}</initMessageId><ackCode>OK</ackCode>`;
const RESP = (own: string, init: string) => `<messageType>RESPONSE</messageType><messageId>${own}</messageId><initMessageId>${init}</initMessageId><ackCode>OK</ackCode>`;

const MIN = 60_000;
const call = (logs: ParsedLog[], messageId = 'M1') => scpValidationChecks({ messageId, agentStatus: 'completed', relatedLogs: logs });

test('in-order REQUEST → ACK → RESPONSE is clean', () => {
  const deltas = call([mk(0, REQ('M1')), mk(1 * MIN, ACK('A1', 'M1')), mk(2 * MIN, RESP('R1', 'M1'))]);
  assert.deepEqual(deltas, []);
});

test('RESPONSE stamped before its ACK is an ordering violation', () => {
  const deltas = call([mk(0, REQ('M1')), mk(5 * MIN, ACK('A1', 'M1')), mk(2 * MIN, RESP('R1', 'M1'))]);
  assert.equal(deltas.length, 1);
  assert.match(deltas[0]!, /ordering violation: RESPONSE precedes ACK/);
});

test('ACK stamped before its REQUEST is an ordering violation', () => {
  const deltas = call([mk(3 * MIN, REQ('M1')), mk(1 * MIN, ACK('A1', 'M1')), mk(5 * MIN, RESP('R1', 'M1'))]);
  assert.ok(deltas.some((d) => /ordering violation: ACK precedes REQUEST/.test(d)));
});

test('two DISTINCT RESPONSEs for one request → duplicate delta', () => {
  const deltas = call([mk(0, REQ('M1')), mk(1 * MIN, ACK('A1', 'M1')), mk(2 * MIN, RESP('R1', 'M1')), mk(3 * MIN, RESP('R2', 'M1'))]);
  assert.ok(deltas.some((d) => /duplicate RESPONSE: 2 distinct/.test(d)));
});

test('a re-logged identical RESPONSE (same own messageId) is NOT a duplicate', () => {
  const deltas = call([mk(0, REQ('M1')), mk(1 * MIN, ACK('A1', 'M1')), mk(2 * MIN, RESP('R1', 'M1')), mk(2 * MIN, RESP('R1', 'M1'))]);
  assert.deepEqual(deltas, []);
});

test('only the REQUEST is in-window (ACK/RESPONSE rolled off) → no false positive', () => {
  const deltas = call([mk(0, REQ('M1'))]);
  assert.deepEqual(deltas, []);
});

test('logs belonging to a different messageId are ignored', () => {
  const deltas = call([mk(0, REQ('M1')), mk(9 * MIN, ACK('Ax', 'OTHER')), mk(1 * MIN, RESP('Rx', 'OTHER'))]);
  assert.deepEqual(deltas, []); // the OTHER call's out-of-order pair must not fault M1
});
