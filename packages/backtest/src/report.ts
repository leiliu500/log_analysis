import type { BacktestSummary } from '@log/shared';
import type { BacktestReport, CaseResult, Metrics } from './types.js';

/**
 * Trim the rich in-memory report to the JSON-safe {@link BacktestSummary} the API
 * returns and the /backtest UI renders — dropping the RegExp matchers and the full
 * ParsedLog fixtures each case carries (which are large and not serializable).
 */
export function toSummary(r: BacktestReport, ranAt: number): BacktestSummary {
  return {
    passed: r.passed,
    ranAt,
    overall: r.overall,
    byApp: r.byApp,
    byMode: r.byMode,
    cases: r.results.map((c) => ({
      name: c.case.name,
      app: c.case.app,
      mode: c.case.mode,
      expected: c.case.expected,
      actual: c.actual,
      classification: c.classification,
      resultMatched: c.resultMatched,
      deltaMatched: c.deltaMatched,
      delta: c.delta,
      expectDelta: c.case.expectDelta ? String(c.case.expectDelta) : undefined,
    })),
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`.padStart(6);
const pad = (s: string, n: number): string => s.padEnd(n);

function metricRow(label: string, m: Metrics): string {
  return [
    pad(label, 16),
    String(m.total).padStart(5),
    String(m.correct).padStart(5),
    String(m.falsePositives).padStart(4),
    String(m.falseNegatives).padStart(4),
    pct(m.precision),
    pct(m.recall),
    pct(m.f1),
  ].join('  ');
}

const HEADER = [pad('', 16), '  n', 'okay', '  FP', '  FN', '  prec', 'recall', '    f1'].join('  ');

/** A human-readable backtest report — overall, per-app, per-mode, plus any misses. */
export function formatReport(r: BacktestReport): string {
  const lines: string[] = [];
  lines.push('═'.repeat(72));
  lines.push('  VALIDATION BACKTEST — hallucination / false-positive / false-negative');
  lines.push('═'.repeat(72));
  lines.push('');
  lines.push(HEADER);
  lines.push('─'.repeat(72));
  lines.push(metricRow('OVERALL', r.overall));
  lines.push('');
  lines.push('  by application');
  for (const [app, m] of Object.entries(r.byApp).sort()) lines.push(metricRow(`  ${app}`, m));
  lines.push('');
  lines.push('  by failure mode');
  for (const [mode, m] of Object.entries(r.byMode).sort()) lines.push(metricRow(`  ${mode}`, m));
  lines.push('');

  const detail = (label: string, rows: CaseResult[], fmt: (c: CaseResult) => string): void => {
    if (!rows.length) return;
    lines.push(`  ${label} (${rows.length}):`);
    for (const c of rows) lines.push(`    ✗ ${fmt(c)}`);
    lines.push('');
  };
  detail('RESULT MISMATCHES', r.mismatches, (c) => `${c.case.name}\n        expected ${c.case.expected}, got ${c.actual}  [delta: ${c.delta.join('; ') || '—'}]`);
  detail('EXPECTED-DELTA MISSES', r.deltaMisses, (c) => `${c.case.name}\n        expected delta ${String(c.case.expectDelta)}, got [${c.delta.join('; ') || '—'}]`);

  lines.push('─'.repeat(72));
  lines.push(
    r.passed
      ? `  ✅ PASS — ${r.overall.total} cases, 0 false positives, 0 false negatives, all deltas matched.`
      : `  ❌ FAIL — ${r.overall.falsePositives} FP, ${r.overall.falseNegatives} FN, ${r.mismatches.length} result mismatch(es), ${r.deltaMisses.length} delta miss(es).`,
  );
  lines.push('═'.repeat(72));
  return lines.join('\n');
}

/** A compact machine-readable summary (for CI artifacts / JSON output). */
export function reportToJson(r: BacktestReport): string {
  return JSON.stringify(
    {
      passed: r.passed,
      overall: r.overall,
      byApp: r.byApp,
      byMode: r.byMode,
      mismatches: r.mismatches.map((c) => ({ name: c.case.name, expected: c.case.expected, actual: c.actual, delta: c.delta })),
      deltaMisses: r.deltaMisses.map((c) => ({ name: c.case.name, expectDelta: String(c.case.expectDelta), delta: c.delta })),
    },
    null,
    2,
  );
}
