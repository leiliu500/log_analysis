import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecord } from './parser.js';
import { classifyAnomaly } from './anomalies.js';
import type { RawLogRecord } from '@log/shared';

const rec = (raw: string, ts = Date.now()): RawLogRecord => ({
  source: 'cloudwatch',
  stream: '/sim/cashMessage',
  timestamp: ts,
  raw,
  attributes: {},
});

const msg = (type: string, id: string, init?: string, ackCode?: string) =>
  `<ns2:cashMessage xmlns:ns2="http://x"><header><messageType>${type}</messageType><messageId>${id}</messageId>${
    init ? `<initMessageId>${init}</initMessageId>` : ''
  }</header>${ackCode ? `<payload><cashAcknowledgement><ackCode>${ackCode}</ackCode></cashAcknowledgement></payload>` : ''}</ns2:cashMessage>`;

test('normal cashMessage traffic is NOT an anomaly', () => {
  for (const type of ['REQUEST', 'ACK', 'RESPONSE']) {
    assert.equal(
      classifyAnomaly(
        parseRecord(
          rec(msg(type, 'FCC-1', type === 'REQUEST' ? undefined : 'FCC-1', type === 'REQUEST' ? undefined : 'OK')),
        ),
      ),
      undefined,
    );
  }
});

test('production log anomalies are classified', () => {
  const cases: [string, string][] = [
    ['ERROR: NullPointerException at Service.process', 'exception'],
    ['request to downstream timed out after 30s', 'timeout'],
    ['connection refused to payment-gateway', 'connection'],
    ['503 service unavailable from upstream', 'dependency'],
    ['401 unauthorized: invalid token', 'auth'],
    ['429 too many requests, rate limit exceeded', 'rate_limit'],
    ['java.lang.OutOfMemoryError: Java heap space', 'resource'],
    ['container killed, exited with code 137', 'crash'],
    ['malformed XML: parse error at line 5', 'data_integrity'],
  ];
  for (const [line, cat] of cases) {
    const c = classifyAnomaly(parseRecord(rec(line)));
    assert.ok(c, `expected anomaly for: ${line}`);
    assert.equal(c!.category, cat, `line "${line}" -> ${c!.category}, expected ${cat}`);
  }
});
