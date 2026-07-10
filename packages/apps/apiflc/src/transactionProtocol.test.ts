import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from '@log/shared';
import { apiflcTransactionProtocol as P } from './transactionProtocol.js';

const log = (raw: string): ParsedLog =>
  ({ raw, source: 'cloudwatch', stream: '/aws/lambda/adt-fca-d1-api_gateway_handler', timestamp: 0 } as unknown as ParsedLog);

test('protocol shape is REQUEST -> RESPONSE (no ACK)', () => {
  assert.equal(P.id, 'apiflc');
  assert.equal(P.initial, 'REQUEST');
  assert.deepEqual(P.phases, ['RESPONSE']);
  assert.deepEqual(P.allPhases, ['REQUEST', 'RESPONSE']);
});

test('eventOf reads structured JSON request/response correlated by correlationId', () => {
  const req = P.eventOf(log('{"type":"REQUEST","correlationId":"abc-123"}'));
  assert.deepEqual(req, { type: 'REQUEST', corrId: 'abc-123', ackCode: undefined });
  const resp = P.eventOf(log('{"messageType":"response","correlationId":"abc-123","status":200}'));
  assert.deepEqual(resp, { type: 'RESPONSE', corrId: 'abc-123', ackCode: '200' });
  // The API Gateway request id is a fallback when correlationId is absent.
  const viaReqId = P.eventOf(log('{"type":"REQUEST","requestId":"req-9"}'));
  assert.equal(viaReqId?.corrId, 'req-9');
});

test('eventOf reads API Gateway execution-log text', () => {
  const req = P.eventOf(log('(abc12345) Starting execution for request'));
  assert.deepEqual(req, { type: 'REQUEST', corrId: 'abc12345', ackCode: undefined });
  const resp = P.eventOf(log('(abc12345) Method completed with status: 502'));
  assert.deepEqual(resp, { type: 'RESPONSE', corrId: 'abc12345', ackCode: '502' });
});

test('API Gateway "Method request ..." noise lines are NOT counted as REQUEST', () => {
  assert.equal(P.eventOf(log('(abc12345) Method request path: {aba_t=052001633}')), undefined);
  assert.equal(P.eventOf(log('(abc12345) Method request headers: {Accept=*/*}')), undefined);
});

test('handler logs correlate REQUEST/RESPONSE by correlationID', () => {
  const req = P.eventOf(log('2026-07-02T04:34:43Z 45e5ece0 INFO correlationID: 1234; FedLine Request: {}'));
  assert.deepEqual(req, { type: 'REQUEST', corrId: '1234', ackCode: undefined });
  const resp = P.eventOf(log('2026-07-02T04:34:48Z 45e5ece0 INFO correlationID: 1234; Response from Data Services:'));
  assert.deepEqual(resp, { type: 'RESPONSE', corrId: '1234', ackCode: undefined });
  // Non request/response handler lines are ignored.
  assert.equal(P.eventOf(log('45e5ece0 INFO correlationID: 1234; =====Process=====')), undefined);
});

test('eventOf ignores unrelated logs', () => {
  assert.equal(P.eventOf(log('just some plain log line')), undefined);
});

test('isSuccess: 2xx/3xx + OK-style pass, 4xx/5xx + failures rejected', () => {
  for (const ok of [undefined, '200', '201', '302', 'OK', 'SUCCESS']) {
    assert.equal(P.isSuccess(ok), true, `expected success for ${ok}`);
  }
  for (const bad of ['400', '404', '500', '502', 'FAILED']) {
    assert.equal(P.isSuccess(bad), false, `expected failure for ${bad}`);
  }
});
