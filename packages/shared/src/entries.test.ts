import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from './logs.js';
import { coalesceEntries, isContinuationLine } from './entries.js';

let t = 0;
const mk = (stream: string, raw: string): ParsedLog =>
  ({ raw, message: raw, source: 'cloudwatch', stream, timestamp: ++t, level: 'info' }) as unknown as ParsedLog;

test('isContinuationLine: what starts an entry vs. what continues one', () => {
  for (const l of [
    '2026-07-02T04:34:48.381Z 45e5ece0-7dbe-490a-880b-38670acab559 INFO correlationID: 1234; Response from Data Services:',
    '(68f54c61-3e54-4e02-8ccf-2fbc14576104) Method completed with status: 200',
    'START RequestId: 2bef85bf-6cd7-4ea4-a9d6-64cd70de90c4 Version: $LATEST',
    'END RequestId: 2bef85bf-6cd7-4ea4-a9d6-64cd70de90c4',
    'REPORT RequestId: 2bef85bf-6cd7-4ea4-a9d6-64cd70de90c4 Duration: 613.37 ms',
  ]) {
    assert.equal(isContinuationLine(l), false, `starts an entry: ${l}`);
  }
  for (const l of [
    '{ "result": { "reportDataList": [] } }',
    "Payload: '{\"headerParameters\":{}}'",
    'XRAY TraceId: 1-6a45ea62-54e4e5dd10e9b6af71959157 SegmentId: 8b16dc2be0c1976f Sampled: true',
    "correlationID: '1234',",
  ]) {
    assert.equal(isContinuationLine(l), true, `continues an entry: ${l}`);
  }
});

test('a body logged as its own event is coalesced into its header entry', () => {
  const entries = coalesceEntries([
    mk('h', '2026-07-02T04:34:48.381Z 45e5ece0 INFO correlationID: 1234; Response from Data Services:'),
    mk('h', '{ "result": { "reportDataList": [ 1, 2 ] } }'),
    mk('h', 'REPORT RequestId: 45e5ece0 Duration: 5051.55 ms'),
  ]);
  assert.equal(entries.length, 2, 'header+body are one entry; REPORT starts its own');
  assert.match(entries[0]!.raw, /Response from Data Services:\n\{ "result"/);
  assert.equal(entries[0]!.lines.length, 2);
  assert.ok(!entries[0]!.raw.includes('REPORT'), 'REPORT must not be swallowed into the body');
});

// The authorizer's request id and trace id arrive as separate events; coalescing is
// what puts them in one entry, which is the only reason an id-join can link them.
test('REPORT and its XRAY TraceId line coalesce into one entry', () => {
  const entries = coalesceEntries([
    mk('a', 'REPORT RequestId: 2bef85bf-6cd7-4ea4-a9d6-64cd70de90c4 Duration: 613.37 ms'),
    mk('a', 'XRAY TraceId: 1-6a45ea62-54e4e5dd10e9b6af71959157 SegmentId: 8b16dc2be0c1976f'),
  ]);
  assert.equal(entries.length, 1);
  assert.match(entries[0]!.raw, /REPORT RequestId: 2bef85bf[\s\S]*XRAY TraceId: 1-6a45ea62/);
});

test('an entry never spans streams', () => {
  const entries = coalesceEntries([
    mk('a', '2026-07-02T04:34:48.381Z 45e5ece0 INFO header:'),
    mk('b', '{ "body": "belongs to another stream" }'),
  ]);
  assert.equal(entries.length, 2, 'a continuation from another stream must start its own entry');
});
