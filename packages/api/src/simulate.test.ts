import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCount,
  parseStartId,
  parseMessageTypes,
  parseAckStatus,
  splitInstructions,
} from './simulate.js';

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

test('count tolerates an adjective, ignores id ranges', () => {
  assert.equal(parseCount('generate 3 successful request/ack/response starting at 001', undefined), 3);
  assert.equal(parseCount('3 new request/ack/response', undefined), 3);
  // "001 to 004" alone must not be read as a count of 1.
  assert.equal(parseCount('with message_id=001 to 004. Make sure the first 3 request', undefined), 3);
});

test('message-type phrase variants', () => {
  assert.deepEqual(parseMessageTypes('simulate 2 request only'), ['REQUEST']);
  assert.deepEqual(parseMessageTypes('request/ack without response'), ['REQUEST', 'ACK']);
  assert.deepEqual(parseMessageTypes('simulate 5 request/ack/response'), ['REQUEST', 'ACK', 'RESPONSE']);
});

test('(4)+(5) in one prompt split into two independent commands', () => {
  const combined = `${REQ4}\n${REQ5}`;
  const segs = splitInstructions(combined);
  assert.equal(segs.length, 2);
  // Command 1 = the 3 success sets; failure from (5) must NOT leak in.
  assert.equal(parseAckStatus(segs[0]!), 'success');
  assert.equal(parseCount(segs[0]!, undefined), 3);
  assert.deepEqual(parseMessageTypes(segs[0]!), ['REQUEST', 'ACK', 'RESPONSE']);
  // Command 2 = 1 request/ack (no response), failure.
  assert.equal(parseAckStatus(segs[1]!), 'failure');
  assert.equal(parseCount(segs[1]!, undefined), 1);
  assert.deepEqual(parseMessageTypes(segs[1]!), ['REQUEST', 'ACK']);
});

test('"(4) … (5) …" numbered format splits even without repeated "simulate"', () => {
  // Only the (4) line says "simulate"; (5) does not. Numbered markers must still split.
  const prompt =
    '(4) simulate 3 request/ack/response with message_id=001, all with success and no error\n' +
    '(5) 1 request/ack without response and ack with failure';
  const segs = splitInstructions(prompt);
  assert.equal(segs.length, 2);
  assert.equal(parseCount(segs[0]!, undefined), 3);
  assert.deepEqual(parseMessageTypes(segs[0]!), ['REQUEST', 'ACK', 'RESPONSE']);
  assert.equal(parseAckStatus(segs[0]!), 'success');
  assert.equal(parseStartId(segs[0]!, undefined), '001');
  assert.equal(parseCount(segs[1]!, undefined), 1);
  assert.deepEqual(parseMessageTypes(segs[1]!), ['REQUEST', 'ACK']);
  assert.equal(parseAckStatus(segs[1]!), 'failure');
});

test('"(4) … (5) …" all on ONE line splits (markers anywhere, not just line start)', () => {
  const prompt =
    '(4) simulate 3 request/ack/response with success ids 001 (5) 1 request/ack without response with failure';
  const segs = splitInstructions(prompt);
  assert.equal(segs.length, 2);
  assert.deepEqual(parseMessageTypes(segs[0]!), ['REQUEST', 'ACK', 'RESPONSE']);
  assert.equal(parseAckStatus(segs[0]!), 'success');
  assert.deepEqual(parseMessageTypes(segs[1]!), ['REQUEST', 'ACK']);
  assert.equal(parseAckStatus(segs[1]!), 'failure');
});

test('numbered format with NO "simulate" word still splits', () => {
  const prompt = '(1) 3 request/ack/response success\n(2) 1 request/ack without response failure';
  const segs = splitInstructions(prompt);
  assert.equal(segs.length, 2);
  assert.deepEqual(parseMessageTypes(segs[1]!), ['REQUEST', 'ACK']);
  assert.equal(parseAckStatus(segs[1]!), 'failure');
});

test('"001 to 004" / mid-line numbers are not treated as command markers', () => {
  const segs = splitInstructions('simulate 3 request/ack/response with message_id=001 to 004');
  assert.equal(segs.length, 1);
});

test('single command / XML is not split', () => {
  assert.equal(splitInstructions(REQ4).length, 1);
  assert.equal(splitInstructions('<ns2:cashMessage>simulate looking text</ns2:cashMessage>').length, 1);
});

test('ack status negation', () => {
  assert.equal(parseAckStatus('with success and no failure'), 'success');
  assert.equal(parseAckStatus('ack with failure'), 'failure');
  assert.equal(parseAckStatus('rejected transaction'), 'failure');
  assert.equal(parseAckStatus('all successful, no errors'), 'success');
});
