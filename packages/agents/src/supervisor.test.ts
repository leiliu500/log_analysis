import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAnalyticalLogQuery } from './supervisor.js';

test('count/window log questions are analytical (→ analyze_logs)', () => {
  for (const q of [
    'How many requests sent in the last 10 minutes',
    'how many acks in the past hour',
    'list all messageId in the last 5 minutes',
    'show messageIds for the recent 15 minutes',
    'which responses were sent in the last 30 minutes',
    'requests in the last 2 hours',
  ]) {
    assert.equal(isAnalyticalLogQuery(q), true, q);
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
