import type { FailureMode, GoldCase } from '@log/shared';
import { runCase } from './engine.js';
import { metricsByGroup, metricsOf } from './metrics.js';
import type { BacktestReport, CaseResult } from './types.js';

/**
 * Replay a gold-set corpus through the real validation engine and score it. Returns a
 * full {@link BacktestReport}: overall + per-application + per-failure-mode metrics,
 * the mismatches, any expected-delta misses, and a single `passed` flag (zero FP,
 * zero FN, every expected delta present). This is the measurement that turns "no
 * false positives / negatives" from a claim into a bounded, monitored number.
 */
export function runBacktest(cases: GoldCase[]): BacktestReport {
  const results: CaseResult[] = cases.map(runCase);

  // Known-gap cases document MISSING rules — they're expected to "mismatch" and must
  // NOT count as regressions. The gate (metrics, mismatches, passed) is computed over
  // the normal must-pass cases only; gaps are reported separately.
  const normal = results.filter((r) => !r.case.knownGap);

  const mismatches = normal.filter((r) => !r.resultMatched);
  const deltaMisses = normal.filter((r) => r.deltaMatched === false);

  const overall = metricsOf(normal);
  const byApp = metricsByGroup(normal, (r) => r.case.app);
  const byMode = metricsByGroup(normal, (r) => r.case.mode) as Record<FailureMode, ReturnType<typeof metricsOf>>;

  const passed = overall.falsePositives === 0 && overall.falseNegatives === 0 && deltaMisses.length === 0 && mismatches.length === 0;

  return { overall, byApp, byMode, results, mismatches, deltaMisses, passed };
}
