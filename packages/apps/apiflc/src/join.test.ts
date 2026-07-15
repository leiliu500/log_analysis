import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from '@log/shared';
import { apiflcRelatedLogs, apiflcIdsOf } from './join.js';
import { apiflcHttpOutcomes } from './httpOutcomes.js';

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
