import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecord } from './parser.js';
import { classifyAnomaly } from './anomalies.js';
import { buildTransactions, transactionAnomalies } from './transactions.js';
import type { ParsedLog, RawLogRecord, TransactionProtocol } from '@log/shared';

const rec = (raw: string, ts = Date.now()): RawLogRecord => ({
  source: 'cloudwatch',
  stream: '/sim/cashMessage',
  timestamp: ts,
  raw,
  attributes: {},
});

/** A test protocol mirroring SCP's REQUEST → ACK → RESPONSE shape. */
const tag = (raw: string, t: string): string | undefined =>
  raw.match(new RegExp(`<(?:[\\w.-]+:)?${t}>\\s*([^<]+?)\\s*</`, 'i'))?.[1];

const P: TransactionProtocol = {
  id: 'test',
  initial: 'REQUEST',
  phases: ['ACK', 'RESPONSE'],
  allPhases: ['REQUEST', 'ACK', 'RESPONSE'],
  eventOf(log: ParsedLog) {
    const type = tag(log.raw, 'messageType')?.toUpperCase();
    if (type !== 'REQUEST' && type !== 'ACK' && type !== 'RESPONSE') return undefined;
    const corrId = type === 'REQUEST' ? tag(log.raw, 'messageId') : tag(log.raw, 'initMessageId');
    if (!corrId) return undefined;
    return { type, corrId, ackCode: tag(log.raw, 'ackCode') };
  },
  isSuccess: (c?: string) => !c || /^(OK|SUCCESS|PROCESSED_SUCCESSFULLY|ACCEPTED|COMPLETE|COMPLETED)$/i.test(c),
};

const msg = (type: string, id: string, init?: string, ackCode?: string) =>
  `<ns2:cashMessage xmlns:ns2="http://x"><header><messageType>${type}</messageType><messageId>${id}</messageId>${
    init ? `<initMessageId>${init}</initMessageId>` : ''
  }</header>${ackCode ? `<payload><cashAcknowledgement><ackCode>${ackCode}</ackCode></cashAcknowledgement></payload>` : ''}</ns2:cashMessage>`;

test('normal cashMessage traffic is NOT an anomaly', () => {
  for (const type of ['REQUEST', 'ACK', 'RESPONSE']) {
    assert.equal(classifyAnomaly(parseRecord(rec(msg(type, 'FCC-1', type === 'REQUEST' ? undefined : 'FCC-1', type === 'REQUEST' ? undefined : 'OK')))), undefined);
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

test('complete successful transaction produces no anomaly', () => {
  const now = Date.now();
  const logs = [
    parseRecord(rec(msg('REQUEST', 'FCC-100'), now - 120_000)),
    parseRecord(rec(msg('ACK', 'SIM-1', 'FCC-100', 'OK'), now - 119_000)),
    parseRecord(rec(msg('RESPONSE', 'SIM-2', 'FCC-100', 'PROCESSED_SUCCESSFULLY'), now - 118_000)),
  ];
  assert.equal(transactionAnomalies(buildTransactions(logs, P), P, 60_000, now).length, 0);
});

test('incomplete / rejected / duplicate transactions are anomalies', () => {
  const now = Date.now();
  // incomplete: request only, past grace
  const incomplete = [parseRecord(rec(msg('REQUEST', 'FCC-200'), now - 120_000))];
  const a1 = transactionAnomalies(buildTransactions(incomplete, P), P, 60_000, now);
  assert.equal(a1.length, 1);
  assert.match(a1[0]!.reason, /missing ACK and RESPONSE/i);

  // rejected: ackCode not OK
  const rejected = [
    parseRecord(rec(msg('REQUEST', 'FCC-300'), now - 120_000)),
    parseRecord(rec(msg('ACK', 'SIM-3', 'FCC-300', 'REJECTED'), now - 119_000)),
    parseRecord(rec(msg('RESPONSE', 'SIM-4', 'FCC-300', 'FAILED'), now - 118_000)),
  ];
  const a2 = transactionAnomalies(buildTransactions(rejected, P), P, 60_000, now);
  assert.equal(a2.length, 1);
  assert.match(a2[0]!.reason, /rejected|failed/i);

  // duplicate request id
  const dup = [
    parseRecord(rec(msg('REQUEST', 'FCC-400'), now - 120_000)),
    parseRecord(rec(msg('REQUEST', 'FCC-400'), now - 119_000)),
  ];
  const a3 = transactionAnomalies(buildTransactions(dup, P), P, 60_000, now);
  assert.equal(a3.length, 1);
  assert.match(a3[0]!.reason, /duplicate/i);
});

test('very recent incomplete request is not yet flagged (grace window)', () => {
  const now = Date.now();
  const recent = [parseRecord(rec(msg('REQUEST', 'FCC-500'), now - 5_000))];
  assert.equal(transactionAnomalies(buildTransactions(recent, P), P, 60_000, now).length, 0);
});
