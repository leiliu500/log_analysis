import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from '@log/shared';
import { makeParsedLog } from '@log/shared';
import {
  parseApiflcCorrelationId,
  parseApiflcCount,
  parseApiflcGroups,
  parseApiflcOutcome,
  synthesizeApiflcFromRequest,
} from './simulateApiflc.js';
import { apiflcRelatedLogs } from './join.js';
import { apiflcDeriveOutcome } from './httpOutcomes.js';
import { apiflcTransactionProtocol } from './transactionProtocol.js';

const HANDLER = '/aws/lambda/adt-fca-d1-api_gateway_handler';
const AUTHORIZER = '/aws/lambda/adt-fca-d1-api_gateway_authorizer';
const EXECUTION = 'API-Gateway-Execution-Logs_9ioz6z9om1/d1';

/** Flatten synthesized {group, samples} targets into ParsedLogs (as ingestion would). */
function toLogs(targets: Array<{ group: string; samples: string }> | undefined): ParsedLog[] {
  assert.ok(targets, 'expected synthesized targets');
  const logs: ParsedLog[] = [];
  let ts = 0;
  for (const t of targets!) {
    for (const line of t.samples.split('\n')) logs.push(makeParsedLog(t.group, (ts += 1000), line));
  }
  return logs;
}

test('parsers read correlationID, outcome, count and groups from a generative request', () => {
  assert.equal(parseApiflcCorrelationId('... with correlation id=1234 with completed success'), '1234');
  assert.equal(parseApiflcCorrelationId('correlationID 5678'), '5678');

  assert.equal(parseApiflcOutcome('... with completed success'), 'success');
  assert.equal(parseApiflcOutcome('... with completed response failure'), 'failure');
  assert.equal(parseApiflcOutcome('... correlation id=5678 without response 200'), 'no-response');

  assert.equal(parseApiflcCount('simulate apiflc logs ...'), 1);
  assert.equal(parseApiflcCount('simulate 3 apiflc transaction sets ...'), 3);

  assert.deepEqual(parseApiflcGroups('handler, authorizer, api-gateway execution logs'), [
    HANDLER,
    AUTHORIZER,
    EXECUTION,
  ]);
});

test('(4) success: full call across three groups, joins, derives completed (HTTP 200)', () => {
  const targets = synthesizeApiflcFromRequest(
    'simulate apiflc handler, authorizer, api-gateway execution logs with correlation id=1234 with completed success',
  );
  assert.deepEqual(targets!.map((t) => t.group), [HANDLER, AUTHORIZER, EXECUTION]);

  const logs = toLogs(targets);
  // The handler REQUEST and RESPONSE are recognized as protocol events on the correlationID.
  const events = logs.map((l) => apiflcTransactionProtocol.eventOf(l)).filter(Boolean);
  assert.ok(events.some((e) => e!.type === 'REQUEST' && e!.corrId === '1234'));
  assert.ok(events.some((e) => e!.type === 'RESPONSE' && e!.corrId === '1234'));

  // The join ties all three groups' logs to correlationID 1234.
  const related = apiflcRelatedLogs('1234', logs);
  assert.ok(related.some((l) => l.stream === HANDLER));
  assert.ok(related.some((l) => l.stream === AUTHORIZER));
  assert.ok(related.some((l) => l.stream === EXECUTION));

  const derived = apiflcDeriveOutcome('1234', related);
  assert.equal(derived.status, 'completed');
  assert.match(derived.detail ?? '', /HTTP 200/);
});

test('(5) failure: gateway HTTP 500 → derives failed', () => {
  const logs = toLogs(
    synthesizeApiflcFromRequest(
      'simulate apiflc handler, authorizer, api-gateway execution logs with correlation id=1234 with completed response failure',
    ),
  );
  const related = apiflcRelatedLogs('1234', logs);
  const derived = apiflcDeriveOutcome('1234', related);
  assert.equal(derived.status, 'failed');
  assert.match(derived.detail ?? '', /HTTP 500/);
});

test('(6) no-response: no HTTP status, no RESPONSE → outcome unknown (agent will time out)', () => {
  const targets = synthesizeApiflcFromRequest(
    'simulate apiflc handler, authorizer, api-gateway execution logs with correlation id=5678 without response 200',
  );
  const logs = toLogs(targets);

  // No line carries a gateway HTTP status or a handler RESPONSE.
  assert.ok(!logs.some((l) => /method completed with status|received response\.\s*status/i.test(l.raw)));
  const events = logs.map((l) => apiflcTransactionProtocol.eventOf(l)).filter(Boolean);
  assert.ok(events.some((e) => e!.type === 'REQUEST' && e!.corrId === '5678'));
  assert.ok(!events.some((e) => e!.type === 'RESPONSE'));

  // Still joins across groups (via X-Correlation-ID and the X-Ray trace id)...
  const related = apiflcRelatedLogs('5678', logs);
  assert.ok(related.some((l) => l.stream === AUTHORIZER));
  // ...but the logs prove no outcome.
  const derived = apiflcDeriveOutcome('5678', related);
  assert.equal(derived.status, 'unknown');
});

test('a pasted raw-log request is left to the verbatim path (returns undefined)', () => {
  const raw = '(68f54c61-3e54-4e02-8ccf-2fbc14576104) Method completed with status: 200';
  assert.equal(synthesizeApiflcFromRequest(raw), undefined);
  // And a request with no correlationID has nothing to correlate on.
  assert.equal(synthesizeApiflcFromRequest('simulate an apiflc handler log'), undefined);
});

test('(4)+(5)+(6) in one prompt: all three commands are synthesized, not just the first', () => {
  const prompt = [
    '(4) simulate apiflc handler, authorizer, api-gateway execution logs with correlation id=1234 with completed success',
    '(5) simulate apiflc handler, authorizer, api-gateway execution logs with correlation id=1234 with completed response failure',
    '(6) simulate apiflc handler, authorizer, api-gateway execution logs with correlation id=5678 without response 200',
  ].join('\n');
  const targets = synthesizeApiflcFromRequest(prompt);
  const logs = toLogs(targets);

  // All three groups are still targeted, merged across the three commands.
  assert.deepEqual([...new Set(targets!.map((t) => t.group))].sort(), [EXECUTION, AUTHORIZER, HANDLER].sort());

  // Command (4) success and (5) failure both landed for id 1234: a 200 AND a 500.
  const call1234 = apiflcRelatedLogs('1234', logs);
  assert.ok(call1234.some((l) => /method completed with status: 200/i.test(l.raw)), '(4) success 200 present');
  assert.ok(call1234.some((l) => /method completed with status: 500/i.test(l.raw)), '(5) failure 500 present');

  // Command (6) no-response for id 5678: joined across groups, but no HTTP status → unknown.
  const call5678 = apiflcRelatedLogs('5678', logs);
  assert.ok(call5678.some((l) => l.stream === HANDLER) && call5678.some((l) => l.stream === AUTHORIZER));
  assert.ok(!call5678.some((l) => /method completed with status|received response\.\s*status/i.test(l.raw)));
  assert.equal(apiflcDeriveOutcome('5678', call5678).status, 'unknown');
});

test('pasted reference logs + simulate commands: the raw paste is dropped, commands still run', () => {
  const prompt = [
    '(1) apiflc handler log: /aws/lambda/adt-fca-d1-api_gateway_handler',
    '2026-07-02T04:34:43.329Z 45e5ece0-7dbe-490a-880b-38670acab559 INFO correlationID: 9999; FedLine Request: {}',
    '(2) apiflc api-gateway execution log',
    '(68f54c61-3e54-4e02-8ccf-2fbc14576104) Method completed with status: 200',
    '(3) simulate apiflc handler, authorizer, api-gateway execution logs with correlation id=5678 without response 200',
  ].join('\n');
  const logs = toLogs(synthesizeApiflcFromRequest(prompt));
  // The synthesized command (id 5678) ran; the pasted reference id 9999 was NOT synthesized.
  assert.ok(apiflcRelatedLogs('5678', logs).length > 0);
  assert.equal(apiflcRelatedLogs('9999', logs).length, 0);
});

test('count>1 generates distinct correlationIDs that do not entangle in the join', () => {
  const logs = toLogs(
    synthesizeApiflcFromRequest('simulate 2 apiflc transaction sets with correlation id=1234 with completed success'),
  );
  // Set 1 (1234) and set 2 (1235) each resolve to their own call only.
  const first = apiflcRelatedLogs('1234', logs);
  const second = apiflcRelatedLogs('1235', logs);
  assert.ok(first.length > 0 && second.length > 0);
  assert.ok(!first.some((l) => l.raw.includes('1235')));
  assert.ok(!second.some((l) => l.raw.includes('1234')));
});
