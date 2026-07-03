import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCount, parseStartId, parseMessageTypes, parseAckStatus } from './simulate.js';

const REQ4 =
  'simulate 3 request/ack/response sets with message_id=001 to 004. Make sure the first 3 request/ack/response with success and no error';
const REQ5 = 'simulate the 1 request/ack without response and ack with failure';

test('(4) 3 complete success sets starting at 001', () => {
  assert.equal(parseCount(REQ4, undefined), 3); // "3 request" wins over "001 to 004"
  assert.deepEqual(parseMessageTypes(REQ4), ['REQUEST', 'ACK', 'RESPONSE']);
  assert.equal(parseAckStatus(REQ4), 'success'); // "no error" is NOT failure
  assert.equal(parseStartId(REQ4, undefined), '001');
});

test('(5) 1 request/ack without response, ack failure', () => {
  assert.equal(parseCount(REQ5, undefined), 1);
  assert.deepEqual(parseMessageTypes(REQ5), ['REQUEST', 'ACK']); // no RESPONSE
  assert.equal(parseAckStatus(REQ5), 'failure');
});

test('count phrase beats an LLM id-range mistake', () => {
  assert.equal(parseCount('simulate 3 request/ack/response with message_id=001 to 004', 4), 3);
});

test('message-type phrase variants', () => {
  assert.deepEqual(parseMessageTypes('simulate 2 request only'), ['REQUEST']);
  assert.deepEqual(parseMessageTypes('request/ack without response'), ['REQUEST', 'ACK']);
  assert.deepEqual(parseMessageTypes('simulate 5 request/ack/response'), ['REQUEST', 'ACK', 'RESPONSE']);
});

test('ack status negation', () => {
  assert.equal(parseAckStatus('with success and no failure'), 'success');
  assert.equal(parseAckStatus('ack with failure'), 'failure');
  assert.equal(parseAckStatus('rejected transaction'), 'failure');
  assert.equal(parseAckStatus('all successful, no errors'), 'success');
});
