import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedLog } from '@log/shared';
import { coalesceEntries } from '@log/shared';
import { scpTransactionProtocol as P, scpMessageMeta, isScpAckSuccess } from './transactionProtocol.js';

const log = (raw: string): ParsedLog =>
  ({ raw, source: 'cloudwatch', stream: 'adt-d2-scp-log-group', timestamp: 0 } as unknown as ParsedLog);

const msg = (type: string, id: string, init?: string, ackCode?: string) =>
  `<ns2:cashMessage xmlns:ns2="http://x"><header><messageType>${type}</messageType><messageId>${id}</messageId>${
    init ? `<initMessageId>${init}</initMessageId>` : ''
  }</header>${ackCode ? `<payload><cashAcknowledgement><ackCode>${ackCode}</ackCode></cashAcknowledgement></payload>` : ''}</ns2:cashMessage>`;

test('protocol shape is REQUEST -> ACK -> RESPONSE', () => {
  assert.equal(P.id, 'scp');
  assert.equal(P.initial, 'REQUEST');
  assert.deepEqual(P.phases, ['ACK', 'RESPONSE']);
  assert.deepEqual(P.allPhases, ['REQUEST', 'ACK', 'RESPONSE']);
});

test('eventOf reads a REQUEST correlated by messageId', () => {
  const e = P.eventOf(log(msg('REQUEST', 'FCC-100')));
  assert.deepEqual(e, { type: 'REQUEST', corrId: 'FCC-100', ackCode: undefined });
});

test('eventOf correlates ACK/RESPONSE by initMessageId + reads ackCode', () => {
  const ack = P.eventOf(log(msg('ACK', 'SIM-1', 'FCC-100', 'OK')));
  assert.deepEqual(ack, { type: 'ACK', corrId: 'FCC-100', ackCode: 'OK' });
  const resp = P.eventOf(log(msg('RESPONSE', 'SIM-2', 'FCC-100', 'FAILED')));
  assert.deepEqual(resp, { type: 'RESPONSE', corrId: 'FCC-100', ackCode: 'FAILED' });
});

test('eventOf ignores non-transaction logs', () => {
  assert.equal(P.eventOf(log('{"level":"error","message":"boom"}')), undefined);
});

test('isSuccess accepts OK codes and a missing code, rejects failures', () => {
  for (const ok of [undefined, 'OK', 'SUCCESS', 'PROCESSED_SUCCESSFULLY', 'ACCEPTED', 'COMPLETED']) {
    assert.equal(P.isSuccess(ok), true, `expected success for ${ok}`);
  }
  for (const bad of ['FAILED', 'REJECTED', 'NACK', 'ERROR']) {
    assert.equal(P.isSuccess(bad), false, `expected failure for ${bad}`);
  }
  assert.equal(P.isSuccess, isScpAckSuccess); // protocol reuses the exported helper
});

test('scpMessageMeta exposes messageId AND initMessageId separately (richer than eventOf)', () => {
  const ack = scpMessageMeta(log(msg('ACK', 'SIM-1', 'FCC-100', 'OK')));
  assert.deepEqual(ack, { type: 'ACK', messageId: 'SIM-1', initMessageId: 'FCC-100', ackCode: 'OK' });
  const req = scpMessageMeta(log(msg('REQUEST', 'FCC-100')));
  assert.equal(req.type, 'REQUEST');
  assert.equal(req.messageId, 'FCC-100');
  assert.equal(req.initMessageId, undefined);
});

// ---------------------------------------------------------------------------
// Multi-line delivery. CloudWatch stores ONE EVENT PER PHYSICAL LINE, so a real
// cashMessage arrives as many records and no single one carries both
// <messageType> and <messageId>. Read per record, eventOf sees neither a whole
// message nor a partial one — it returns undefined and the transaction is never
// seen at all. Simulated logs hide this by writing each message as one record.
// ---------------------------------------------------------------------------

const XML_LINES = [
  '<ns2:cashMessage xmlns:ns2="http://www.frbsf.org/20130926/cashMessage">',
  '  <header>',
  '    <transactionType>USSS</transactionType>',
  '    <messageType>REQUEST</messageType>',
  '    <messageId>FCC-USSS-00000001</messageId>',
  '    <sender>FCC</sender>',
  '  </header>',
  '</ns2:cashMessage>',
];

const rec = (raw: string, ts: number): ParsedLog =>
  ({ id: `l${ts}`, raw, message: raw, source: 'cloudwatch', stream: 'scp', timestamp: ts, level: 'info' }) as unknown as ParsedLog;

test('no single record of a multi-line cashMessage yields an event', () => {
  for (const [i, line] of XML_LINES.entries()) {
    assert.equal(P.eventOf(rec(line, i)), undefined, `line ${i} must not resolve alone`);
  }
});

test('the coalesced entry DOES yield the event', () => {
  const entries = coalesceEntries(
    XML_LINES.map((l, i) => rec(l, i)),
    (log) => P.startsEntry!(log),
  );
  assert.equal(entries.length, 1, 'the whole message is one entry');
  const whole = { ...entries[0]!.head, raw: entries[0]!.raw } as ParsedLog;
  const ev = P.eventOf(whole);
  assert.equal(ev?.type, 'REQUEST');
  assert.equal(ev?.corrId, 'FCC-USSS-00000001');
});

test('two consecutive messages stay separate entries — they must not merge', () => {
  // The failure startsEntry exists to prevent: every cashMessage line looks like a
  // continuation to the generic AWS heuristic, so a whole stream would become ONE entry
  // and every message after the first would be lost.
  const second = XML_LINES.map((l) => l.replace('REQUEST', 'ACK').replace('FCC-USSS-00000001', 'SIM-USSS-4764'));
  const logs = [...XML_LINES, ...second].map((l, i) => rec(l, i));
  const entries = coalesceEntries(logs, (log) => P.startsEntry!(log));
  assert.equal(entries.length, 2, 'one entry per message');
});
