import type { FailureMode, GoldCase, ValidationResult } from '@log/shared';

// GoldCase + FailureMode are the GENERIC contract and live in @log/shared, so each
// application package can author its own cases without depending on the backtest
// runner. Re-export them here for ergonomic single-import use by the runner.
export type { FailureMode, GoldCase } from '@log/shared';

/** The outcome of replaying one gold case through the real validation engine. */
export interface CaseResult {
  case: GoldCase;
  actual: ValidationResult;
  delta: string[];
  /** predicted positive = the engine surfaced a problem (failure | completed_with_issues). */
  predictedProblem: boolean;
  /** expected positive = the gold label says a problem should be surfaced. */
  expectedProblem: boolean;
  classification: 'true-positive' | 'true-negative' | 'false-positive' | 'false-negative';
  /** Did the result match the label exactly? */
  resultMatched: boolean;
  /** Did the expected delta match (null when the case declares none)? */
  deltaMatched: boolean | null;
}

export interface Metrics {
  total: number;
  correct: number;
  truePositives: number;
  trueNegatives: number;
  falsePositives: number;
  falseNegatives: number;
  /** TP / (TP + FP); 1 when the engine surfaced nothing. */
  precision: number;
  /** TP / (TP + FN); 1 when the gold set has no problems. */
  recall: number;
  /** Harmonic mean of precision and recall. */
  f1: number;
  /** (TP + TN) / total. */
  accuracy: number;
}

export interface BacktestReport {
  overall: Metrics;
  byApp: Record<string, Metrics>;
  byMode: Record<FailureMode, Metrics>;
  results: CaseResult[];
  /** Cases where the engine's result differed from the gold label. */
  mismatches: CaseResult[];
  /** Cases whose expected delta did not appear. */
  deltaMisses: CaseResult[];
  /** True when there are zero FPs, zero FNs, and every expected delta matched. */
  passed: boolean;
}
