import type { DerivedOutcome, QualityFinding, ValidationResult } from '@log/shared';
import { validateAgent, type AppValidationContext } from './validationLifecycle.js';

/**
 * A gold-set backtest for the deterministic validation engine. `validateAgent` is
 * pure, so a hand-labelled set of transactions — each with the outcome a human
 * confirmed is correct — can be replayed through it in CI to MEASURE the residual
 * false-positive / false-negative rate rather than assuming it is zero. A drop in
 * precision/recall (an engine change that starts mis-validating a labelled case)
 * fails the build. This is what turns "no false positives/negatives" from a claim
 * into a bounded, monitored number.
 *
 * The positive class is "a problem was surfaced" — result `failure` (a lifecycle /
 * status-vs-reality discrepancy) or `completed_with_issues` (a real quality issue).
 * `success` and `pending` are the clean/negative class.
 *   false positive → the engine surfaced a problem the gold label says is clean;
 *   false negative → the engine passed a transaction the gold label says is a problem.
 */
export interface GoldCase {
  name: string;
  app: string;
  agent: Parameters<typeof validateAgent>[0];
  /** The severity of the `tx:` lifecycle finding that actually exists, if any. */
  findingSeverity?: string;
  now: number;
  ctx: AppValidationContext;
  qualityFindings?: QualityFinding[];
  /** The outcome re-derived from raw logs (the status-vs-reality input). */
  derived?: DerivedOutcome;
  /** The human-confirmed correct validation result for this transaction. */
  expected: ValidationResult;
}

export interface AppBacktestMetrics {
  total: number;
  correct: number;
  falsePositives: number;
  falseNegatives: number;
  /** TP / (TP + FP); 1 when the engine surfaced nothing. */
  precision: number;
  /** TP / (TP + FN); 1 when the gold set has no problems. */
  recall: number;
}

export interface BacktestMetrics extends AppBacktestMetrics {
  byApp: Record<string, AppBacktestMetrics>;
  /** Every case where the engine's result differed from the gold label. */
  mismatches: Array<{ name: string; app: string; expected: ValidationResult; actual: ValidationResult }>;
}

const isProblem = (r: ValidationResult): boolean => r === 'failure' || r === 'completed_with_issues';

interface Tally {
  total: number;
  correct: number;
  tp: number;
  fp: number;
  fn: number;
}
const emptyTally = (): Tally => ({ total: 0, correct: 0, tp: 0, fp: 0, fn: 0 });

function finalize(t: Tally): AppBacktestMetrics {
  return {
    total: t.total,
    correct: t.correct,
    falsePositives: t.fp,
    falseNegatives: t.fn,
    precision: t.tp + t.fp === 0 ? 1 : t.tp / (t.tp + t.fp),
    recall: t.tp + t.fn === 0 ? 1 : t.tp / (t.tp + t.fn),
  };
}

/** Replay every gold case through the engine and score it against the human label. */
export function runBacktest(cases: GoldCase[]): BacktestMetrics {
  const overall = emptyTally();
  const byAppTally: Record<string, Tally> = {};
  const mismatches: BacktestMetrics['mismatches'] = [];

  for (const c of cases) {
    const v = validateAgent(c.agent, c.findingSeverity, c.now, c.ctx, c.qualityFindings ?? [], c.derived);
    const actual = v.result;
    const t = (byAppTally[c.app] ??= emptyTally());
    for (const acc of [overall, t]) {
      acc.total += 1;
      if (actual === c.expected) acc.correct += 1;
      const actualPos = isProblem(actual);
      const expectedPos = isProblem(c.expected);
      if (actualPos && expectedPos) acc.tp += 1;
      else if (actualPos && !expectedPos) acc.fp += 1;
      else if (!actualPos && expectedPos) acc.fn += 1;
    }
    if (actual !== c.expected) mismatches.push({ name: c.name, app: c.app, expected: c.expected, actual });
  }

  const byApp: Record<string, AppBacktestMetrics> = {};
  for (const [app, t] of Object.entries(byAppTally)) byApp[app] = finalize(t);
  return { ...finalize(overall), byApp, mismatches };
}
