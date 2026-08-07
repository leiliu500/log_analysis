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

  /** Model-call cost and latency, per stage. Absent when nothing has been recorded. */
  models?: ModelCallTelemetry;

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

/**
 * Model-call telemetry — what it COST to reach the decisions above: which model answered,
 * how long it took, how many tokens it burned, and whether it failed.
 *
 * `latencyMs` figures are the PROVIDER's own measurement (Bedrock `metrics.latencyMs`);
 * `avgWallMs` is our clock around the same call. Both are kept because the gap between
 * them is our own overhead, and averaging them together would hide it.
 */
export interface ModelCallTelemetry {
  total: number;
  failed: number;
  /** failed / total. Undefined with no calls — an unobserved rate is not zero. */
  errorRate?: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs?: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  maxLatencyMs?: number;
  avgWallMs?: number;
  /** Per pipeline stage, so a regression is attributable instead of averaged away. */
  byStage: Array<{
    stage: string;
    calls: number;
    failed: number;
    p50LatencyMs?: number;
    p95LatencyMs?: number;
    inputTokens: number;
    outputTokens: number;
    /**
     * Mean reply length. A stage whose replies cluster at the ceiling is the truncation
     * signature that produced unparseable validation JSON in production.
     */
    avgReplyChars?: number;
  }>;
  byModel: TelemetryBuckets;
  /** `max_tokens` here means replies are being cut off, not that the model finished. */
  byStopReason: TelemetryBuckets;
  recentErrors: Array<{ stage: string; error: string; ts: number }>;
  /**
   * Bedrock Guardrail activity. All zeros when no guardrail is provisioned — which is
   * indistinguishable from a provisioned guardrail that never fires, and deliberately so:
   * the dashboard should show "nothing was blocked", and whether a guardrail EXISTS is a
   * deployment fact, not a metric.
   */
  guardrail: {
    /** Calls the guardrail STOPPED. Every one is a request that got no answer. */
    blocked: number;
    /** Calls that returned, with a policy having redacted part of the reply. */
    masked: number;
    /** `content:PROMPT_ATTACK`, `pii:AWS_SECRET_KEY`, … — what to tune. */
    byPolicy: TelemetryBuckets;
  };
}
