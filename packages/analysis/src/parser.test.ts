import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecord } from './parser.js';
import { fingerprint, templateOf } from './fingerprint.js';
import { extractEntities } from './extract.js';

test('parses JSON logs and extracts level + message', () => {
  const log = parseRecord({
    source: 'cloudwatch',
    stream: '/aws/lambda/app',
    timestamp: 1_700_000_000_000,
    raw: '{"level":"error","message":"payment gateway timeout","requestId":"abc-123"}',
    attributes: {},
  });
  assert.equal(log.level, 'error');
  assert.equal(log.message, 'payment gateway timeout');
  assert.equal(log.source, 'cloudwatch');
});

test('fingerprint is stable across variable tokens', () => {
  const a = fingerprint('user 42 failed login from 10.0.0.1');
  const b = fingerprint('user 9931 failed login from 192.168.1.7');
  assert.equal(a, b);
  assert.equal(templateOf('GET /x 200 in 456 ms'), 'GET /x <num> in <num> ms');
});

test('entity extraction finds ips and request ids', () => {
  const e = extractEntities('request_id=req-99 from 8.8.8.8 status=500');
  assert.ok(e.ip?.includes('8.8.8.8'));
  assert.ok(e.requestId?.includes('req-99'));
});
