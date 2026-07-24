import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from '@log/shared';
import { apiflcRelatedLogs, apiflcIdsOf } from './join.js';
import { apiflcHttpOutcomes, apiflcDeriveOutcome } from './httpOutcomes.js';

const HANDLER = '/aws/lambda/adt-fca-d1-api_gateway_handler';
const AUTHZ = '/aws/lambda/adt-fca-d1-api_gateway_authorizer';
const GW = 'API-Gateway-Execution-Logs_9ioz6z9om1/d1';

const CORR = '1234';
const HANDLER_REQ = '45e5ece0-7dbe-490a-880b-38670acab559';
const AUTHZ_REQ = '2bef85bf-6cd7-4ea4-a9d6-64cd70de90c4';
const GW_REQ = '68f54c61-3e54-4e02-8ccf-2fbc14576104';
const TRACE = '1-6a45ea62-54e4e5dd10e9b6af71959157';

// The REAL event sequence, one CloudWatch event per physical line (verified against
// the live groups): only the FIRST line of a multi-line entry carries an id, and the
// authorizer's REPORT and XRAY TraceId lines are separate events.
let t = 0;
const mk = (stream: string, raw: string): ParsedLog =>
  ({ raw, message: raw, source: 'cloudwatch', stream, timestamp: ++t, level: 'info' }) as unknown as ParsedLog;

const LOGS: ParsedLog[] = [
  // --- authorizer: no correlationID anywhere; request id and trace id on different events
  mk(AUTHZ, `2026-07-02T04:34:42.798Z ${AUTHZ_REQ} INFO auth response from :`),
  mk(AUTHZ, '{ "principalId": "Fed Cash Analytics", "policyDocument": { "Statement": [ { "Effect": "Allow" } ] } }'),
  mk(AUTHZ, `END RequestId: ${AUTHZ_REQ}`),
  mk(AUTHZ, `REPORT RequestId: ${AUTHZ_REQ} Duration: 613.37 ms Billed Duration: 614 ms`),
  mk(AUTHZ, `XRAY TraceId: ${TRACE} SegmentId: 8b16dc2be0c1976f Sampled: true`),
  // --- gateway: the only line carrying the correlationID, plus the trace + handler req id
  mk(GW, `(${GW_REQ}) Method request headers: {Accept=*/*, X-Correlation-ID=${CORR}, X-Amzn-Trace-Id=Root=${TRACE}}`),
  mk(GW, `(${GW_REQ}) Received response. Status: 200, Integration latency: 5639 ms`),
  mk(GW, `(${GW_REQ}) Endpoint response headers: {x-amzn-RequestId=${HANDLER_REQ}}`),
  mk(GW, `(${GW_REQ}) Method completed with status: 200`),
  // --- handler: correlationID + its own lambda request id; body on a separate event
  mk(HANDLER, `2026-07-02T04:34:48.381Z ${HANDLER_REQ} INFO correlationID: ${CORR}; Response from Data Services:`),
  mk(HANDLER, '{ "result": { "reportDataList": [ { "edd": { "differenceDesc": "Counterfeit" } } ] } }'),
  // --- an unrelated call that must NOT be pulled in
  mk(HANDLER, '2026-07-02T05:00:00.000Z aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee INFO correlationID: 9999; FedLine Request: {'),
];

test('apiflcIdsOf namespaces each id kind', () => {
  assert.deepEqual(apiflcIdsOf(`(${GW_REQ}) Method request headers: {X-Correlation-ID=${CORR}, X-Amzn-Trace-Id=Root=${TRACE}}`).sort(), [
    `corr:${CORR}`,
    `req:${GW_REQ}`,
    `trace:${TRACE}`,
  ]);
});

// The whole point: a user gives the business correlationID, which appears in only
// ONE gateway line and in NO authorizer line. Resolving the call must chain
// corr -> gateway requestId -> X-Ray trace -> authorizer requestId.
test('correlationID resolves the whole call across all three log groups', () => {
  const related = apiflcRelatedLogs(CORR, LOGS);
  const raw = related.map((l) => l.raw).join('\n');

  assert.ok(related.some((l) => l.stream === HANDLER), 'handler lines missing');
  assert.ok(related.some((l) => l.stream === GW), 'gateway lines missing');
  assert.ok(related.some((l) => l.stream === AUTHZ), 'authorizer lines missing — the trace-id chain broke');

  // The content each question actually asks for.
  assert.match(raw, /reportDataList/, 'handler response body missing');
  assert.match(raw, /Method completed with status: 200/, 'gateway HTTP status missing');
  assert.match(raw, /"Effect": "Allow"/, 'authorizer policy body missing');

  // The unrelated call must not leak in.
  assert.ok(!raw.includes('9999'), 'unrelated correlationID leaked into the call');
});

test('the same call resolves from any of its ids (gateway / handler / authorizer / trace)', () => {
  for (const id of [GW_REQ, HANDLER_REQ, TRACE, AUTHZ_REQ]) {
    const raw = apiflcRelatedLogs(id, LOGS)
      .map((l) => l.raw)
      .join('\n');
    assert.match(raw, /reportDataList/, `handler body unreachable from ${id}`);
    assert.match(raw, /"Effect": "Allow"/, `authorizer body unreachable from ${id}`);
  }
});

test('an id that is not in the window resolves to nothing', () => {
  assert.deepEqual(apiflcRelatedLogs('does-not-exist', LOGS), []);
});

test('httpOutcomes attributes the HTTP status to the business correlationID', () => {
  assert.match(apiflcHttpOutcomes(LOGS), new RegExp(`correlationID=${CORR}: HTTP 200`));
});

// --- Join correctness properties (the join is a correctness dependency of both the
// Log Assistant and the validation engine; over-linking = a finding/outcome attached
// to the wrong transaction, under-linking = one silently dropped). --------------------

// A second, fully independent call in the same window — must never entangle with the first.
const CORR2 = '5678';
const GW_REQ2 = '11111111-2222-3333-4444-555555555555';
const HANDLER_REQ2 = '99999999-8888-7777-6666-555555555555';
const TRACE2 = '1-6b45ea62-64e4e5dd10e9b6af71959158';
const LOGS2: ParsedLog[] = [
  ...LOGS.filter((l) => !l.raw.includes('9999')), // drop the earlier bare unrelated line
  mk(GW, `(${GW_REQ2}) Method request headers: {X-Correlation-ID=${CORR2}, X-Amzn-Trace-Id=Root=${TRACE2}}`),
  mk(GW, `(${GW_REQ2}) Method completed with status: 500`),
  mk(GW, `(${GW_REQ2}) Endpoint response headers: {x-amzn-RequestId=${HANDLER_REQ2}}`),
  mk(HANDLER, `2026-07-02T04:40:00.000Z ${HANDLER_REQ2} INFO correlationID: ${CORR2}; Response from Data Services:`),
];

test('property: a log line is never attributed to two different transactions (no over-linking)', () => {
  const a = new Set(apiflcRelatedLogs(CORR, LOGS2));
  const b = new Set(apiflcRelatedLogs(CORR2, LOGS2));
  const overlap = [...a].filter((l) => b.has(l));
  assert.deepEqual(overlap, [], 'two distinct calls share log lines — the join over-linked');
  assert.ok(a.size > 0 && b.size > 0, 'both calls must resolve to some lines');
});

test('property: every id of a call resolves to the identical line set (consistent components)', () => {
  const canonical = new Set(apiflcRelatedLogs(CORR, LOGS2));
  for (const id of [GW_REQ, HANDLER_REQ, TRACE, AUTHZ_REQ]) {
    const s = new Set(apiflcRelatedLogs(id, LOGS2));
    assert.equal(s.size, canonical.size, `resolving from ${id} yields a different-sized set`);
    for (const l of s) assert.ok(canonical.has(l), `resolving from ${id} pulled a line not in the correlationID's set`);
  }
});

test('property: resolution is idempotent', () => {
  assert.deepEqual(apiflcRelatedLogs(CORR, LOGS2), apiflcRelatedLogs(CORR, LOGS2));
});

test('deriveOutcome: 200 → completed, 500 → failed, attributed to the right call', () => {
  const ok = apiflcDeriveOutcome(CORR, apiflcRelatedLogs(CORR, LOGS2));
  assert.equal(ok.status, 'completed');
  assert.match(ok.detail ?? '', /HTTP 200/);
  assert.ok(ok.phasesSeen.includes('RESPONSE'));

  const bad = apiflcDeriveOutcome(CORR2, apiflcRelatedLogs(CORR2, LOGS2));
  assert.equal(bad.status, 'failed');
  assert.match(bad.detail ?? '', /HTTP 500/);
});

test('deriveOutcome: an id with no logs is unknown, never a guess', () => {
  const d = apiflcDeriveOutcome('nope', apiflcRelatedLogs('nope', LOGS2));
  assert.equal(d.status, 'unknown');
  assert.deepEqual(d.evidenceLogIds, []);
});
