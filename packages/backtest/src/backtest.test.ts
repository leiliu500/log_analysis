import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FailureMode } from '@log/shared';
import { corpus } from './corpus.js';
import { runBacktest } from './runner.js';

test('gold-set backtest: zero false positives and zero false negatives', () => {
  const r = runBacktest(corpus);
  assert.equal(r.overall.falsePositives, 0, `false positives: ${JSON.stringify(r.mismatches.filter((m) => m.classification === 'false-positive').map((m) => m.case.name))}`);
  assert.equal(r.overall.falseNegatives, 0, `false negatives: ${JSON.stringify(r.mismatches.filter((m) => m.classification === 'false-negative').map((m) => m.case.name))}`);
  assert.equal(r.overall.precision, 1);
  assert.equal(r.overall.recall, 1);
});

test('gold-set backtest: every result matches its human label', () => {
  const r = runBacktest(corpus);
  assert.deepEqual(
    r.mismatches.map((m) => ({ name: m.case.name, expected: m.case.expected, actual: m.actual, delta: m.delta })),
    [],
  );
});

test('gold-set backtest: every expected delta appears', () => {
  const r = runBacktest(corpus);
  assert.deepEqual(
    r.deltaMisses.map((m) => ({ name: m.case.name, expectDelta: String(m.case.expectDelta), got: m.delta })),
    [],
  );
});

test('gold-set backtest: overall passed flag is true', () => {
  assert.equal(runBacktest(corpus).passed, true);
});

test('coverage: all four failure modes are represented, per app', () => {
  const modes: FailureMode[] = ['clean', 'false-positive', 'false-negative', 'hallucination'];
  for (const app of ['scp', 'apiflc']) {
    const present = new Set(corpus.filter((c) => c.app === app).map((c) => c.mode));
    for (const m of modes) assert.ok(present.has(m), `${app} is missing a '${m}' case`);
  }
});

test('per-app precision/recall are perfect on the gold set', () => {
  const r = runBacktest(corpus);
  for (const app of ['scp', 'apiflc']) {
    assert.ok(r.byApp[app], `no metrics for ${app}`);
    assert.equal(r.byApp[app]!.precision, 1, `${app} precision`);
    assert.equal(r.byApp[app]!.recall, 1, `${app} recall`);
  }
});

test('harness discriminates: a deliberately flipped label is caught as a mismatch', () => {
  // Guards against a harness that trivially passes everything.
  const broken = corpus.map((c) => (c.name.startsWith('apiflc: clean HTTP 200') ? { ...c, expected: 'failure' as const } : c));
  const r = runBacktest(broken);
  assert.equal(r.passed, false);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.overall.falseNegatives, 1); // labelled a problem, engine (correctly) passed it
});
