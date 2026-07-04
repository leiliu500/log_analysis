import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from '@log/shared';
import { directAnswer, extractWindowMinutes } from './analyze.js';

// Minimal enriched rows like answerLogQuestion builds.
const mk = (type: string, id: string, init?: string, ts = 1783119462910) => ({
  log: { timestamp: ts, level: 'info', message: '', raw: '' } as unknown as ParsedLog,
  meta: { type, messageId: id, initMessageId: init },
});

const REQS = [mk('REQUEST', '001'), mk('REQUEST', '002'), mk('REQUEST', '003'), mk('REQUEST', 'FCC-USSS-28090845')];
const ALL = [...REQS, mk('ACK', 'IM-4764', '001'), mk('RESPONSE', 'IM-4774', '001')];

test('window parsing: "last 10 minutes"', () => {
  assert.equal(extractWindowMinutes('How many requests sent in the last 10 minutes', undefined), 10);
  assert.equal(extractWindowMinutes('past 2 hours', undefined), 120);
});

test('"how many requests" counts REQUESTs and lists the REAL ids', () => {
  const a = directAnswer('How many requests sent in the last 10 minutes', 'cloudwatch', 10, ALL)!;
  assert.match(a, /^4 REQUEST message/);
  for (const id of ['001', '002', '003', 'FCC-USSS-28090845']) assert.ok(a.includes(id), `missing ${id}`);
  // Must NOT contain unrelated / fabricated ids.
  assert.ok(!/900|901|902|700/.test(a));
  // ACK/RESPONSE ids are not listed for a "requests" question.
  assert.ok(!a.includes('IM-4774'));
});

test('empty window returns a truthful "none" (never a fabricated count)', () => {
  const a = directAnswer('how many requests in the last 5 minutes', 'cloudwatch', 5, [])!;
  assert.match(a, /No REQUEST messages/);
});

test('"show all messageId" lists every id', () => {
  const a = directAnswer('show all messageId in the last 10 minutes', 'cloudwatch', 10, ALL)!;
  assert.ok(a.includes('001') && a.includes('IM-4764') && a.includes('IM-4774'));
});

test('"how many ACK and responses" counts BOTH types (not just one)', () => {
  const rows = [
    mk('ACK', 'A1', '001'),
    mk('ACK', 'A2', '002'),
    mk('RESPONSE', 'R1', '001'),
    mk('RESPONSE', 'R2', '002'),
    ...REQS,
  ];
  const a = directAnswer('How many ACK and responses received in last 1 hour', 'cloudwatch', 60, rows)!;
  // 2 ACK + 2 RESPONSE = 4, requests excluded.
  assert.match(a, /^4 messages \(2 ACK, 2 RESPONSE\)/);
  for (const id of ['A1', 'A2', 'R1', 'R2']) assert.ok(a.includes(id), `missing ${id}`);
  assert.ok(!a.includes('FCC-USSS-28090845'), 'REQUEST id must not be listed');
});

test('open-ended question falls through to the LLM (null)', () => {
  assert.equal(directAnswer('why did the transaction fail', 'cloudwatch', 10, ALL), null);
});
