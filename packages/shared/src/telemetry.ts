/**
 * Platform telemetry — the JSON-safe contract shared by the API and the web UI, so the
 * dashboard needs no dependency on the db or engine packages (same arrangement as
 * `BacktestSummary`).
 *
 * Every field is an aggregate over REAL rows. There is no placeholder path: a metric with
 * no underlying data reports 0, or `undefined` where zero would be a lie — an average with
 * no samples and a rate with no observations are *unmeasured*, not zero, and the UI must
 * be able to tell the difference.
 */

/** `{ bucket: count }` — e.g. severity → n, source → n. */
export type TelemetryBuckets = Record<string, number>;

export interface PlatformTelemetry {
  /** When these numbers were computed (epoch ms). */
  generatedAt: number;
  /** The lookback used by the "in window" figures. */
  windowMs: number;

  logs: {
    total: number;
    /** Timestamp of the oldest / newest stored log — the retention span actually held. */
    oldestTs?: number;
    newestTs?: number;
    /** When ingestion last wrote anything. Staleness here means the poller is not landing data. */
    lastIngestAt?: number;
    bySource: TelemetryBuckets;
    byLevel: TelemetryBuckets;
  };

  anomalies: {
    total: number;
    inWindow: number;
    bySeverity: TelemetryBuckets;
    byApplication: TelemetryBuckets;
  };

  transactions: {
    active: number;
    closed: number;
    total: number;
    byApplication: Record<
      string,
      {
        completed: number;
        failed: number;
        error: number;
        /** Any status outside the three terminal ones. */
        other: number;
        total: number;
        /** Lifetime percentiles over CLOSED transactions (an active one has no duration). */
        p50Ms?: number;
        p95Ms?: number;
        maxMs?: number;
      }
    >;
  };

  validation: {
    total: number;
    /** success | failure | completed_with_issues | ai_suspected | pending */
    byResult: TelemetryBuckets;
    slaBreached: number;
    /** Transactions carrying at least one deterministic delta. */
    withDelta: number;
    avgResponseLatencyMs?: number;
  };

  /**
   * The AI stage's scorecard, kept separate from `validation` because the two are
   * different populations — proven verdicts versus suspicions.
   */
  validationAi: {
    reviewed: number;
    suspected: number;
    admittedClaims: number;
    /**
     * Claims the admission gate threw out. This is the model's OBSERVED hallucination
     * rate: each one would have been a false positive had the claim been trusted.
     */
    discardedClaims: number;
    failedReviews: number;
    /** discarded / (discarded + admitted). Undefined when no claim has ever been made. */
    discardRate?: number;
    runs: number;
    running: number;
    queued: number;
    avgRunMs?: number;
    /** Deterministic checks the agents proposed, by rule id, ranked by recurrence. */
    ruleCandidates: TelemetryBuckets;
  };

  poller: {
    runs: number;
    inWindow: number;
    lastRunAt?: number;
    avgDurationMs?: number;
    p95DurationMs?: number;
    anomaliesProduced: number;
    byTrigger: TelemetryBuckets;
  };
}
