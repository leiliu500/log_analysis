import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RawLogRecord } from '@log/shared';
import { parseBatch } from './parser.js';
import { planAgentUnits } from './agentic.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function rec(raw: string, ts: number): RawLogRecord {
  return { source: 'cloudwatch', stream: 'adt-d2-scp-log-group', timestamp: ts, raw, attributes: {} };
}

// planAgentUnits now covers ONLY non-transaction anomalies (errors + correlations);
// transactions flow through the request/ack/response lifecycle instead.
test('planAgentUnits: error logs get a finding-agent, transactions do not', () => {
  const records: RawLogRecord[] = [
    rec('{"level":"error","message":"payment gateway returned 500 Internal Server Error"}', NOW - 2 * MIN),
    rec('{"level":"error","message":"payment gateway returned 500 Internal Server Error"}', NOW - 1 * MIN),
    // A cashMessage REQUEST must NOT become a planAgentUnits unit anymore.
    rec('<ns:cashMessage xmlns:ns="x"><header><messageType>REQUEST</messageType><messageId>001</messageId></header></ns:cashMessage>', NOW - 1 * MIN),
  ];
  const units = planAgentUnits(parseBatch(records));
  assert.ok(units.some((u) => u.kind === 'error'), 'expected an error unit');
  assert.ok(
    units.every((u) => u.kind === 'error' || u.kind === 'correlation'),
    'planAgentUnits must not emit transaction units',
  );
});
