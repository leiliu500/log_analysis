import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from '@log/shared';
import { scpTransactionProtocol as P } from '@log/app-scp';
import { directAnswer as da, extractWindowMinutes, isContinuationLine } from './qa.js';

// Minimal enriched rows like answerLogQuestion builds. corrId is the request's
// id (REQUEST: its own id; ACK/RESPONSE: the request id via init).
const mk = (type: string, id: string, init?: string, ackCode?: string, ts = 1783119462910) => ({
  log: { timestamp: ts, level: 'info', message: '', raw: '' } as unknown as ParsedLog,
  meta: { type, id, corrId: init ?? id, ackCode },
});

// directAnswer bound to the SCP protocol (label defaults to messageId).
const directAnswer = (
  message: string,
  source: string,
  win: number,
  enriched: ReturnType<typeof mk>[],
): string | null => da(message, source, win, enriched, P);

const REQS = [mk('REQUEST', '001'), mk('REQUEST', '002'), mk('REQUEST', '003'), mk('REQUEST', 'FCC-USSS-28090845')];
const ALL = [...REQS, mk('ACK', 'IM-4764', '001'), mk('RESPONSE', 'IM-4774', '001')];

// Scenario: 001 is a complete success tx; FCC-... has only a FAILED ack, no response.
const SCENARIO = [
  mk('REQUEST', '001'),
  mk('ACK', 'IM-4764', '001', 'OK'),
  mk('RESPONSE', 'IM-4774', '001', 'PROCESSED_SUCCESSFULLY'),
  mk('REQUEST', 'FCC-USSS-28090845'),
  mk('ACK', 'IM-4765', 'FCC-USSS-28090845', 'FAILED'),
];

test('failure/error questions delegate to the LLM (not hardcoded) → null', () => {
  // Aggregating "all failures or errors" is an interpretive answer owned by the
  // application's qa.md prompt, not directAnswer. These must fall through.
  assert.equal(directAnswer('Does scp have failure or error', 'cloudwatch', 60, SCENARIO), null);
  assert.equal(directAnswer('Are there any exception or error or failure', 'cloudwatch', 60, SCENARIO), null);
  assert.equal(directAnswer('are there any failed acks', 'cloudwatch', 60, SCENARIO), null);
});

test('completeness: which message only has ACK and no response', () => {
  const a = directAnswer('Which message only has ACK and no response', 'cloudwatch', 60, SCENARIO)!;
  assert.ok(a.includes('FCC-USSS-28090845') && /no RESPONSE/i.test(a));
  assert.ok(!a.includes('messageId=001 —'), '001 is complete, must not be listed');
});

test('specific messageId status', () => {
  const a = directAnswer('does messageId=FCC-USSS-28090845 only has ACK with failure', 'cloudwatch', 60, SCENARIO)!;
  assert.match(a, /messageId=FCC-USSS-28090845:/);
  assert.ok(/REQUEST ✓/.test(a) && /ACK ✓ \(ackCode=FAILED\)/.test(a) && /RESPONSE ✗/.test(a));
});

test('explicit messageId not in window → truthful not-found', () => {
  const a = directAnswer('does messageId=DOES-NOT-EXIST only have ACK', 'cloudwatch', 60, SCENARIO)!;
  assert.match(a, /No message with messageId=DOES-NOT-EXIST/);
});

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

// A content question about a specific id must reach the qa agent: only the agent
// sees the RAW MESSAGES block, so only it can reproduce a logged body. A phase
// checklist ("REQUEST ✓, RESPONSE ✓") is a wrong answer to "what is the response".
test('specific-id CONTENT question falls through to the LLM (null)', () => {
  for (const q of [
    'What is apiflc response in handler for correlation ID 001 ?',
    'show the response for messageId=001',
    'what was the request for correlation id 001',
    'give me the response payload for 001',
    'extract the response data for messageId=001',
  ]) {
    assert.equal(directAnswer(q, 'cloudwatch', 60, SCENARIO), null, `should fall through: ${q}`);
  }
});

// ...but a specific-id STATUS question stays deterministic (ids/phases from logs).
test('specific-id STATUS question stays on the deterministic path', () => {
  const a = directAnswer('does messageId=FCC-USSS-28090845 only has ACK with failure', 'cloudwatch', 60, SCENARIO);
  assert.ok(a && /REQUEST ✓/.test(a), 'status question must not fall through');
});

test('wantsContent: needs a phase for a bare verb, so listing questions stay deterministic', () => {
  const a = directAnswer('show all messageId in the last 10 minutes', 'cloudwatch', 10, ALL);
  assert.ok(a && a.includes('IM-4774'), 'id listing must stay deterministic');
});

// Lambda emits a multi-line log as one CloudWatch event PER LINE: the handler's
// "Response from Data Services:" header and its JSON body arrive as separate
// events ~1ms apart, and only the header carries the correlationID. Continuation
// lines must therefore be recognised, or a content answer is a bare header.
test('isContinuationLine: entry starts vs. body lines', () => {
  // Real shapes pulled from /aws/lambda/adt-fca-d1-api_gateway_handler.
  const header = '2026-07-02T04:34:48.381Z 45e5ece0-7dbe-490a-880b-38670acab559 INFO correlationID: 1234; Response from Data Services:';
  const gateway = '(68f54c61-aaaa-bbbb) Received response. Status: 200';
  const report = 'REPORT RequestId: 45e5ece0-7dbe-490a-880b-38670acab559\tDuration: 5051.55 ms';
  for (const l of [header, gateway, report]) assert.equal(isContinuationLine(l), false, `starts an entry: ${l}`);

  // The response body + the request's trailing lines — none carry the id.
  const body = '{ "result": { "reportDataList": [ { "edd": { "differenceDetail": { "adviceNumber": 7 } } } ] } }';
  const payload = 'Payload: \'{"headerParameters":{"correlation_id":"correlationID: 1234;"}}\'';
  for (const l of [body, payload]) assert.equal(isContinuationLine(l), true, `continues an entry: ${l}`);
});
