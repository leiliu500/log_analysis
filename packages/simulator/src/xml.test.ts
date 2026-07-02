import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTag, setTag, messageType, splitMessages, bumpId } from './xml.js';

const REQ = `<ns2:cashMessage xmlns:ns2="http://www.frbsf.org/20130926/cashMessage">
  <header>
    <messageType>REQUEST</messageType>
    <messageId>FCC-USSS-28090845</messageId>
    <sendTime>2026-06-30T22:14:31.836Z</sendTime>
  </header>
</ns2:cashMessage>`;

test('extracts messageType and messageId (namespace-tolerant)', () => {
  assert.equal(messageType(REQ), 'REQUEST');
  assert.equal(getTag(REQ, 'messageId'), 'FCC-USSS-28090845');
});

test('setTag replaces a value in place', () => {
  const out = setTag(REQ, 'messageId', 'FCC-USSS-28090846');
  assert.equal(getTag(out, 'messageId'), 'FCC-USSS-28090846');
  assert.ok(out.includes('<messageType>REQUEST</messageType>'));
});

test('bumpId increments the last numeric run, preserving format', () => {
  assert.equal(bumpId('FCC-USSS-28090845', 0), 'FCC-USSS-28090845');
  assert.equal(bumpId('FCC-USSS-28090845', 1), 'FCC-USSS-28090846');
  assert.equal(bumpId('FCC-USSS-28090845', 5), 'FCC-USSS-28090850');
  assert.equal(bumpId('MSG-007', 5), 'MSG-012'); // zero-pad preserved
  assert.equal(bumpId('noDigits', 2), 'noDigits-2');
});

test('splitMessages separates concatenated docs', () => {
  const ack = REQ.replace('REQUEST', 'ACK').replace('<messageId>FCC-USSS-28090845</messageId>', '<messageId>ACK-1</messageId>\n    <initMessageId>FCC-USSS-28090845</initMessageId>');
  const parts = splitMessages(REQ + '\n' + ack);
  assert.equal(parts.length, 2);
  assert.equal(messageType(parts[0]!), 'REQUEST');
  assert.equal(messageType(parts[1]!), 'ACK');
  assert.equal(getTag(parts[1]!, 'initMessageId'), 'FCC-USSS-28090845');
});
