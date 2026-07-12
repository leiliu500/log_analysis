import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from '@log/shared';
import { apiflcHttpOutcomes } from './httpOutcomes.js';

const log = (raw: string, stream = 'x'): ParsedLog =>
  ({ raw, source: 'cloudwatch', stream, timestamp: 0 } as unknown as ParsedLog);

test('joins the 3 log groups and resolves the HTTP status to the business correlationID', () => {
  const gw = '68f54c61-3e54-4e02-8ccf-2fbc14576104'; // API-Gateway requestId (line prefix)
  const lambda = '45e5ece0-7dbe-490a-880b-38670acab559'; // handler Lambda requestId
  const authz = '2bef85bf-6cd7-4ea4-a9d6-64cd70de90c4'; // authorizer Lambda requestId
  const trace = '1-6a45ea62-54e4e5dd10e9b6af71959157'; // shared X-Ray trace

  const logs = [
    // (1) handler: correlationID 1234 + its Lambda requestId. NO gateway id, NO status.
    log(`2026-07-02T04:34:43.329Z ${lambda} INFO correlationID: 1234; FedLine Request: {...}`),
    log(`2026-07-02T04:34:48.381Z ${lambda} INFO correlationID: 1234; Response from Data Services:`),
    // (2) authorizer: its Lambda requestId + the X-Ray trace (no correlationID here).
    log(`2026-07-02T04:34:42.798Z ${authz} INFO auth response`),
    log(`XRAY TraceId: ${trace} SegmentId: 8b16dc2be0c1976f Sampled: true`),
    // (3) gateway execution: keyed by gateway requestId; carries the joins + the status.
    log(`(${gw}) Method request headers: {X-Correlation-ID=1234, User-Agent=x}`),
    log(`(${gw}) Endpoint response headers: {x-amzn-RequestId=${lambda}, X-Amzn-Trace-Id=Root=${trace}}`),
    log(`(${gw}) Received response. Status: 200, Integration latency: 5639 ms`),
    log(`(${gw}) Method completed with status: 200`),
  ];

  const out = apiflcHttpOutcomes(logs);
  assert.match(out, /API-GATEWAY HTTP OUTCOMES/);
  // The gateway status (200) resolves back to the business correlationID 1234...
  assert.match(out, /correlationID=1234: HTTP 200/);
  // ...and it is NOT reported under a bare gateway requestId.
  assert.ok(!/gateway requestId/.test(out), out);
  // The two 200 lines for the same call collapse to a single outcome.
  assert.equal((out.match(/HTTP 200/g) ?? []).length, 1);
});

test('reports a 5xx failure', () => {
  const gw = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const out = apiflcHttpOutcomes([
    log(`(${gw}) Method request headers: {X-Correlation-ID=9999}`),
    log(`(${gw}) Received response. Status: 502, Integration latency: 30 ms`),
  ]);
  assert.match(out, /correlationID=9999: HTTP 502/);
});

test('falls back to the gateway requestId when no correlationID can be joined', () => {
  const gw = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const out = apiflcHttpOutcomes([log(`(${gw}) Received response. Status: 500, Integration latency: 12 ms`)]);
  assert.match(out, /gateway requestId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee: HTTP 500/);
});

test('empty when there are no HTTP status lines', () => {
  assert.equal(apiflcHttpOutcomes([log('2026-07-02T04:34:43.329Z abc INFO correlationID: 1; FedLine Request')]), '');
});
