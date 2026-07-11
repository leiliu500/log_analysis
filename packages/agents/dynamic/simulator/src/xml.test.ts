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

test('splitMessages handles truncated roots + mixed prefixes + xml prologue', () => {
  // Real-world shape: request has no root close and no prologue; ack/response
  // use a different prefix, an <?xml?> prologue, and also no root close.
  const blob = `<ns2:cashMessage xmlns:ns2="http://x">
  <header><messageType>REQUEST</messageType><messageId>FCC-USSS-28090845</messageId></header>
  <payload></payload>
<?xml version="1.0" encoding="UTF-8"?><NS1:cashMessage xmlns:NS1="http://x">
  <header><messageType>ACK</messageType><messageId>SIM-USSS-4764</messageId></header>
  <payload><cashAcknowledgement><initMessageId>FCC-USSS-28090845</initMessageId></cashAcknowledgement></payload>
<?xml version="1.0" encoding="UTF-8"?><NS1:cashMessage xmlns:NS1="http://x">
  <header><messageType>RESPONSE</messageType><messageId>SIM-USSS-4774</messageId></header>
  <payload><cashAcknowledgement><initMessageId>FCC-USSS-28090845</initMessageId></cashAcknowledgement></payload>`;
  const parts = splitMessages(blob);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map(messageType), ['REQUEST', 'ACK', 'RESPONSE']);
  // Roots are closed and each message keeps its own ids.
  assert.ok(parts[0]!.includes('</ns2:cashMessage>'));
  assert.ok(parts[1]!.includes('</NS1:cashMessage>'));
  assert.equal(getTag(parts[1]!, 'initMessageId'), 'FCC-USSS-28090845');
  assert.equal(getTag(parts[2]!, 'messageId'), 'SIM-USSS-4774');
});

test('splitMessages ignores leading labels and trailing junk (no extra message)', () => {
  const blob = `(1) Sample Request:
<ns2:cashMessage xmlns:ns2="http://x">
  <header><messageType>REQUEST</messageType><messageId>FCC-USSS-28090845</messageId></header>
  <payload></payload>
(2) Sample ACK:
<?xml version="1.0"?><NS1:cashMessage xmlns:NS1="http://x">
  <header><messageType>ACK</messageType><messageId>SIM-USSS-4764</messageId></header>
  <payload><cashAcknowledgement><initMessageId>FCC-USSS-28090845</initMessageId></cashAcknowledgement></payload>
(3) Sample Response:
<?xml version="1.0"?><NS1:cashMessage xmlns:NS1="http://x">
  <header><messageType>RESPONSE</messageType><messageId>SIM-USSS-4774</messageId></header>
  <payload><cashAcknowledgement><initMessageId>FCC-USSS-28090845</initMessageId></cashAcknowledgement></payload>
`;
  const parts = splitMessages(blob);
  assert.equal(parts.length, 3); // NOT 4 — the leading/label text is dropped
  assert.deepEqual(parts.map(messageType), ['REQUEST', 'ACK', 'RESPONSE']);
  // No label text leaked into a message, and roots are closed.
  assert.ok(!parts[0]!.includes('Sample ACK'));
  assert.ok(parts[0]!.trim().endsWith('</ns2:cashMessage>'));
});

test('splitMessages separates concatenated docs', () => {
  const ack = REQ.replace('REQUEST', 'ACK').replace('<messageId>FCC-USSS-28090845</messageId>', '<messageId>ACK-1</messageId>\n    <initMessageId>FCC-USSS-28090845</initMessageId>');
  const parts = splitMessages(REQ + '\n' + ack);
  assert.equal(parts.length, 2);
  assert.equal(messageType(parts[0]!), 'REQUEST');
  assert.equal(messageType(parts[1]!), 'ACK');
  assert.equal(getTag(parts[1]!, 'initMessageId'), 'FCC-USSS-28090845');
});
