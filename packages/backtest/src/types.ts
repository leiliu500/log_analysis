import type { FailureMode, GoldCase, Metrics, ValidationResult } from '@log/shared';

// The generic contract — GoldCase, FailureMode, Metrics, and the JSON-safe
// BacktestSummary/CaseSummary — lives in @log/shared so app packages and the web UI
// can use it without depending on this runner. Re-export for ergonomic single-import.
export type { BacktestSummary, CaseSummary, FailureMode, GoldCase, Metrics } from '@log/shared';

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
