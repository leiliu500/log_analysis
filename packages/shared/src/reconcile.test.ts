import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHttpReconciler } from './reconcile.js';

/** A fetch stub returning a fixed status + JSON body, ignoring the request. */
const stub = (status: number, body: unknown): typeof fetch =>
  (async () => ({ status, json: async () => body })) as unknown as typeof fetch;

const input = { messageId: 'm1', agentStatus: 'completed', relatedLogs: [] };

test('disabled when no url is configured → unknown (no fetch, never blocks)', async () => {
  let called = false;
  const r = makeHttpReconciler({ fetchImpl: (async () => ((called = true), { status: 200, json: async () => ({}) })) as unknown as typeof fetch });
  const out = await r(input);
  assert.equal(out.outcome, 'unknown');
  assert.equal(called, false, 'must not call the SoR when no url is set');
});

test('SoR reports settled → completed', async () => {
  const r = makeHttpReconciler({ url: 'http://sor', fetchImpl: stub(200, { settled: true }) });
  assert.equal((await r({ ...input, agentStatus: 'failed' })).outcome, 'completed');
});

test('SoR status RETURNED → failed', async () => {
  const r = makeHttpReconciler({ url: 'http://sor', fetchImpl: stub(200, { status: 'RETURNED' }) });
  assert.equal((await r(input)).outcome, 'failed');
});

test('SoR 404 (no record) → unknown', async () => {
  const r = makeHttpReconciler({ url: 'http://sor', fetchImpl: stub(404, {}) });
  assert.equal((await r(input)).outcome, 'unknown');
});

test('inconclusive body → unknown', async () => {
  const r = makeHttpReconciler({ url: 'http://sor', fetchImpl: stub(200, { note: 'pending' }) });
  assert.equal((await r(input)).outcome, 'unknown');
});

test('network error → unknown (best-effort, never fails the pass)', async () => {
  const r = makeHttpReconciler({ url: 'http://sor', fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
  const out = await r(input);
  assert.equal(out.outcome, 'unknown');
  assert.match(out.detail ?? '', /unavailable/);
});

test('custom path + headers are applied', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const fetchImpl = (async (url: string, opts: { headers?: Record<string, string> }) => {
    seenUrl = url;
    seenAuth = opts.headers?.Authorization ?? '';
    return { status: 200, json: async () => ({ settled: false }) };
  }) as unknown as typeof fetch;
  const r = makeHttpReconciler({ url: 'http://sor/', path: (id) => `/settlement/${id}`, headers: () => ({ Authorization: 'Bearer t' }), fetchImpl });
  const out = await r({ ...input, messageId: 'ABC' });
  assert.equal(seenUrl, 'http://sor/settlement/ABC');
  assert.equal(seenAuth, 'Bearer t');
  assert.equal(out.outcome, 'failed');
});
