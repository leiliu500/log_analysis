import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAnalyticalLogQuery, isSimulateRequest } from './supervisor.js';

test('count/window log questions are analytical (→ analyze_logs)', () => {
  for (const q of [
    'How many requests sent in the last 10 minutes',
    'how many acks in the past hour',
    'list all messageId in the last 5 minutes',
    'show messageIds for the recent 15 minutes',
    'which responses were sent in the last 30 minutes',
    'requests in the last 2 hours',
    'Are there any exception or error or failure',
    'any ACK failure',
    'Which message only has ACK and no response',
    'does messageId=FCC-USSS-28090845 only has ACK with failure',
  ]) {
    assert.equal(isAnalyticalLogQuery(q), true, q);
  }
});

test('simulate requests are detected (→ simulate_logs override)', () => {
  for (const q of [
    'simulate 3 request/ack/response to adt-d2-scp-log-group',
    'Simulate 1 request/ack/response for apiflc',
    'please simulate 10 cashMessage logs',
    '<ns2:cashMessage xmlns:ns2="http://x"><header><messageType>REQUEST</messageType></header></ns2:cashMessage>',
  ]) {
    assert.equal(isSimulateRequest(q), true, q);
  }
  for (const q of ['how many requests in the last hour', 'summarize the anomalies', 'invoke scp']) {
    assert.equal(isSimulateRequest(q), false, q);
  }
});

test('findings/anomaly and action questions are NOT analytical log queries', () => {
  for (const q of [
    'how many high findings are there',
    'summarize the anomalies',
    'why did the transaction fail',
    'simulate 3 request/ack/response in the last 10 minutes',
    'invoke scp with this payload',
    'what is the status',
  ]) {
    assert.equal(isAnalyticalLogQuery(q), false, q);
  }
});
