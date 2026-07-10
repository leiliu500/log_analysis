import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from '@log/shared';
import { scpTransactionProtocol as P, scpMessageMeta, isScpAckSuccess } from './transactionProtocol.js';

const log = (raw: string): ParsedLog =>
  ({ raw, source: 'cloudwatch', stream: 'adt-d2-scp-log-group', timestamp: 0 } as unknown as ParsedLog);

const msg = (type: string, id: string, init?: string, ackCode?: string) =>
  `<ns2:cashMessage xmlns:ns2="http://x"><header><messageType>${type}</messageType><messageId>${id}</messageId>${
    init ? `<initMessageId>${init}</initMessageId>` : ''
  }</header>${ackCode ? `<payload><cashAcknowledgement><ackCode>${ackCode}</ackCode></cashAcknowledgement></payload>` : ''}</ns2:cashMessage>`;

test('protocol shape is REQUEST -> ACK -> RESPONSE', () => {
  assert.equal(P.id, 'scp');
  assert.equal(P.initial, 'REQUEST');
  assert.deepEqual(P.phases, ['ACK', 'RESPONSE']);
  assert.deepEqual(P.allPhases, ['REQUEST', 'ACK', 'RESPONSE']);
});

test('eventOf reads a REQUEST correlated by messageId', () => {
  const e = P.eventOf(log(msg('REQUEST', 'FCC-100')));
  assert.deepEqual(e, { type: 'REQUEST', corrId: 'FCC-100', ackCode: undefined });
});

test('eventOf correlates ACK/RESPONSE by initMessageId + reads ackCode', () => {
  const ack = P.eventOf(log(msg('ACK', 'SIM-1', 'FCC-100', 'OK')));
  assert.deepEqual(ack, { type: 'ACK', corrId: 'FCC-100', ackCode: 'OK' });
  const resp = P.eventOf(log(msg('RESPONSE', 'SIM-2', 'FCC-100', 'FAILED')));
  assert.deepEqual(resp, { type: 'RESPONSE', corrId: 'FCC-100', ackCode: 'FAILED' });
});

test('eventOf ignores non-transaction logs', () => {
  assert.equal(P.eventOf(log('{"level":"error","message":"boom"}')), undefined);
});

test('isSuccess accepts OK codes and a missing code, rejects failures', () => {
  for (const ok of [undefined, 'OK', 'SUCCESS', 'PROCESSED_SUCCESSFULLY', 'ACCEPTED', 'COMPLETED']) {
    assert.equal(P.isSuccess(ok), true, `expected success for ${ok}`);
  }
  for (const bad of ['FAILED', 'REJECTED', 'NACK', 'ERROR']) {
    assert.equal(P.isSuccess(bad), false, `expected failure for ${bad}`);
  }
  assert.equal(P.isSuccess, isScpAckSuccess); // protocol reuses the exported helper
});

test('scpMessageMeta exposes messageId AND initMessageId separately (richer than eventOf)', () => {
  const ack = scpMessageMeta(log(msg('ACK', 'SIM-1', 'FCC-100', 'OK')));
  assert.deepEqual(ack, { type: 'ACK', messageId: 'SIM-1', initMessageId: 'FCC-100', ackCode: 'OK' });
  const req = scpMessageMeta(log(msg('REQUEST', 'FCC-100')));
  assert.equal(req.type, 'REQUEST');
  assert.equal(req.messageId, 'FCC-100');
  assert.equal(req.initMessageId, undefined);
});
