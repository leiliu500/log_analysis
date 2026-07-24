import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from '@log/shared';
import { citedIds, groundAnswer } from './qa.js';

const log = (raw: string): ParsedLog => ({ raw, message: raw, id: raw, source: 'cloudwatch', stream: 's', timestamp: 1, level: 'info' }) as unknown as ParsedLog;
const LOGS = [
  log('<messageId>1234</messageId> ... REQUEST'),
  log('correlationID: ABCD-99; Response from Data Services'),
];

test('citedIds pulls the ids an answer presents as real', () => {
  const ids = citedIds('The messageId=1234 completed, but correlationID: 9999 failed and id: ABCD-99 is fine.');
  assert.ok(ids.includes('1234'));
  assert.ok(ids.includes('9999'));
  assert.ok(ids.includes('ABCD-99'));
});

test('groundAnswer leaves an answer untouched when every cited id is in the logs', () => {
  const { answer, ungrounded } = groundAnswer('messageId=1234 and correlationID: ABCD-99 are present.', LOGS);
  assert.deepEqual(ungrounded, []);
  assert.ok(!answer.includes('Unverified'));
});

test('groundAnswer flags a fabricated id not present in any retrieved log', () => {
  const { answer, ungrounded } = groundAnswer('messageId=1234 is fine but correlationID=9999 also completed.', LOGS);
  assert.deepEqual(ungrounded, ['9999']);
  assert.match(answer, /Unverified/);
  assert.match(answer, /9999/);
});

test('groundAnswer never flags an id that genuinely appears in the log text', () => {
  // 1234 appears only inside the <messageId> XML — whole-token match must still find it.
  const { ungrounded } = groundAnswer('The request messageId=1234 was received.', LOGS);
  assert.deepEqual(ungrounded, []);
});
