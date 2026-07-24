import type { CaseResult, Metrics } from './types.js';

/**
 * Confusion-matrix metrics for a set of case results. The positive class is "the
 * engine surfaced a problem" (result failure | completed_with_issues), so:
 *   false positive → the engine flagged a clean-labelled transaction;
 *   false negative → the engine passed a problem-labelled transaction.
 * precision/recall/f1 are the standard formulas, defined to 1 (precision/recall) or
 * 0 (f1) on empty denominators so an all-clean subset scores perfectly rather than NaN.
 */
export function metricsOf(results: CaseResult[]): Metrics {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (const r of results) {
    if (r.classification === 'true-positive') tp += 1;
    else if (r.classification === 'true-negative') tn += 1;
    else if (r.classification === 'false-positive') fp += 1;
    else fn += 1;
  }
  const total = results.length;
  const correct = tp + tn;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const accuracy = total === 0 ? 1 : correct / total;
  return {
    total,
    correct,
    truePositives: tp,
    trueNegatives: tn,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    f1,
    accuracy,
  };
}

/** Group results by a key, then compute metrics per group. */
export function metricsByGroup<K extends string>(results: CaseResult[], keyOf: (r: CaseResult) => K): Record<K, Metrics> {
  const groups = {} as Record<K, CaseResult[]>;
  for (const r of results) (groups[keyOf(r)] ??= []).push(r);
  const out = {} as Record<K, Metrics>;
  for (const k of Object.keys(groups) as K[]) out[k] = metricsOf(groups[k]);
  return out;
}
